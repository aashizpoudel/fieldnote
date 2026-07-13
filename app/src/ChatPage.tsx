import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronUp,
  FileText,
  LoaderCircle,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Trash2,
} from "lucide-react";
import { chatWithKnowledge, getKnowledgeBaseRoot } from "./api";
import { MarkdownAnchor } from "./markdownLinks";
import type { ChatMessage, ChatSource, Settings } from "./types";

const HISTORY_KEY = "fieldnote-chat-history-v1";
const SIDEBAR_KEY = "fieldnote-chat-sidebar-open";

type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

function createThread(): ChatThread {
  return {
    id: crypto.randomUUID(),
    title: "New question",
    updatedAt: Date.now(),
    messages: [],
  };
}

function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return "New question";
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  return cleaned.length > 42 ? `${cleaned.slice(0, 42)}…` : cleaned;
}

function loadThreads(): { threads: ChatThread[]; activeId: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null");
    if (saved?.threads?.length && saved.activeId) {
      return {
        threads: saved.threads as ChatThread[],
        activeId: String(saved.activeId),
      };
    }
  } catch {
    // ignore corrupt storage
  }
  const thread = createThread();
  return { threads: [thread], activeId: thread.id };
}

function persistThreads(threads: ChatThread[], activeId: string) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify({ threads, activeId }));
}

function ChatImage({
  src,
  alt,
  knowledgeRoot,
}: {
  src?: string;
  alt?: string;
  knowledgeRoot: string;
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
      const cleaned = src.replace(/^\.\//, "").replace(/^\/+/, "");
      const absolute = `${knowledgeRoot.replace(/\/$/, "")}/${cleaned}`.replace(/\\/g, "/");
      try {
        const dataUrl = await invoke<string>("read_asset_data_url", { path: absolute });
        if (!cancelled) setUrl(dataUrl);
      } catch {
        if (!cancelled) setUrl("");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [src, knowledgeRoot]);

  if (!url) return null;
  return <img src={url} alt={alt ?? ""} loading="lazy" />;
}

function SourceMeta({ sources }: { sources: ChatSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="chat-sources">
      <div className="chat-sources-label">Based on</div>
      <div className="chat-source-chips">
        {sources.map((source) => (
          <span className="chat-source-chip" key={source.relativePath} title={source.relativePath}>
            <FileText size={12} />
            {source.title || source.relativePath}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatThreadTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function ChatPage({
  settings,
  openSettings,
}: {
  settings: Settings;
  openSettings: () => void;
}) {
  const initial = useMemo(() => loadThreads(), []);
  const [threads, setThreads] = useState<ChatThread[]>(initial.threads);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [knowledgeRoot, setKnowledgeRoot] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const activeThread = threads.find((thread) => thread.id === activeId) ?? threads[0];
  const messages = activeThread?.messages ?? [];

  useEffect(() => {
    void getKnowledgeBaseRoot().then(setKnowledgeRoot).catch(() => setKnowledgeRoot(""));
  }, []);

  useEffect(() => {
    persistThreads(threads, activeId);
  }, [threads, activeId]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages, busy, progressLines, activeId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("chat-progress", (event) => {
      setProgressLines((current) => [...current.slice(-40), event.payload]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  function updateActiveMessages(nextMessages: ChatMessage[]) {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === activeId
          ? {
              ...thread,
              messages: nextMessages,
              title: titleFromMessages(nextMessages),
              updatedAt: Date.now(),
            }
          : thread,
      ),
    );
  }

  function startNewChat() {
    if (busy) return;
    const empty = threads.find((thread) => thread.messages.length === 0);
    if (empty) {
      setActiveId(empty.id);
      setError("");
      setProgressLines([]);
      setInput("");
      return;
    }
    const thread = createThread();
    setThreads((current) => [thread, ...current]);
    setActiveId(thread.id);
    setError("");
    setProgressLines([]);
    setInput("");
  }

  function selectThread(id: string) {
    if (busy || id === activeId) return;
    setActiveId(id);
    setError("");
    setProgressLines([]);
    setInput("");
  }

  function deleteThread(id: string) {
    if (busy) return;
    setThreads((current) => {
      const remaining = current.filter((thread) => thread.id !== id);
      if (!remaining.length) {
        const thread = createThread();
        setActiveId(thread.id);
        return [thread];
      }
      if (id === activeId) {
        setActiveId(remaining[0].id);
      }
      return remaining;
    });
    setError("");
    setProgressLines([]);
  }

  async function submit() {
    const text = input.trim();
    if (!text || busy || !activeThread) return;
    if (!settings.llmApiUrl || !settings.llmApiKey) {
      openSettings();
      return;
    }
    const user: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const next = [...messages, user];
    updateActiveMessages(next);
    setInput("");
    setBusy(true);
    setError("");
    setProgressLines(["Getting ready…"]);
    try {
      const result = await chatWithKnowledge(settings, next);
      updateActiveMessages([
        ...next,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.content,
          sources: result.sources,
        },
      ]);
    } catch (cause) {
      setError("Couldn't finish that answer. Check your connection in Settings, then try again.");
      console.error(cause);
    } finally {
      setBusy(false);
    }
  }

  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  );

  return (
    <main className={`chat-layout ${sidebarOpen ? "chat-sidebar-open" : "chat-sidebar-closed"}`}>
      <aside className="chat-history-sidebar" aria-hidden={!sidebarOpen}>
        <div className="chat-history-top">
          <button className="button primary chat-new-button" onClick={startNewChat} disabled={busy}>
            <Plus size={16} />
            New question
          </button>
        </div>
        <div className="chat-history-label">Recent questions</div>
        <div className="chat-history-list">
          {sortedThreads.map((thread) => (
            <div
              key={thread.id}
              className={`chat-history-item ${thread.id === activeId ? "active" : ""}`}
            >
              <button
                type="button"
                className="chat-history-select"
                onClick={() => selectThread(thread.id)}
                disabled={busy && thread.id !== activeId}
              >
                <span>{thread.title}</span>
                <small>{formatThreadTime(thread.updatedAt)}</small>
              </button>
              <button
                type="button"
                className="chat-history-delete"
                title="Delete"
                onClick={() => deleteThread(thread.id)}
                disabled={busy}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <header className="page-header chat-header">
          <div className="chat-header-left">
            <button
              type="button"
              className="icon-button chat-sidebar-toggle"
              onClick={() => setSidebarOpen((value) => !value)}
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              aria-pressed={sidebarOpen}
            >
              {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
            </button>
            <div>
              <span className="eyebrow">Ask</span>
              <h1>{activeThread?.messages.length ? activeThread.title : "New question"}</h1>
            </div>
          </div>
          <div className="chat-header-actions">
            <button className="button secondary" onClick={startNewChat} disabled={busy}>
              <Plus size={15} />
              New question
            </button>
          </div>
        </header>

        <div className="chat-scroll">
          {!messages.length && (
            <div className="empty-chat">
              <div className="empty-mark"><BookOpen size={28} /></div>
              <h2>Ask about your sources</h2>
              <p>Fieldnote searches the guides and notes you’ve added—herbicide labels, extension pubs, scouting notes—and answers from those only.</p>
              <div className="suggestions">
                {[
                  "What causes soybean leaf cupping after a spray?",
                  "What’s the current status of dicamba for soybeans?",
                  "Which Group 5 herbicides are in my sources?",
                ].map((text) => (
                  <button key={text} onClick={() => setInput(text)}>
                    {text}
                    <ArrowUp size={14} />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="message-list">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-role">{message.role === "user" ? "You" : "Fieldnote"}</div>
                {message.role === "assistant" ? (
                  <div className="message-markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: MarkdownAnchor,
                        h1: ({ children }) => <p>{children}</p>,
                        h2: ({ children }) => <p>{children}</p>,
                        h3: ({ children }) => <p>{children}</p>,
                        h4: ({ children }) => <p>{children}</p>,
                        h5: ({ children }) => <p>{children}</p>,
                        h6: ({ children }) => <p>{children}</p>,
                        img: ({ src, alt }) => (
                          <ChatImage src={src} alt={alt} knowledgeRoot={knowledgeRoot} />
                        ),
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                    {message.sources && <SourceMeta sources={message.sources} />}
                  </div>
                ) : (
                  <div className="message-content">{message.content}</div>
                )}
              </article>
            ))}
            {busy && (
              <div className="thinking">
                <LoaderCircle className="spin" size={16} />
                Searching your sources…
              </div>
            )}
            {error && <div className="error-banner">{error}</div>}
            <div ref={endRef} />
          </div>
        </div>

        {(busy || progressLines.length > 0) && (
          <div className="chat-progress">
            <div className="chat-progress-bar">
              <div className="chat-progress-summary">
                {busy && <LoaderCircle className="spin" size={14} />}
                <span>{busy ? "Working from your sources…" : "Done"}</span>
              </div>
              <button
                type="button"
                className="chat-progress-toggle"
                onClick={() => setShowDetails((value) => !value)}
                aria-expanded={showDetails}
              >
                Show Activity
                {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
            {showDetails && (
              <div className="chat-progress-log">
                {progressLines.map((line, index) => (
                  <div key={`${index}-${line}`}>{line}</div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask about rates, timing, weeds, products…"
              rows={1}
            />
            <button onClick={submit} disabled={!input.trim() || busy} title="Send">
              <ArrowUp size={18} />
            </button>
          </div>
          <span>Answers come only from sources you’ve added.</span>
        </div>
      </section>
    </main>
  );
}
