export type Settings = {
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
};

export type KnowledgeNode = {
  name: string;
  path: string;
  kind: "folder" | "file" | string;
  children?: KnowledgeNode[];
};

export type KnowledgeFile = {
  path: string;
  relativePath: string;
  content: string;
};

export type IngestResult = {
  title: string;
  sourceFile: string;
  documentDir: string;
  fileCount: number;
  imageCount: number;
};

export type ChatSource = {
  relativePath: string;
  title: string;
};

export type ChatAgentResult = {
  content: string;
  sources: ChatSource[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
};

export type ConnectionTest = {
  ok: boolean;
  message: string;
};
