use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeNode {
    name: String,
    path: String,
    kind: String,
    children: Option<Vec<KnowledgeNode>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeFile {
    path: String,
    content: String,
    relative_path: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IngestResult {
    title: String,
    source_file: String,
    document_dir: String,
    file_count: usize,
    image_count: usize,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    id: String,
    title: String,
    source_file: String,
    relative_path: String,
    content: String,
    highlights: Vec<String>,
    score: Option<f64>,
}

#[derive(Deserialize, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ConnectionTest {
    ok: bool,
    message: String,
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn knowledge_base_root() -> PathBuf {
    let root = workspace_root().join("knowledge_base");
    if !root.exists() {
        let _ = fs::create_dir_all(&root);
    }
    root
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "document".into()
    } else {
        trimmed
    }
}

fn run_tool(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program).args(args).output().map_err(|error| {
        format!("Could not run {program}. Install Poppler and ensure {program} is on PATH: {error}")
    })?;
    if !output.status.success() {
        return Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn image_pages(path: &str) -> Result<HashSet<usize>, String> {
    let listing = run_tool("pdfimages", &["-list", path])?;
    let mut pages = HashSet::new();
    for line in listing.lines().skip(2) {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() > 2 && columns[2] == "image" {
            if let Ok(page) = columns[0].parse::<usize>() {
                pages.insert(page);
            }
        }
    }
    Ok(pages)
}

fn extract_images(path: &str, staging_dir: &Path) -> Result<Vec<Value>, String> {
    fs::create_dir_all(staging_dir).map_err(|error| format!("Could not create image staging dir: {error}"))?;
    let prefix = staging_dir.join("img");
    let _ = run_tool(
        "pdfimages",
        &[
            "-png",
            "-p",
            path,
            prefix.to_str().ok_or("Invalid staging path")?,
        ],
    )?;

    let pages_with_images = image_pages(path).unwrap_or_default();
    let mut images = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(staging_dir)
        .map_err(|error| format!("Could not read staging dir: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg"))
                .unwrap_or(false)
        })
        .collect();
    entries.sort();

    for (index, file_path) in entries.into_iter().enumerate() {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image.png")
            .to_string();
        // pdfimages -p embeds page number in filename like img-001-000.png
        let page_number = file_name
            .split('-')
            .nth(1)
            .and_then(|part| part.parse::<usize>().ok())
            .or_else(|| pages_with_images.iter().next().copied())
            .unwrap_or(1);
        let id = format!("img-{index}");
        let stable_name = format!("page-{page_number:03}-img-{index:03}.png");
        images.push(json!({
            "id": id,
            "pageNumber": page_number,
            "stagingPath": file_path.to_string_lossy(),
            "fileName": stable_name
        }));
    }
    Ok(images)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pages_done: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_total: Option<usize>,
}

fn emit_progress(app: &AppHandle, event: &str, message: &str) {
    emit_progress_full(app, event, message, None, None);
}

fn emit_progress_full(
    app: &AppHandle,
    event: &str,
    message: &str,
    pages_done: Option<usize>,
    page_total: Option<usize>,
) {
    let _ = app.emit(
        event,
        ProgressPayload {
            message: message.to_string(),
            pages_done,
            page_total,
        },
    );
}

fn run_pi_agent(app: Option<&AppHandle>, input: Value, progress_event: &str) -> Result<Value, String> {
    let runner = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../agent-dist/runner.js")
        .canonicalize()
        .map_err(|error| format!("Pi agent sidecar is not built: {error}"))?;
    let mut child = Command::new("node")
        .arg(runner)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the Pi TypeScript agent: {error}"))?;

    child
        .stdin
        .take()
        .ok_or_else(|| "Could not open Pi agent input".to_string())?
        .write_all(input.to_string().as_bytes())
        .map_err(|error| format!("Could not send input to Pi agent: {error}"))?;

    if let Some(stderr) = child.stderr.take() {
        let handle = app.cloned();
        let event_name = progress_event.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value.get("type").and_then(Value::as_str) == Some("progress") {
                        if let Some(message) = value.get("message").and_then(Value::as_str) {
                            let pages_done = value
                                .get("pagesDone")
                                .or_else(|| value.get("pages_done"))
                                .and_then(Value::as_u64)
                                .map(|n| n as usize);
                            let page_total = value
                                .get("pageTotal")
                                .or_else(|| value.get("page_total"))
                                .and_then(Value::as_u64)
                                .map(|n| n as usize);
                            if let Some(app) = handle.as_ref() {
                                emit_progress_full(
                                    app,
                                    &event_name,
                                    message,
                                    pages_done,
                                    page_total,
                                );
                            }
                            continue;
                        }
                    }
                }
                if !line.trim().is_empty() {
                    if let Some(app) = handle.as_ref() {
                        emit_progress(app, &event_name, &line);
                    }
                }
            }
        });
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not wait for Pi agent: {error}"))?;
    let raw = String::from_utf8_lossy(&output.stdout);
    let envelope: Value = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Pi agent returned invalid JSON: {error}. stderr: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    if !envelope.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Err(envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Pi agent failed")
            .to_string());
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| "Pi agent response did not contain a result".to_string())
}

async fn llm_request(
    api_url: &str,
    api_key: &str,
    model: &str,
    messages: Value,
) -> Result<String, String> {
    let result = run_pi_agent(
        None,
        json!({
            "operation": "complete",
            "config": {"apiUrl": api_url, "apiKey": api_key, "model": model},
            "messages": messages
        }),
        "agent-progress",
    )?;
    result
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Pi agent response did not include content".to_string())
}

fn list_dir_tree(dir: &Path, root: &Path) -> Result<Vec<KnowledgeNode>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|error| format!("Could not read {}: {error}", dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            !name.starts_with('.') && name != "source_files"
        })
        .collect();
    entries.sort_by_key(|path| {
        (
            !path.is_dir(),
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase(),
        )
    });

    let mut nodes = Vec::new();
    for path in entries {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("item")
            .to_string();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        if path.is_dir() {
            nodes.push(KnowledgeNode {
                name,
                path: relative,
                kind: "folder".into(),
                children: Some(list_dir_tree(&path, root)?),
            });
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            nodes.push(KnowledgeNode {
                name,
                path: relative,
                kind: "file".into(),
                children: None,
            });
        }
    }
    Ok(nodes)
}

fn resolve_knowledge_path(relative: &str) -> Result<PathBuf, String> {
    let root = knowledge_base_root()
        .canonicalize()
        .map_err(|error| format!("Knowledge base is unavailable: {error}"))?;
    let candidate = root.join(relative);
    let resolved = candidate
        .canonicalize()
        .or_else(|_| {
            if let Some(parent) = candidate.parent() {
                fs::create_dir_all(parent).ok();
            }
            Ok::<PathBuf, String>(candidate.clone())
        })
        .map_err(|error| format!("Invalid knowledge path: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err("Path escapes the knowledge base".into());
    }
    Ok(resolved)
}

fn walk_markdown_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current).map_err(|error| format!("Could not read {}: {error}", current.display()))? {
            let entry = entry.map_err(|error| format!("Could not read entry: {error}"))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
            {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn strip_front_matter(content: &str) -> &str {
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            return rest[end + 4..].trim_start();
        }
    }
    content
}

fn front_matter_title(content: &str, fallback: &str) -> String {
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(value) = line.strip_prefix("title:") {
                    let cleaned = value.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !cleaned.is_empty() {
                        return cleaned;
                    }
                }
            }
        }
    }
    fallback.to_string()
}

fn snippet_around(content: &str, query: &str) -> String {
    let lower = content.to_ascii_lowercase();
    let q = query.to_ascii_lowercase();
    if let Some(index) = lower.find(&q) {
        let start = index.saturating_sub(120);
        let end = (index + q.len() + 180).min(content.len());
        let mut snippet = content[start..end].replace('\n', " ");
        if start > 0 {
            snippet = format!("…{snippet}");
        }
        if end < content.len() {
            snippet = format!("{snippet}…");
        }
        return snippet;
    }
    content.chars().take(280).collect::<String>()
}

fn load_prompt(name: &str) -> Result<String, String> {
    let path = workspace_root().join("prompts").join(name);
    fs::read_to_string(&path)
        .map(|text| text.trim().to_string())
        .map_err(|error| format!("Could not read prompt {}: {error}", path.display()))
}

fn render_prompt(template: &str, values: &[(&str, &str)]) -> String {
    let mut rendered = template.to_string();
    for (key, value) in values {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
    }
    rendered
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn read_asset_data_url(path: String) -> Result<String, String> {
    let root = knowledge_base_root()
        .canonicalize()
        .map_err(|error| format!("Knowledge base is unavailable: {error}"))?;
    let resolved = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("Could not open asset: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err("Asset path escapes the knowledge base".into());
    }
    let bytes =
        fs::read(&resolved).map_err(|error| format!("Could not read asset: {error}"))?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
    Ok(format!(
        "data:{};base64,{}",
        mime_for_path(&resolved),
        encoded
    ))
}

#[tauri::command]
fn get_knowledge_base_root() -> Result<String, String> {
    Ok(knowledge_base_root().to_string_lossy().to_string())
}

#[tauri::command]
fn list_knowledge_tree() -> Result<Vec<KnowledgeNode>, String> {
    let root = knowledge_base_root();
    list_dir_tree(&root, &root)
}

#[tauri::command]
fn read_knowledge_file(relative_path: String) -> Result<KnowledgeFile, String> {
    let path = resolve_knowledge_path(&relative_path)?;
    let content =
        fs::read_to_string(&path).map_err(|error| format!("Could not read file: {error}"))?;
    Ok(KnowledgeFile {
        path: path.to_string_lossy().to_string(),
        relative_path,
        content,
    })
}

#[tauri::command]
fn write_knowledge_file(relative_path: String, content: String) -> Result<(), String> {
    let path = resolve_knowledge_path(&relative_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create folders: {error}"))?;
    }
    fs::write(&path, content).map_err(|error| format!("Could not write file: {error}"))
}

#[tauri::command]
fn delete_knowledge_entry(relative_path: String) -> Result<(), String> {
    let relative = relative_path.trim().trim_start_matches('/').trim_start_matches('\\');
    if relative.is_empty() || relative == "." || relative == ".." {
        return Err("Cannot delete the library root.".into());
    }
    if relative.starts_with('.') {
        return Err("Cannot delete protected library folders.".into());
    }

    let root = knowledge_base_root()
        .canonicalize()
        .map_err(|error| format!("Knowledge base is unavailable: {error}"))?;
    let candidate = root.join(relative);
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("Could not find that item: {error}"))?;
    if resolved == root || !resolved.starts_with(&root) {
        return Err("Path escapes the knowledge base".into());
    }

    if resolved.is_dir() {
        fs::remove_dir_all(&resolved).map_err(|error| format!("Could not delete folder: {error}"))?;
    } else {
        fs::remove_file(&resolved).map_err(|error| format!("Could not delete file: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn test_llm(
    api_url: String,
    api_key: String,
    model: String,
) -> Result<ConnectionTest, String> {
    if api_key.trim().is_empty() {
        return Err("An LLM API key is required.".into());
    }
    let reply = llm_request(
        &api_url,
        &api_key,
        &model,
        json!([{"role":"user","content":"Reply with exactly: connection ok"}]),
    )
    .await?;
    Ok(ConnectionTest {
        ok: true,
        message: format!("Connected with {model} · {}", reply.trim()),
    })
}

fn unique_destination(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let mut index = 2;
    loop {
        let next = dir.join(format!("{stem}-{index}{extension}"));
        if !next.exists() {
            return next;
        }
        index += 1;
    }
}

fn copy_source_file(source_path: &Path, original_name: &str) -> Result<PathBuf, String> {
    let source_dir = knowledge_base_root().join("source_files");
    fs::create_dir_all(&source_dir)
        .map_err(|error| format!("Could not create source_files folder: {error}"))?;
    let destination = unique_destination(&source_dir, original_name);
    fs::copy(source_path, &destination)
        .map_err(|error| format!("Could not copy source file: {error}"))?;
    Ok(destination)
}

#[tauri::command]
async fn ingest_document(
    app: AppHandle,
    path: String,
    api_url: String,
    api_key: String,
    model: String,
) -> Result<IngestResult, String> {
    if api_key.trim().is_empty() {
        return Err("An LLM API key is required for document ingestion.".into());
    }

    let file_path = Path::new(&path);
    let source_file = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document")
        .to_string();
    let title = file_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Document")
        .to_string();
    let extension = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    emit_progress(&app, "ingestion-progress", &format!("Extracting text from {source_file}"));

    let (pages, images) = if extension == "pdf" {
        let raw = run_tool("pdftotext", &["-layout", &path, "-"])?;
        let raw_pages: Vec<String> = raw
            .split('\u{000c}')
            .map(|page| page.trim_matches('\n').trim_end().to_string())
            .filter(|page| !page.is_empty())
            .collect();
        if raw_pages.is_empty() {
            return Err(
                "No text was extracted from the PDF. This prototype requires a text-based PDF."
                    .into(),
            );
        }
        let staging = knowledge_base_root().join(".staging").join(slugify(&title));
        emit_progress_full(
            &app,
            "ingestion-progress",
            &format!("Extracted {} pages · pulling images and graphs", raw_pages.len()),
            Some(0),
            Some(raw_pages.len()),
        );
        let images = extract_images(&path, &staging).unwrap_or_else(|_| Vec::new());
        let pages: Vec<Value> = raw_pages
            .into_iter()
            .enumerate()
            .map(|(offset, content)| {
                json!({
                    "pageNumber": offset + 1,
                    "content": content
                })
            })
            .collect();
        (pages, images)
    } else {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read source file: {error}"))?;
        (
            vec![json!({"pageNumber": 1, "content": content})],
            Vec::new(),
        )
    };

    let page_total = pages.len();
    emit_progress_full(
        &app,
        "ingestion-progress",
        &format!("Copying source file to knowledge_base/source_files"),
        Some(0),
        Some(page_total),
    );
    let document_dir = knowledge_base_root().join(slugify(&title));
    fs::create_dir_all(&document_dir)
        .map_err(|error| format!("Could not create knowledge folder: {error}"))?;

    let copied_source = copy_source_file(file_path, &source_file)?;
    let archived_source_name = copied_source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&source_file)
        .to_string();

    emit_progress_full(
        &app,
        "ingestion-progress",
        &format!(
            "Pi agent is writing markdown chunks into {}",
            document_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("document")
        ),
        Some(0),
        Some(page_total),
    );

    let result = run_pi_agent(
        Some(&app),
        json!({
            "operation": "ingest",
            "config": {"apiUrl": api_url, "apiKey": api_key, "model": model},
            "title": title,
            "sourceFile": archived_source_name,
            "documentDir": document_dir.to_string_lossy(),
            "pages": pages,
            "images": images
        }),
        "ingestion-progress",
    )?;

    serde_json::from_value(result).map_err(|error| format!("Invalid Pi ingestion result: {error}"))
}

#[tauri::command]
async fn search_knowledge(query: String) -> Result<Vec<SearchHit>, String> {
    let root = knowledge_base_root();
    if !root.exists() {
        return Ok(Vec::new());
    }
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut hits = Vec::new();
    for path in walk_markdown_files(&root)? {
        let content =
            fs::read_to_string(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let body = strip_front_matter(&content);
        if !body.to_ascii_lowercase().contains(&q) && !content.to_ascii_lowercase().contains(&q) {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let title = front_matter_title(&content, path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled"));
        let source_file = relative
            .split('/')
            .next()
            .unwrap_or(&relative)
            .to_string();
        let highlight = snippet_around(body, &query);
        let score = body.to_ascii_lowercase().matches(&q).count() as f64;
        hits.push(SearchHit {
            id: relative.clone(),
            title,
            source_file,
            relative_path: relative,
            content: body.to_string(),
            highlights: vec![highlight],
            score: Some(score),
        });
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(8);
    Ok(hits)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatSourceRef {
    relative_path: String,
    title: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatAgentResult {
    content: String,
    sources: Vec<ChatSourceRef>,
}

fn format_knowledge_tree(nodes: &[KnowledgeNode], indent: usize) -> String {
    let mut lines = Vec::new();
    for node in nodes {
        let prefix = "  ".repeat(indent);
        if node.kind == "folder" {
            lines.push(format!("{prefix}{}/", node.name));
            if let Some(children) = &node.children {
                let nested = format_knowledge_tree(children, indent + 1);
                if !nested.is_empty() {
                    lines.push(nested);
                }
            }
        } else {
            lines.push(format!("{prefix}{}", node.name));
        }
    }
    lines.join("
")
}

#[tauri::command]
async fn chat_with_knowledge(
    app: AppHandle,
    api_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<ChatAgentResult, String> {
    if api_key.trim().is_empty() {
        return Err("An LLM API key is required.".into());
    }
    let root = knowledge_base_root();
    let tree_nodes = if root.exists() {
        list_dir_tree(&root, &root).unwrap_or_default()
    } else {
        Vec::new()
    };
    let knowledge_tree = if tree_nodes.is_empty() {
        "(empty knowledge base)".to_string()
    } else {
        format_knowledge_tree(&tree_nodes, 0)
    };

    emit_progress(&app, "chat-progress", "Preparing knowledge-base chat agent");
    let result = run_pi_agent(
        Some(&app),
        json!({
            "operation": "chat",
            "config": {"apiUrl": api_url, "apiKey": api_key, "model": model},
            "knowledgeBaseRoot": root.to_string_lossy(),
            "knowledgeTree": knowledge_tree,
            "messages": messages
        }),
        "chat-progress",
    )?;
    serde_json::from_value(result).map_err(|error| format!("Invalid chat agent result: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_knowledge_base_root,
            list_knowledge_tree,
            read_knowledge_file,
            write_knowledge_file,
            delete_knowledge_entry,
            read_asset_data_url,
            test_llm,
            ingest_document,
            search_knowledge,
            chat_with_knowledge
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}
