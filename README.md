

# Fieldnote

Fieldnote helps producers and crop advisors ask questions against **their own** compiled crop and weed management sources—herbicide guides, extension pubs, scouting notes, and related PDFs. Add documents to a local library, then ask in plain language; answers come only from what you’ve added.

Currently building it for hackathon at ASABE AIM 2026.d.



## Requirements

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable) and Cargo
- [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS
- An OpenAI-compatible LLM API endpoint (URL, model name, and API key)

## Setup

```bash
cd app
npm install
```

Prompts live in `prompts/` at the repo root. Ingested sources are stored under `knowledge_base/` (created automatically; not committed).

## Run

Start the desktop app in development:

```bash
cd app
npm run tauri dev
```

On first launch, open **Settings**, set your model **Endpoint URL**, **Model**, and **API key**, then tap **Test**.

Typical workflow:

1. **Sources** — add a PDF, Markdown, or text file; Fieldnote turns it into searchable notes.
2. **Ask** — question rates, timing, weeds, products, and related topics from those sources.

## Build

```bash
cd app
npm run tauri build
```

Bundled apps are written under `app/src-tauri/target/release/bundle/`.
