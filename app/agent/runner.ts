import { mkdir, copyFile, writeFile, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type Config = { apiUrl: string; apiKey: string; model: string };

type RawPage = {
  pageNumber: number;
  content: string;
};

type ExtractedImage = {
  id: string;
  pageNumber: number;
  stagingPath: string;
  fileName: string;
};

type IngestInput = {
  operation: "ingest";
  config: Config;
  title: string;
  sourceFile: string;
  documentDir: string;
  pages: RawPage[];
  images: ExtractedImage[];
};

type CompleteInput = {
  operation: "complete";
  config: Config;
  messages: Array<{ role: string; content: string }>;
};

type ChatInput = {
  operation: "chat";
  config: Config;
  knowledgeBaseRoot: string;
  knowledgeTree: string;
  messages: Array<{ role: string; content: string }>;
};

type Input = IngestInput | CompleteInput | ChatInput;

type WrittenFile = {
  fileName: string;
  pageStart: number;
  pageEnd: number;
};

type ChatSource = {
  relativePath: string;
  title: string;
};

function promptsRoot(): string {
  // app/agent-dist/runner.js -> ../../prompts
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prompts");
}

async function loadPrompt(name: string): Promise<string> {
  const filePath = path.join(promptsRoot(), name);
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    throw new Error(`Could not read prompt file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderPrompt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined ? "" : String(value);
  });
}

function progress(message: string, extras?: { pagesDone?: number; pageTotal?: number }) {
  process.stderr.write(`${JSON.stringify({ type: "progress", message, ...extras })}\n`);
}

function providerBaseUrl(url: string): string {
  return url.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
}

function createAgent(config: Config, systemPrompt: string, tools: AgentTool[] = []) {
  const model: Model<"openai-completions"> = {
    provider: "weedgpt",
    baseUrl: providerBaseUrl(config.apiUrl),
    api: "openai-completions",
    id: config.model,
    name: config.model,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    },
  };
  return new Agent({
    initialState: { systemPrompt, model, thinkingLevel: "off", tools },
    getApiKey: () => config.apiKey,
    maxRetryDelayMs: 15_000,
    toolExecution: "sequential",
  });
}

async function prompt(agent: Agent, text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<string> {
  let output = "";
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      output += event.assistantMessageEvent.delta;
    }
    if (event.type === "tool_execution_start") {
      progress(`Tool: ${event.toolName}`);
    }
  });
  try {
    await agent.prompt(text, images);
  } finally {
    unsubscribe();
  }
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  return output.trim();
}

function looksLikeNoImageCapability(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /image|vision|multimodal|unsupported.*(media|content)|does not support|can't process|cannot process|invalid.*image|no image/i.test(
    text,
  );
}

async function analyzeImageWithVisionAgent(
  config: Config,
  relativePath: string,
  question: string,
  image: { data: Buffer; mimeType: string },
): Promise<string> {
  const systemPrompt = await loadPrompt("analyze-image-system.md");
  const userTemplate = await loadPrompt("analyze-image-user.md");
  const userPrompt = renderPrompt(userTemplate, {
    image_path: relativePath,
    question,
  });
  const agent = createAgent(config, systemPrompt, []);
  try {
    const content = await prompt(agent, userPrompt, [
      { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
    ]);
    if (!content) return "no image capability";
    return content;
  } catch (cause) {
    if (looksLikeNoImageCapability(cause)) return "no image capability";
    return "no image capability";
  }
}

async function runAnalyzeImageTool(
  config: Config,
  label: string,
  absolute: string,
  question?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  progress(`Analyzing image ${label}`);
  try {
    const original = await readFile(absolute);
    const sourceMime = mimeFromPath(absolute);
    if (!sourceMime.startsWith("image/")) {
      return {
        content: [{ type: "text", text: "no image capability" }],
        details: { path: label, ok: false },
      };
    }
    const ask =
      question?.trim() || "Describe the important details in this knowledge-base figure.";
    const analysis = await analyzeImageWithVisionAgent(config, label, ask, {
      data: original,
      mimeType: sourceMime,
    });
    return {
      content: [{ type: "text", text: analysis }],
      details: { path: label, ok: analysis !== "no image capability" },
    };
  } catch {
    return {
      content: [{ type: "text", text: "no image capability" }],
      details: { path: label, ok: false },
    };
  }
}

function sanitizeMarkdownBody(markdown: string): string {
  return markdown
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/ · (· )+/g, " · ")
    .replace(/[ \t]+\n/g, "\n");
}

function yamlEscape(value: string): string {
  return JSON.stringify(value);
}

function slugifyFilename(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 80) || "untitled-section";
}

function uniqueMarkdownFilename(documentDir: string, baseSlug: string, used: Set<string>): string {
  let slug = slugifyFilename(baseSlug);
  let candidate = `${slug}.md`;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${slug}-${suffix}.md`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function descriptiveSlugFromText(text: string, fallback: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length >= 8 && !/^page\s+\d+/i.test(line));
  const heading = lines.find((line) => /[A-Za-z]/.test(line));
  if (heading) return slugifyFilename(heading.slice(0, 100));
  return slugifyFilename(fallback);
}

function buildFrontMatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(", ")}]`;
    if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
    return `${key}: ${yamlEscape(String(value))}`;
  });
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function createIngestTools(input: IngestInput, written: WrittenFile[], embeddedImages: string[]) {
  const pageMap = new Map(input.pages.map((page) => [page.pageNumber, page]));
  const imageMap = new Map(input.images.map((image) => [image.id, image]));
  const usedFilenames = new Set<string>(["readme.md"]);

  const get_source_metadata: AgentTool = {
    name: "get_source_metadata",
    label: "Source metadata",
    description: "Return document title, source filename, page count, and available image ids.",
    parameters: Type.Object({}),
    execute: async () => {
      const payload = {
        title: input.title,
        sourceFile: input.sourceFile,
        pageCount: input.pages.length,
        pageNumbers: input.pages.map((page) => page.pageNumber),
        images: input.images.map((image) => ({
          id: image.id,
          pageNumber: image.pageNumber,
          fileName: image.fileName,
        })),
        documentDir: input.documentDir,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  };

  const read_pages: AgentTool = {
    name: "read_pages",
    label: "Read pages",
    description: "Read extracted source text for an inclusive page range. Maximum 2 pages per call.",
    parameters: Type.Object({
      page_start: Type.Number({ description: "First page number (1-based)" }),
      page_end: Type.Number({ description: "Last page number (1-based), at most page_start + 1" }),
    }),
    execute: async (_id, raw) => {
      const params = raw as { page_start: number; page_end: number };
      const start = Math.trunc(params.page_start);
      const end = Math.trunc(params.page_end);
      if (end < start) throw new Error("page_end must be >= page_start");
      if (end - start > 1) throw new Error("Each markdown chunk may cover at most 2 pages");
      const pages = [];
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        const page = pageMap.get(pageNumber);
        if (!page) throw new Error(`Page ${pageNumber} was not extracted`);
        pages.push(page);
      }
      progress(`Reading pages ${start}-${end}`);
      return {
        content: [{ type: "text", text: JSON.stringify(pages, null, 2) }],
        details: { start, end, count: pages.length },
      };
    },
  };

  const list_images_for_pages: AgentTool = {
    name: "list_images_for_pages",
    label: "List page images",
    description: "List extracted images/graphs that belong to an inclusive page range.",
    parameters: Type.Object({
      page_start: Type.Number(),
      page_end: Type.Number(),
    }),
    execute: async (_id, raw) => {
      const params = raw as { page_start: number; page_end: number };
      const start = Math.trunc(params.page_start);
      const end = Math.trunc(params.page_end);
      const matches = input.images.filter((image) => image.pageNumber >= start && image.pageNumber <= end);
      return {
        content: [{ type: "text", text: JSON.stringify(matches.map(({ id, pageNumber, fileName }) => ({ id, pageNumber, fileName })), null, 2) }],
        details: { count: matches.length },
      };
    },
  };

  const embed_image: AgentTool = {
    name: "embed_image",
    label: "Embed image",
    description: "Copy an extracted image into the document assets folder and return a relative markdown image path.",
    parameters: Type.Object({
      image_id: Type.String({ description: "Image id from list_images_for_pages / get_source_metadata" }),
    }),
    execute: async (_id, raw) => {
      const params = raw as { image_id: string };
      const image = imageMap.get(params.image_id);
      if (!image) throw new Error(`Unknown image id: ${params.image_id}`);
      const assetsDir = path.join(input.documentDir, "assets");
      await mkdir(assetsDir, { recursive: true });
      const target = path.join(assetsDir, image.fileName);
      await copyFile(image.stagingPath, target);
      const relativePath = `./assets/${image.fileName}`;
      if (!embeddedImages.includes(relativePath)) embeddedImages.push(relativePath);
      progress(`Embedded image ${image.fileName}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            markdown: `![Page ${image.pageNumber} figure](${relativePath})`,
            relativePath,
            pageNumber: image.pageNumber,
          }),
        }],
        details: { relativePath },
      };
    },
  };

  const analyze_image: AgentTool = {
    name: "analyze_image",
    label: "Analyze image",
    description:
      "Analyze an extracted PDF image by path. Pass an image id (img-0), the asset fileName (page-001-img-000.png), or a document-relative path such as ./assets/page-001-img-000.png. Returns a text description, or 'no image capability'.",
    parameters: Type.Object({
      path: Type.String({
        description: "Image id, fileName, or path under the document folder (e.g. ./assets/page-001-img-000.png)",
      }),
      question: Type.Optional(Type.String({ description: "What to look for in the image" })),
    }),
    execute: async (_id, raw) => {
      const params = raw as { path: string; question?: string };
      const requested = params.path.replace(/^\/+/, "").trim();
      const byId = imageMap.get(requested);
      const byFileName = input.images.find(
        (image) => image.fileName === requested || image.fileName === path.basename(requested),
      );
      const image = byId ?? byFileName;
      if (image) {
        return runAnalyzeImageTool(input.config, image.fileName, image.stagingPath, params.question);
      }
      const documentRoot = path.resolve(input.documentDir);
      const absolute = path.resolve(input.documentDir, requested.replace(/^\.\//, ""));
      if (absolute !== documentRoot && !absolute.startsWith(documentRoot + path.sep)) {
        return {
          content: [{ type: "text", text: "no image capability" }],
          details: { path: requested, ok: false },
        };
      }
      return runAnalyzeImageTool(input.config, requested, absolute, params.question);
    },
  };

  const write_markdown_chunk: AgentTool = {
    name: "write_markdown_chunk",
    label: "Write markdown chunk",
    description:
      "Write one markdown knowledge file covering at most 2 pages. Choose a descriptive topic_slug so a later retrieval agent can decide from the filename alone whether the file is relevant.",
    parameters: Type.Object({
      page_start: Type.Number(),
      page_end: Type.Number(),
      title: Type.String({ description: "Human-readable chunk title for front matter" }),
      topic_slug: Type.String({
        description:
          "Kebab-case filename stem that describes the concrete topics in this chunk (e.g. dicamba-registration-status, photosystem-ii-inhibitors). Do not use generic names like pages-1-2.",
      }),
      body_markdown: Type.String({
        description:
          "Pure Markdown body without front matter and without HTML tags. Never use <br> or other HTML; join multi-line cell values with ' · '. Embed images with relative Markdown image syntax.",
      }),
    }),
    execute: async (_id, raw) => {
      const params = raw as {
        page_start: number;
        page_end: number;
        title: string;
        topic_slug: string;
        body_markdown: string;
      };
      const start = Math.trunc(params.page_start);
      const end = Math.trunc(params.page_end);
      if (end < start) throw new Error("page_end must be >= page_start");
      if (end - start > 1) throw new Error("Each markdown chunk may cover at most 2 pages");
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        if (!pageMap.has(pageNumber)) throw new Error(`Page ${pageNumber} was not extracted`);
      }
      const fileName = uniqueMarkdownFilename(input.documentDir, params.topic_slug || params.title, usedFilenames);
      const pages = [];
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) pages.push(pageNumber);
      const frontMatter = buildFrontMatter({
        title: params.title,
        source_file: input.sourceFile,
        source_title: input.title,
        page_start: start,
        page_end: end,
        pages,
        topics: params.topic_slug,
        ingestion_method: "pi-agent",
      });
      const body = sanitizeMarkdownBody(params.body_markdown.trim());
      await writeFile(path.join(input.documentDir, fileName), `${frontMatter}${body}\n`, "utf8");
      written.push({ fileName, pageStart: start, pageEnd: end });
      pageProgress(`Wrote ${fileName}`, written, input.pages.length);
      return {
        content: [{ type: "text", text: JSON.stringify({ fileName, page_start: start, page_end: end }) }],
        details: { fileName },
      };
    },
  };

  const list_written_files: AgentTool = {
    name: "list_written_files",
    label: "List written files",
    description: "List markdown chunk files written so far for this document.",
    parameters: Type.Object({}),
    execute: async () => {
      const files = await readdir(input.documentDir);
      const markdown = files.filter((name) => name.endsWith(".md")).sort();
      return {
        content: [{ type: "text", text: JSON.stringify({ written, markdownFiles: markdown }, null, 2) }],
        details: { count: written.length },
      };
    },
  };

  const finish_ingestion: AgentTool = {
    name: "finish_ingestion",
    label: "Finish ingestion",
    description: "Call when every source page has been covered by a markdown chunk. Stops the agent loop.",
    parameters: Type.Object({
      summary: Type.String({ description: "Short completion summary" }),
    }),
    execute: async (_id, raw) => {
      const params = raw as { summary: string };
      progress(params.summary || "Ingestion finished");
      return {
        content: [{ type: "text", text: params.summary }],
        details: { summary: params.summary, files: written.length, images: embeddedImages.length },
        terminate: true,
      };
    },
  };

  return [
    get_source_metadata,
    read_pages,
    list_images_for_pages,
    embed_image,
    analyze_image,
    write_markdown_chunk,
    list_written_files,
    finish_ingestion,
  ];
}

async function complete(input: CompleteInput) {
  const providedSystem = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const system = providedSystem || (await loadPrompt("chat-system.md"));
  const conversation = input.messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  const agent = createAgent(input.config, system);
  const content = await prompt(agent, conversation);
  if (!content) throw new Error("Pi agent returned no text");
  return { content };
}

function assertInsideRoot(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes the knowledge base: ${relativePath}`);
  }
  return resolved;
}

function stripFrontMatterLocal(content: string): { title: string; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!match) return { title: "", body: normalized };
  const titleMatch = match[1].match(/^title:\s*(.*)$/m);
  const title = titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, "")
    : "";
  return { title, body: match[2] };
}

function mimeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function listKnowledgeEntries(root: string, relativePath = ""): Promise<Array<{ name: string; path: string; kind: string }>> {
  const dir = assertInsideRoot(root, relativePath || ".");
  const names = await readdir(dir);
  const entries = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".") || name === "source_files") continue;
    const full = path.join(dir, name);
    const info = await stat(full);
    const childRelative = relativePath ? `${relativePath.replace(/\\/g, "/")}/${name}` : name;
    if (info.isDirectory()) {
      entries.push({ name, path: childRelative, kind: "folder" });
    } else if (/\.(md|png|jpe?g|gif|webp|svg)$/i.test(name)) {
      entries.push({ name, path: childRelative, kind: "file" });
    }
  }
  return entries;
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(relativePath: string) {
    const entries = await listKnowledgeEntries(root, relativePath);
    for (const entry of entries) {
      if (entry.kind === "folder") await walk(entry.path);
      else if (entry.name.toLowerCase().endsWith(".md")) files.push(entry.path);
    }
  }
  await walk("");
  return files;
}

function createChatTools(input: ChatInput, answer: { content: string; sources: ChatSource[] }) {
  const root = input.knowledgeBaseRoot;

  const browse_knowledge_base: AgentTool = {
    name: "browse_knowledge_base",
    label: "Browse knowledge base",
    description: "List folders and files under a knowledge-base-relative path. Omit path to list the root.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Relative folder path inside knowledge_base" })),
    }),
    execute: async (_id, raw) => {
      const params = raw as { path?: string };
      const relative = (params.path ?? "").replace(/^\/+/, "");
      progress(`Browsing ${relative || "knowledge_base"}`);
      const entries = await listKnowledgeEntries(root, relative);
      return {
        content: [{ type: "text", text: JSON.stringify({ path: relative || ".", entries }, null, 2) }],
        details: { count: entries.length },
      };
    },
  };

  const read_knowledge_file: AgentTool = {
    name: "read_knowledge_file",
    label: "Read markdown file",
    description: "Read a markdown knowledge file by relative path. Returns title and body without relying on HTML.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative .md path inside knowledge_base" }),
    }),
    execute: async (_id, raw) => {
      const params = raw as { path: string };
      const relative = params.path.replace(/^\/+/, "");
      if (!relative.toLowerCase().endsWith(".md")) throw new Error("Only markdown files can be read with this tool");
      const absolute = assertInsideRoot(root, relative);
      progress(`Reading ${relative}`);
      const rawContent = await readFile(absolute, "utf8");
      const { title, body } = stripFrontMatterLocal(rawContent);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ path: relative, title: title || path.basename(relative, ".md"), content: body }, null, 2),
        }],
        details: { path: relative },
      };
    },
  };

  const search_knowledge_base: AgentTool = {
    name: "search_knowledge_base",
    label: "Search knowledge base",
    description: "Search markdown files for a text query and return matching snippets with paths.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ description: "Max results, default 8" })),
    }),
    execute: async (_id, raw) => {
      const params = raw as { query: string; limit?: number };
      const query = params.query.trim();
      if (!query) throw new Error("query is required");
      const limit = Math.min(Math.max(Math.trunc(params.limit ?? 8), 1), 20);
      progress(`Searching for “${query}”`);
      const files = await walkMarkdownFiles(root);
      const needle = query.toLowerCase();
      const hits = [];
      for (const relative of files) {
        const absolute = assertInsideRoot(root, relative);
        const rawContent = await readFile(absolute, "utf8");
        const { title, body } = stripFrontMatterLocal(rawContent);
        const haystack = `${title}\n${body}`;
        const index = haystack.toLowerCase().indexOf(needle);
        if (index < 0) continue;
        const start = Math.max(0, index - 120);
        const end = Math.min(haystack.length, index + query.length + 180);
        hits.push({
          path: relative,
          title: title || path.basename(relative, ".md"),
          snippet: haystack.slice(start, end).replace(/\s+/g, " ").trim(),
        });
        if (hits.length >= limit) break;
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ query, hits }, null, 2) }],
        details: { count: hits.length },
      };
    },
  };

  const analyze_image: AgentTool = {
    name: "analyze_image",
    label: "Analyze image",
    description:
      "Analyze a knowledge-base image by path. Pass a relative image path such as folder/assets/page-001-img-000.png. Returns a text description, or 'no image capability' if vision is unavailable.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative image path inside knowledge_base" }),
      question: Type.Optional(Type.String({ description: "What to look for in the image" })),
    }),
    execute: async (_id, raw) => {
      const params = raw as { path: string; question?: string };
      const relative = params.path.replace(/^\/+/, "");
      const absolute = assertInsideRoot(root, relative);
      return runAnalyzeImageTool(input.config, relative, absolute, params.question);
    },
  };

  const finish_answer: AgentTool = {
    name: "finish_answer",
    label: "Finish answer",
    description: "Submit the final user-facing answer. Content must follow the response style rules. Include every source markdown file you used.",
    parameters: Type.Object({
      content: Type.String({
        description: "Final answer markdown: paragraphs, lists, tables, images, and block quotes only. No headings or HTML.",
      }),
      source_files: Type.Array(Type.String(), {
        description: "Knowledge-base-relative markdown paths this answer was synthesized from",
      }),
    }),
    execute: async (_id, raw) => {
      const params = raw as { content: string; source_files: string[] };
      const cleaned = sanitizeMarkdownBody(params.content)
        .replace(/^#{1,6}\s+/gm, "")
        .trim();
      if (!cleaned) throw new Error("finish_answer content cannot be empty");
      const sources: ChatSource[] = [];
      for (const item of params.source_files ?? []) {
        const relative = String(item).replace(/^\/+/, "");
        if (!relative) continue;
        let title = path.basename(relative, path.extname(relative)).replace(/-/g, " ");
        try {
          if (relative.toLowerCase().endsWith(".md")) {
            const absolute = assertInsideRoot(root, relative);
            const { title: frontTitle } = stripFrontMatterLocal(await readFile(absolute, "utf8"));
            if (frontTitle) title = frontTitle;
          }
        } catch {
          // keep fallback title
        }
        if (!sources.some((source) => source.relativePath === relative)) {
          sources.push({ relativePath: relative, title });
        }
      }
      answer.content = cleaned;
      answer.sources = sources;
      progress(`Answer ready · ${sources.length} sources`);
      return {
        content: [{ type: "text", text: "Answer submitted." }],
        details: { sources: sources.length },
        terminate: true,
      };
    },
  };

  return [browse_knowledge_base, read_knowledge_file, search_knowledge_base, analyze_image, finish_answer];
}

async function chat(input: ChatInput) {
  const answer = { content: "", sources: [] as ChatSource[] };
  const tools = createChatTools(input, answer);
  const systemTemplate = await loadPrompt("chat-system.md");
  const systemPrompt = renderPrompt(systemTemplate, {
    knowledge_tree: input.knowledgeTree || "(empty knowledge base)",
  });
  const userTemplate = await loadPrompt("chat-user.md");
  const conversation = input.messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  const userPrompt = renderPrompt(userTemplate, { conversation });

  progress("Chat agent started");
  const agent = createAgent(input.config, systemPrompt, tools);
  await prompt(agent, userPrompt);

  if (!answer.content) {
    throw new Error("Chat agent finished without calling finish_answer");
  }
  return {
    content: answer.content,
    sources: answer.sources,
  };
}

function coveredPages(written: WrittenFile[]): Set<number> {
  const pages = new Set<number>();
  for (const file of written) {
    for (let page = file.pageStart; page <= file.pageEnd; page += 1) pages.add(page);
  }
  return pages;
}

function pageProgress(message: string, written: WrittenFile[], pageTotal: number) {
  progress(message, { pagesDone: coveredPages(written).size, pageTotal });
}

async function ingest(input: IngestInput) {
  await mkdir(input.documentDir, { recursive: true });
  const written: WrittenFile[] = [];
  const embeddedImages: string[] = [];
  const tools = createIngestTools(input, written, embeddedImages);

  progress(`Preparing knowledge folder for ${input.sourceFile}`, {
    pagesDone: 0,
    pageTotal: input.pages.length,
  });
  const systemPrompt = await loadPrompt("ingest-system.md");
  const userTemplate = await loadPrompt("ingest-user.md");
  const userPrompt = renderPrompt(userTemplate, {
    document_dir: input.documentDir,
    title: input.title,
    source_file: input.sourceFile,
    page_count: input.pages.length,
    image_count: input.images.length,
  });

  const agent = createAgent(input.config, systemPrompt, tools);
  await prompt(agent, userPrompt);

  const covered = coveredPages(written);
  const missing = input.pages.map((page) => page.pageNumber).filter((page) => !covered.has(page));
  if (missing.length) {
    pageProgress(`Filling ${missing.length} uncovered pages with fallback chunks`, written, input.pages.length);
    const usedFilenames = new Set(
      (await readdir(input.documentDir))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.toLowerCase()),
    );
    usedFilenames.add("readme.md");
    for (let index = 0; index < missing.length; index += 2) {
      const slice = missing.slice(index, index + 2);
      const start = slice[0];
      const end = slice[slice.length - 1];
      const bodies = [];
      let slugSource = "";
      for (const pageNumber of slice) {
        const page = input.pages.find((item) => item.pageNumber === pageNumber)!;
        if (!slugSource) slugSource = page.content;
        const pageImages = input.images.filter((image) => image.pageNumber === pageNumber);
        const imageBlocks: string[] = [];
        for (const image of pageImages) {
          const assetsDir = path.join(input.documentDir, "assets");
          await mkdir(assetsDir, { recursive: true });
          await copyFile(image.stagingPath, path.join(assetsDir, image.fileName));
          const relativePath = `./assets/${image.fileName}`;
          if (!embeddedImages.includes(relativePath)) embeddedImages.push(relativePath);
          imageBlocks.push(`![Page ${pageNumber} figure](${relativePath})`);
        }
        bodies.push(`## Page ${pageNumber}\n\n${page.content}${imageBlocks.length ? `\n\n${imageBlocks.join("\n\n")}` : ""}`);
      }
      const topicSlug = descriptiveSlugFromText(slugSource, `${input.title}-pages-${start}-${end}`);
      const fileName = uniqueMarkdownFilename(input.documentDir, topicSlug, usedFilenames);
      const frontMatter = buildFrontMatter({
        title: `${input.title} · Pages ${start}-${end}`,
        source_file: input.sourceFile,
        source_title: input.title,
        page_start: start,
        page_end: end,
        pages: slice,
        topics: topicSlug,
        ingestion_method: "pi-agent-fallback",
      });
      await writeFile(path.join(input.documentDir, fileName), `${frontMatter}${bodies.join("\n\n")}\n`, "utf8");
      written.push({ fileName, pageStart: start, pageEnd: end });
      pageProgress(`Wrote fallback ${fileName}`, written, input.pages.length);
    }
  }

  const readme = [
    `# ${input.title}`,
    "",
    `Source: \`${input.sourceFile}\``,
    "",
    `Chunks: ${written.length}`,
    `Images embedded: ${embeddedImages.length}`,
    "",
  ].join("\n");
  try {
    await readFile(path.join(input.documentDir, "README.md"), "utf8");
  } catch {
    await writeFile(path.join(input.documentDir, "README.md"), readme, "utf8");
  }

  pageProgress(`Ingestion complete · ${written.length} files`, written, input.pages.length);
  return {
    title: input.title,
    sourceFile: input.sourceFile,
    documentDir: input.documentDir,
    fileCount: written.length,
    imageCount: embeddedImages.length,
    files: written,
  };
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Input;
  const result =
    input.operation === "ingest"
      ? await ingest(input)
      : input.operation === "chat"
        ? await chat(input)
        : await complete(input);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
