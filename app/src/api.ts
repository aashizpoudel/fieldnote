import { invoke } from "@tauri-apps/api/core";
import type {
  ChatAgentResult,
  ChatMessage,
  ConnectionTest,
  IngestResult,
  KnowledgeFile,
  KnowledgeNode,
  Settings,
} from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function listKnowledgeTree(): Promise<KnowledgeNode[]> {
  if (!isTauri()) return [];
  return invoke("list_knowledge_tree");
}

export async function readKnowledgeFile(relativePath: string): Promise<KnowledgeFile> {
  if (!isTauri()) throw new Error("Knowledge base access requires the Tauri desktop app.");
  return invoke("read_knowledge_file", { relativePath });
}

export async function writeKnowledgeFile(relativePath: string, content: string): Promise<void> {
  if (!isTauri()) throw new Error("Knowledge base editing requires the Tauri desktop app.");
  return invoke("write_knowledge_file", { relativePath, content });
}

export async function deleteKnowledgeEntry(relativePath: string): Promise<void> {
  if (!isTauri()) throw new Error("Deleting library items requires the Tauri desktop app.");
  return invoke("delete_knowledge_entry", { relativePath });
}

export async function ingestDocument(path: string, settings: Settings): Promise<IngestResult> {
  if (!isTauri()) throw new Error("Document ingestion is available in the Tauri desktop app.");
  return invoke("ingest_document", {
    path,
    apiUrl: settings.llmApiUrl,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
  });
}

export async function chatWithKnowledge(
  settings: Settings,
  messages: ChatMessage[],
): Promise<ChatAgentResult> {
  if (!isTauri()) {
    return {
      content: "Run this interface through Tauri to connect the configured LLM and knowledge base.",
      sources: [],
    };
  }
  return invoke("chat_with_knowledge", {
    apiUrl: settings.llmApiUrl,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    messages: messages.map(({ role, content }) => ({ role, content })),
  });
}

export async function testLlm(settings: Settings): Promise<ConnectionTest> {
  if (!isTauri()) throw new Error("Connection tests are available in the Tauri desktop app.");
  return invoke("test_llm", {
    apiUrl: settings.llmApiUrl,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
  });
}

export async function getKnowledgeBaseRoot(): Promise<string> {
  if (!isTauri()) return "knowledge_base";
  return invoke("get_knowledge_base_root");
}
