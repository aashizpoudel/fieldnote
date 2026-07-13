import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  imagePlugin,
  tablePlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  InsertTable,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { invoke } from "@tauri-apps/api/core";
import {
  ingestDocument,
  listKnowledgeTree,
  readKnowledgeFile,
  writeKnowledgeFile,
  deleteKnowledgeEntry,
} from "./api";
import { MarkdownAnchor, onMarkdownLinkClickCapture } from "./markdownLinks";
import type { KnowledgeNode, ProgressPayload, Settings } from "./types";

function MarkdownImage({
  src,
  alt,
  documentPath,
}: {
  src?: string;
  alt?: string;
  documentPath: string;
}) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!src) return;
      if (/^(data:|https?:|asset:|blob:)/i.test(src)) {
        if (!cancelled) setUrl(src);
        return;
      }
      const dir = documentPath.replace(/[/\\][^/\\]+$/, "");
      const cleaned = src.replace(/^\.\//, "");
      const absolute = `${dir}/${cleaned}`.replace(/\\/g, "/");
      try {
        const dataUrl = await invoke<string>("read_asset_data_url", { path: absolute });
        if (!cancelled) setUrl(dataUrl);
      } catch {
        try {
          const fallback = convertFileSrc(absolute);
          if (!cancelled) setUrl(fallback);
        } catch {
          if (!cancelled) setUrl("");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [src, documentPath]);

  if (!url) {
    return <span className="kb-image-missing">{alt || "Image unavailable"}</span>;
  }
  return <img src={url} alt={alt ?? ""} loading="lazy" />;
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onDelete,
  busy,
}: {
  node: KnowledgeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (node: KnowledgeNode) => void;
  busy: boolean;
}) {
  const [openFolder, setOpenFolder] = useState(depth < 1);
  const isFolder = node.kind === "folder";
  const active = selectedPath === node.path;

  return (
    <div className="tree-node">
      <div className={`tree-item ${active ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 12 }}>
        <button
          className="tree-row"
          onClick={() => {
            if (isFolder) setOpenFolder((value) => !value);
            else onSelect(node.path);
          }}
        >
          {isFolder ? (
            openFolder ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span className="tree-spacer" />
          )}
          {isFolder ? (openFolder ? <FolderOpen size={14} /> : <Folder size={14} />) : <FileText size={14} />}
          <span>{node.name}</span>
        </button>
        <button
          type="button"
          className="tree-delete"
          title={isFolder ? "Delete folder" : "Delete file"}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(node);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {isFolder && openFolder && node.children?.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onDelete={onDelete}
          busy={busy}
        />
      ))}
    </div>
  );
}

function splitFrontMatter(raw: string): { frontMatter: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!match) return { frontMatter: "", body: normalized };
  return { frontMatter: match[1], body: match[2] };
}

function joinFrontMatter(frontMatter: string, body: string): string {
  const trimmedBody = body.replace(/^\n+/, "");
  if (!frontMatter.trim()) return trimmedBody;
  return `---\n${frontMatter.trim()}\n---\n\n${trimmedBody}`;
}

/** Soften raw HTML that breaks MDX while editing; view mode can keep richer markdown. */
function softenHtmlForEditor(markdown: string): string {
  return markdown
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

function rewriteMarkdownImages(markdown: string, absoluteFilePath: string): { markdown: string; reverse: Record<string, string> } {
  const dir = absoluteFilePath.replace(/[/\\][^/\\]+$/, "");
  const reverse: Record<string, string> = {};
  const next = markdown.replace(/!\[([^\]]*)\]\((\.\/[^)]+|assets\/[^)]+)\)/g, (_match, alt, rel) => {
    const original = String(rel);
    const cleaned = original.replace(/^\.\//, "");
    const absolute = `${dir}/${cleaned}`.replace(/\\/g, "/");
    try {
      const assetUrl = convertFileSrc(absolute);
      reverse[assetUrl] = original;
      return `![${alt}](${assetUrl})`;
    } catch {
      return `![${alt}](${original})`;
    }
  });
  return { markdown: next, reverse };
}

function restoreMarkdownImages(markdown: string, reverse: Record<string, string>): string {
  let result = markdown;
  for (const [assetUrl, original] of Object.entries(reverse)) {
    result = result.split(assetUrl).join(original);
  }
  return result;
}

function fileLabel(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  return name.replace(/\.md$/i, "").replace(/-/g, " ");
}

export default function KnowledgeBasePage({
  settings,
  openSettings,
}: {
  settings: Settings;
  openSettings: () => void;
}) {
  const [tree, setTree] = useState<KnowledgeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [absolutePath, setAbsolutePath] = useState("");
  const [frontMatter, setFrontMatter] = useState("");
  const [viewMarkdown, setViewMarkdown] = useState("");
  const [draft, setDraft] = useState("");
  const [baselineDraft, setBaselineDraft] = useState("");
  const [imageMap, setImageMap] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [showIngestOverlay, setShowIngestOverlay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [pagesDone, setPagesDone] = useState(0);
  const [pageTotal, setPageTotal] = useState(0);
  const [showProgressLog, setShowProgressLog] = useState(() => {
    try {
      return localStorage.getItem("fieldnote-show-progress-log") === "1";
    } catch {
      return false;
    }
  });
  const editorKey = useMemo(() => `${selectedPath ?? "empty"}-${mode}`, [selectedPath, mode]);
  const latestProgress = progressLines.at(-1);
  const overlayLogRef = useRef<HTMLDivElement>(null);
  const pagePercent = pageTotal > 0 ? Math.min(100, Math.round((pagesDone / pageTotal) * 100)) : 0;
  const ingestSessionRef = useRef(0);

  // #region agent log
  const kbRenderCount = useRef(0);
  kbRenderCount.current += 1;
  useEffect(() => {
    const id = window.setInterval(() => {
      fetch("/__debug_log", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7f8a2c" },
        body: JSON.stringify({
          sessionId: "7f8a2c",
          hypothesisId: "H1",
          location: "KnowledgeBasePage.tsx:render-rate",
          message: "KB idle state",
          data: {
            renders: kbRenderCount.current,
            ingesting,
            showIngestOverlay,
            progressLines: progressLines.length,
            pagesDone,
            pageTotal,
            selectedPath,
            mode,
            busy,
            status: status.slice(0, 80),
            session: ingestSessionRef.current,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      kbRenderCount.current = 0;
    }, 2000);
    return () => window.clearInterval(id);
  }, [ingesting, showIngestOverlay, progressLines.length, pagesDone, pageTotal, selectedPath, mode, busy, status]);
  // #endregion

  function toggleProgressLog() {
    setShowProgressLog((current) => {
      const next = !current;
      try {
        localStorage.setItem("fieldnote-show-progress-log", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function showActivityLog() {
    setShowProgressLog(true);
    try {
      localStorage.setItem("fieldnote-show-progress-log", "1");
    } catch {
      /* ignore */
    }
  }

  function errorDetail(cause: unknown): string {
    if (cause instanceof Error && cause.message) return cause.message;
    if (typeof cause === "string" && cause.trim()) return cause;
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }

  function beginIngestUi() {
    ingestSessionRef.current += 1;
    setBusy(true);
    setIngesting(true);
    setShowIngestOverlay(true);
    setStatus("");
    setPagesDone(0);
    setPageTotal(0);
    setProgressLines(["Preparing your source…"]);
  }

  function markIngestActiveFromProgress() {
    setBusy(true);
    setIngesting(true);
    setShowIngestOverlay(true);
  }

  function endIngestUi(options?: { keepOverlay?: boolean }) {
    setIngesting(false);
    setBusy(false);
    if (!options?.keepOverlay) setShowIngestOverlay(false);
  }

  const refreshTree = useCallback(async () => {
    try {
      setTree(await listKnowledgeTree());
    } catch (cause) {
      setStatus(String(cause));
    }
  }, []);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<ProgressPayload | string>("ingestion-progress", (event) => {
      const payload = event.payload;
      const message = typeof payload === "string" ? payload : payload?.message;
      if (!message) return;
      const done = typeof payload === "object" && payload ? payload.pagesDone : undefined;
      const total = typeof payload === "object" && payload ? payload.pageTotal : undefined;
      // #region agent log
      fetch("/__debug_log", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7f8a2c" },
        body: JSON.stringify({
          sessionId: "7f8a2c",
          hypothesisId: "H3",
          location: "KnowledgeBasePage.tsx:ingestion-progress",
          message: "progress event",
          data: { message: String(message).slice(0, 120), done, total },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      markIngestActiveFromProgress();
      setProgressLines((current) => [...current.slice(-80), message]);
      if (typeof done === "number") setPagesDone(done);
      if (typeof total === "number") setPageTotal(total);
      // If the page remounted (e.g. Vite HMR) while Rust ingestion kept running,
      // the original chooseSource finally block is gone — close from the terminal event.
      if (/^Ingestion complete\b/i.test(message)) {
        if (typeof total === "number") setPagesDone(total);
        window.setTimeout(() => {
          endIngestUi();
          void refreshTree();
        }, 400);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!showIngestOverlay) return;
    const node = overlayLogRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [progressLines, showIngestOverlay]);

  async function openFile(relativePath: string) {
    if (mode === "edit" && dirty && !window.confirm("Discard your changes?")) return;
    setBusy(true);
    setStatus("");
    try {
      const file = await readKnowledgeFile(relativePath);
      const { frontMatter: meta, body } = splitFrontMatter(file.content);
      const forEdit = rewriteMarkdownImages(softenHtmlForEditor(body), file.path);
      setSelectedPath(file.relativePath);
      setAbsolutePath(file.path);
      setFrontMatter(meta);
      setViewMarkdown(body);
      setDraft(forEdit.markdown);
      setBaselineDraft(forEdit.markdown);
      setImageMap(forEdit.reverse);
      setMode("view");
      setDirty(false);
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(node: KnowledgeNode) {
    if (busy) return;
    const isFolder = node.kind === "folder";
    const confirmed = window.confirm(
      isFolder
        ? `Delete the folder “${node.name}” and everything inside it? This cannot be undone.`
        : `Delete “${node.name}”? This cannot be undone.`,
    );
    if (!confirmed) return;

    if (mode === "edit" && dirty && selectedPath && (selectedPath === node.path || selectedPath.startsWith(`${node.path}/`))) {
      if (!window.confirm("You have unsaved changes in this source. Delete anyway?")) return;
    }

    setBusy(true);
    setStatus("");
    try {
      await deleteKnowledgeEntry(node.path);
      if (selectedPath === node.path || (isFolder && selectedPath?.startsWith(`${node.path}/`))) {
        setSelectedPath(null);
        setAbsolutePath("");
        setFrontMatter("");
        setViewMarkdown("");
        setDraft("");
        setBaselineDraft("");
        setImageMap({});
        setMode("view");
        setDirty(false);
      }
      await refreshTree();
      setStatus(isFolder ? "Folder deleted." : "File deleted.");
    } catch (cause) {
      setStatus("Couldn't delete that item. Try again.");
      console.error(cause);
    } finally {
      setBusy(false);
    }
  }

  function composeFile(bodyMarkdown: string): string {
    return joinFrontMatter(frontMatter, restoreMarkdownImages(bodyMarkdown, imageMap));
  }

  function startEditing() {
    setMode("edit");
  }

  function cancelEditing() {
    if (dirty && !window.confirm("Discard your changes?")) return;
    setDraft(baselineDraft);
    setDirty(false);
    setMode("view");
  }

  async function saveFile() {
    if (!selectedPath) return;
    setSaving(true);
    setStatus("");
    try {
      const raw = composeFile(draft);
      await writeKnowledgeFile(selectedPath, raw);
      const { body } = splitFrontMatter(raw);
      setViewMarkdown(body);
      setBaselineDraft(draft);
      setDirty(false);
      setMode("view");
      setStatus("Saved");
    } catch (cause) {
      setStatus("Couldn't save this file. Try again.");
      console.error(cause);
    } finally {
      setSaving(false);
    }
  }

  async function chooseSource() {
    if (!settings.llmApiUrl || !settings.llmApiKey || !settings.llmModel) {
      openSettings();
      return;
    }
    const path = await open({
      multiple: false,
      filters: [
        { name: "Sources", extensions: ["pdf", "md", "txt"] },
      ],
    });
    if (!path) return;
    beginIngestUi();
    const session = ingestSessionRef.current;
    try {
      const result = await ingestDocument(path, settings);
      if (session !== ingestSessionRef.current) return;
      setProgressLines((current) => [...current.slice(-80), `Finished · ${result.fileCount} notes · ${result.imageCount} images`]);
      setStatus(`Added “${result.sourceFile}” to your sources.`);
      endIngestUi();
      await refreshTree();
    } catch (cause) {
      if (session !== ingestSessionRef.current) return;
      const detail = errorDetail(cause);
      setStatus("Couldn't add that source. Check Settings and try again.");
      setProgressLines((current) => [...current.slice(-80), `Error: ${detail}`]);
      showActivityLog();
      endIngestUi({ keepOverlay: true });
      console.error(cause);
    }
  }

  return (
    <main className="knowledge-layout kb-browser">
      <header className="page-header">
        <div>
          <span className="eyebrow">Sources</span>
          <h1>Your field guides</h1>
        </div>
        <button className="button primary" onClick={chooseSource} disabled={busy}>
          <Plus size={16} />Add source
        </button>
      </header>

      <div className="kb-columns">
        <aside className="kb-sidebar">
          <div className="kb-sidebar-title">Collections</div>
          {!tree.length && (
            <div className="kb-empty-tree">
              <Upload size={18} />
              <p>No sources yet. Add a PDF, guide, or notes file to get started.</p>
            </div>
          )}
          <div className="kb-tree">
            {tree.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                onSelect={openFile}
                onDelete={deleteEntry}
                busy={busy}
              />
            ))}
          </div>
        </aside>

        <section className="kb-editor-pane">
          {!selectedPath ? (
            <div className="kb-placeholder">
              <div className="drop-icon"><FileText size={26} /></div>
              <h2>Open a source</h2>
              <p>Pick a note on the left to read. Edit when you need to correct or clarify it.</p>
              <button className="button secondary" onClick={chooseSource} disabled={busy}>
                <FileText size={16} />Add source
              </button>
            </div>
          ) : (
            <>
              <div className="kb-editor-bar">
                <div className="kb-doc-meta">
                  <span className="eyebrow">{mode === "edit" ? "Editing" : "Preview"}</span>
                  <h3>{fileLabel(selectedPath)}</h3>
                </div>
                <div className="kb-doc-actions">
                  {mode === "view" ? (
                    <button className="button secondary" onClick={startEditing}>
                      <Pencil size={15} />Edit
                    </button>
                  ) : (
                    <>
                      <button className="button secondary" onClick={cancelEditing} disabled={saving}>
                        <X size={15} />Cancel
                      </button>
                      <button className="button primary" onClick={saveFile} disabled={!dirty || saving}>
                        {saving ? <LoaderCircle className="spin" size={15} /> : null}
                        Done
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div
                className={`kb-editor-surface ${mode === "view" ? "is-view" : "is-edit"}`}
                onClickCapture={onMarkdownLinkClickCapture}
              >
                {mode === "view" ? (
                  <article className="kb-markdown-view">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: MarkdownAnchor,
                        img: ({ src, alt }) => (
                          <MarkdownImage src={src} alt={alt} documentPath={absolutePath} />
                        ),
                      }}
                    >
                      {viewMarkdown}
                    </ReactMarkdown>
                  </article>
                ) : (
                  <MDXEditor
                    key={editorKey}
                    markdown={draft}
                    onChange={(value) => {
                      setDraft(value);
                      setDirty(value !== baselineDraft);
                    }}
                    plugins={[
                      headingsPlugin(),
                      listsPlugin(),
                      quotePlugin(),
                      thematicBreakPlugin(),
                      markdownShortcutPlugin(),
                      linkPlugin(),
                      imagePlugin(),
                      tablePlugin(),
                      toolbarPlugin({
                        toolbarContents: () => (
                          <>
                            <UndoRedo />
                            <BoldItalicUnderlineToggles />
                            <BlockTypeSelect />
                            <ListsToggle />
                            <CreateLink />
                            <InsertTable />
                          </>
                        ),
                      }),
                    ]}
                  />
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {(ingesting || progressLines.length > 0 || status) && !showIngestOverlay && (
        <div className="ingest-progress">
          <div className="ingest-progress-bar">
            <div className="ingest-progress-summary">
              {ingesting && <LoaderCircle className="spin" size={15} />}
              <span className={status && !ingesting && !(status.startsWith("Added") || status === "Saved") ? "err" : status && !ingesting ? "ok" : undefined}>
                {ingesting
                  ? latestProgress
                    ? `Processing · ${latestProgress}`
                    : "Processing…"
                  : status.startsWith("Added")
                    ? "Source added."
                    : status || "Ready."}
              </span>
            </div>
            <button
              type="button"
              className="ingest-progress-toggle"
              onClick={toggleProgressLog}
              aria-expanded={showProgressLog}
              title={showProgressLog ? "Hide activity" : "Show activity"}
            >
              Show Activity
              {showProgressLog ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
          {showProgressLog && (
            <div className="ingest-progress-log">
              {progressLines.map((line, index) => (
                <div key={`${index}-${line}`} className={line.startsWith("Error:") ? "err" : undefined}>
                  {line}
                </div>
              ))}
              {status && (
                <div className={status.startsWith("Added") || status === "Saved" ? "ok" : "err"}>
                  {status}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showIngestOverlay && (
        <div className="ingest-overlay" role="dialog" aria-modal="true" aria-label="Source ingestion progress">
          <div className="ingest-overlay-card">
            <div className="ingest-overlay-header">
              <div className="ingest-overlay-title">
                {ingesting ? <LoaderCircle className="spin" size={22} /> : null}
                <div>
                  <h2>{ingesting ? "Processing source" : "Ingestion stopped"}</h2>
                  <p>{latestProgress || (ingesting ? "Getting started…" : status || "Ready.")}</p>
                </div>
              </div>
              {!ingesting && (
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowIngestOverlay(false)}
                  title="Close"
                  aria-label="Close ingestion overlay"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            <div className="ingest-overlay-meter" aria-live="polite">
              <div className="ingest-overlay-meter-label">
                <span>Pages processed</span>
                <span>
                  {pageTotal > 0 ? `${pagesDone} / ${pageTotal}` : ingesting ? "Counting pages…" : "—"}
                </span>
              </div>
              <div
                className="ingest-overlay-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={pageTotal || 100}
                aria-valuenow={pagesDone}
              >
                <div
                  className={`ingest-overlay-fill${ingesting && pageTotal === 0 ? " indeterminate" : ""}`}
                  style={pageTotal > 0 ? { width: `${pagePercent}%` } : undefined}
                />
              </div>
            </div>

            <div className="ingest-overlay-log" ref={overlayLogRef}>
              {progressLines.map((line, index) => (
                <div key={`${index}-${line}`} className={line.startsWith("Error:") ? "err" : undefined}>
                  {line}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
