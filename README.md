# Tsukuyomi (月詠) - Moonlit Translator

![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg) ![GitHub Release](https://img.shields.io/github/v/release/rozx/Tsukuyomi) ![Vue](https://img.shields.io/badge/Vue.js-3.5-4FC08D?logo=vue.js&logoColor=white) ![Quasar](https://img.shields.io/badge/Quasar-2.18-1976D2?logo=quasar&logoColor=white) ![Electron](https://img.shields.io/badge/Electron-39.2-47848F?logo=electron&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript&logoColor=white) ![Bun](https://img.shields.io/badge/Bun-1.0-000000?logo=bun&logoColor=white)

[![Github All Releases](https://img.shields.io/github/downloads/rozx/Tsukuyomi/total.svg)](https://github.com/rozx/Tsukuyomi/releases)

![GitHub stars](https://img.shields.io/github/stars/rozx/Tsukuyomi?style=social) ![GitHub forks](https://img.shields.io/github/forks/rozx/Tsukuyomi?style=social) ![GitHub issues](https://img.shields.io/github/issues/rozx/Tsukuyomi) ![GitHub last commit](https://img.shields.io/github/last-commit/rozx/Tsukuyomi) ![GitHub repo size](https://img.shields.io/github/repo-size/rozx/Tsukuyomi)

<img width="192" height="192" alt="android-chrome-192x192" src="https://github.com/user-attachments/assets/80e77fc0-9aa6-4900-9b5f-7420672a12a4" />

## Why This Fork

This is a personal fork of [rozx/Tsukuyomi](https://github.com/rozx/Tsukuyomi) focused on building a **curated personal novel library with a built-in web scraper**. Where the upstream project is a general-purpose AI translation platform, this fork leans into the library and discovery side: curated shelves, deeper word-level tooling, and a scraper workflow tuned for the sources I actually use.

### What We Added

- **Multi-source web scraper** — one-click import from five novel sites: `kakuyomu.jp`, `ncode.syosetu.com` (metadata), `nobadnovel.com`, `freewebnovel.com`, and `novellunar.com`. Powered by Puppeteer + stealth plugin on desktop and HTTP proxy polling on web.
- **Scraper documentation** — full setup and usage guide at [`docs/SCRAPER.md`](docs/SCRAPER.md), covering per-site behaviour, authentication requirements, and troubleshooting.
- **Curated library focus** — the UI and import workflow are tuned for personal collection management: hand-picked shelves, intentional imports, and a reading experience built around novels you actually want to finish.

### How to Use the Scraper

1. Open the app and go to **Library → Import**.
2. Paste a novel URL from any supported site (see list above).
3. Click **Auto-scrape** — the app fetches chapter list and metadata automatically.
4. For Kakuyomu or ncode novels, authentication may be required; see [`docs/SCRAPER.md`](docs/SCRAPER.md) for site-specific steps.
5. Once imported, the novel appears in your library ready for translation or reading.

> For the full scraper reference — rate limits, proxy config, troubleshooting — see **[docs/SCRAPER.md](docs/SCRAPER.md)**.

---

> A modern AI-assisted translation tool built for light novel readers and translators.

**Tsukuyomi (月詠)** is a comprehensive platform for reading and translating foreign-language text — designed specifically for Japanese light novels — powered by state-of-the-art AI models such as **GPT-5.2**, **Claude 4.6**, **Gemini 3 Pro**, and more. Whether you want to read raw Japanese quickly or produce polished, publication-quality translations, Tsukuyomi covers the full workflow.

- Web version: [https://tsukuyomi.rozx.moe](https://tsukuyomi.rozx.moe/)
- Latest release: [click here](https://github.com/rozx/Tsukuyomi/releases/latest)

![Tsukuyomi Dashboard](public/screenshots/desktop-index.png)

## ✨ Core Features

### 🤖 Multi-Model AI Matrix

Tsukuyomi uses a "Bring Your Own Key" model, giving you direct access to the world's leading AI models:

- **OpenAI**: GPT-5.2, GPT-o1 (advanced reasoning), GPT-4o (balanced, all-purpose).
- **Anthropic**: Claude 4.6 Opus (exceptional literary quality), Claude 3.5 Sonnet (fast responses).
- **Google**: Gemini 3 Pro (million-token context), Gemini 2.0 Flash (best cost/performance ratio).
- **DeepSeek**: DeepSeek-V3, DeepSeek-R1 (top open-source models for logic and code).
- **Moonshot**: Kimi k2.5 (deeply optimised for Chinese-language contexts).

**Best practices**:

- Use **GPT-5.2** or **DeepSeek-R1** for first-pass translation to handle complex sentences and metaphors.
- Use **Claude 4.6 Opus** or **Gemini 3 Pro** for polishing, leveraging their long context to keep the style consistent across the whole book.

### 📚 Smart Translation & Reading

A deeply customised reading environment that makes translation enjoyable:

- **Immersive bilingual mode**: Side-by-side comparison with automatic paragraph-level alignment and highlighting.
- **Full-pipeline AI operations**:
  - **Translate**: Precise translation that accounts for the full book's context.
  - **Polish**: Removes "translationese" so the target text reads naturally.
  - **Proofread**: Automatically catches omissions, typos, and formatting issues.
- **Multi-version comparison**: Try different models on the same paragraph and switch between results.
- **Real-time progress monitoring**: Sidebar shows translation progress, estimated time remaining, and processing logs.

### 🧩 Deep Context Management System (Context Engine)

Solves the root cause of AI translation inconsistencies — forgotten character names, shifting tone — at the architecture level:

#### 1. 📖 Glossary

- **Precise substitution**: Enforces consistent translations for place names, skill names, and specific terms.
- **Semantic guidance**: Add descriptions so the AI understands each term's role in the story.

#### 2. 👥 Character Settings

- **Multi-dimensional attributes**: Define a character's gender, tone, speech quirks, and personality traits.
- **Alias recognition**: Build an alias library so the AI knows "the hero", "that guy", and "Satou" are all the same person.
- **Tone control**: Automatically adjusts dialogue style (tsundere, classical, yakuza-speech, etc.) to give each character a distinct voice.

#### 3. 🧠 Memory Bank

- **World-building persistence**: Records faction relationships, magic system rules, and key plot threads.
- **Semantics-first memory retrieval**: When embeddings are enabled, memories are scored by semantic similarity, keyword match, and time decay (weights 0.85 / 0.10 / 0.05). When disabled or unavailable, falls back to keyword + time decay (0.75 / 0.25). Scores are normalised to 0–1.0 and the most relevant memories are injected within a character budget.
- **Local semantic embeddings (optional)**: Built-in `gte-multilingual-base` multilingual encoder (Transformers.js), running via WebGPU + q4f16 with automatic fallback to WASM + q8. Runs entirely locally; does not consume API quota. Disabled by default — enable under Settings → Local Embeddings. Forced off on mobile due to WASM memory limits.
- **Hybrid search**: The `search_memories` tool supports natural-language queries using both keyword matching and semantic vector ranking; automatically degrades to keyword + time decay when embeddings are off.

#### 4. 📑 Chapter Semantic Index

- **Multi-vector chapter index**: When local embeddings are enabled, each chapter is indexed with ~100-character paragraph boundaries into native 768-dimensional multi-vector indexes, plus a dedicated vector for "chapter title + first paragraph" to support title/series/theme queries.
- **`query_chapter` hybrid retrieval**: The AI can search across chapters in natural language. Semantic confidence is calibrated at chapter granularity, semantic/keyword RRF rankings are fused, and results are sorted by `0.85 × semantic + 0.15 × keyword` with weak matches filtered out. Translate, polish, proofread, and chat assistant tasks all know how to call this tool for cross-chapter context.
- **Bulk management**: The local vector index panel shows record counts per book and supports single-book rebuild, bulk recalculation, and a test-query dialog.

### 💬 AI Collaboration Chat Assistant

Your 24/7 translation mentor in the sidebar:

- **Real-time assistance**: Ask "What's the cultural reference here?" or "How do I keep the author's wit in this line?" at any point.
- **Automated control**: Modify book metadata or add/remove glossary terms directly through conversation — e.g. "Mark this book as complete."
- **Built-in knowledge base**: For questions about the software itself, the AI searches the official help docs to answer you.

### ☁️ Data Sync & Security

- **Local-first**: Data is stored in IndexedDB — no privacy concerns, works fully offline.
- **Gist cloud sync**: Pairs with **GitHub Gist** for private cloud backup with revision history; restore to any historical version in one click.
- **Manifest incremental sync**: Uses `manifest.json` + SHA-256 hashes to upload only changed entries; downloads use `If-None-Match` conditional GET so unchanged remote data doesn't consume API quota. Pre-upload pseudo-CAS checks the remote ETag, with automatic merge-and-retry for concurrent multi-device writes.
- **Cross-device delete consistency**: The manifest uses tombstones to propagate deletions, so an entry deleted on device A won't be pushed back by device B.
- **Force-push mode**: When migrating devices or recovering a corrupted remote, overwrite the remote with local data in one click.

### 📱 Full Device Support

- **Desktop / Tablet / Mobile**: Dispatcher + three-variant architecture. Desktop maximises information density; tablet provides dual-panel reading with a dockable AI assistant; mobile uses a native-feeling bottom tab bar + BottomSheet layout.
- **Electron desktop app**: A single codebase ships both a Web SPA and a cross-platform desktop client; the desktop build forces the Desktop variant.

## 📸 Screenshots

Since v0.10.1 every page has a dedicated template for desktop, tablet, and mobile (not just a stretched layout). Screenshots below are from live builds.

### 🏠 Home · Dashboard

![Desktop Home](public/screenshots/desktop-index.png)

|                                 Tablet                                 |                                 Mobile                                 |
| :---------------------------------------------------------------------: | :---------------------------------------------------------------------: |
| <img src="public/screenshots/tablet-index.png" alt="Tablet Home" width="100%" /> | <img src="public/screenshots/mobile-index.png" alt="Mobile Home" width="100%" /> |

### 📚 Library

![Desktop Library](public/screenshots/desktop-library.png)

|                                  Tablet                                  |                                  Mobile                                  |
| :-----------------------------------------------------------------------: | :-----------------------------------------------------------------------: |
| <img src="public/screenshots/tablet-library.png" alt="Tablet Library" width="100%" /> | <img src="public/screenshots/mobile-library.png" alt="Mobile Library" width="100%" /> |

### 📖 Book Details & Reader

> Desktop and tablet use a dual-panel layout combining the chapter tree, metadata, and paragraph reader into one view; mobile splits these into separate screens to fit portrait space.

![Desktop Book Details](public/screenshots/desktop-book-details.png)

|                                      Tablet                                       |                                     Mobile (Book Details)                                      |                                  Mobile (Reader)                                   |
| :--------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------: |
| <img src="public/screenshots/tablet-book-details.png" alt="Tablet Book Details" width="100%" /> | <img src="public/screenshots/mobile-book-details.png" alt="Mobile Book Details" width="100%" /> | <img src="public/screenshots/mobile-reader.png" alt="Mobile Reader" width="100%" /> |

### 💬 AI Assistant · Reader + Chat Workspace

The right panel is dockable — summon the AI assistant at any time. With local embeddings enabled, `query_chapter` / `search_memories` tools allow cross-chapter and cross-memory context retrieval.

![Desktop Reader + AI Assistant](public/screenshots/desktop-reader-with-chat.png)

|                                            Tablet                                             |                                        Mobile                                         |
| :-------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------: |
| <img src="public/screenshots/tablet-reader-with-chat.png" alt="Tablet Reader + AI Assistant" width="100%" /> | <img src="public/screenshots/mobile-reader-with-chat.png" alt="Mobile AI Assistant" width="100%" /> |

### 🤖 AI Model Management

![Desktop AI Models](public/screenshots/desktop-ai-models.png)

|                                     Tablet                                     |                                     Mobile                                     |
| :-----------------------------------------------------------------------------: | :-----------------------------------------------------------------------------: |
| <img src="public/screenshots/tablet-ai-models.png" alt="Tablet AI Models" width="100%" /> | <img src="public/screenshots/mobile-ai-models.png" alt="Mobile AI Models" width="100%" /> |

## 🔒 Privacy & Data Sovereignty

Tsukuyomi is built from the ground up on the principle that your data belongs to you:

- **Local-first architecture**: All books, translations, glossaries, memories, and settings are stored by default in the browser's IndexedDB (or on local disk in the Electron desktop app). **Fully usable offline.**
- **BYOK (Bring Your Own Key)**: API keys are stored only locally; requests go directly to the AI provider (or your own CORS proxy / gateway) — no third-party relay.
- **Local semantic embeddings**: When "Local Embeddings" is enabled, the memory bank and chapter semantic index run Transformers.js entirely inside the browser / Electron process. **No text is uploaded to any external embedding service.** Model files are downloaded once and cached in the browser's Cache Storage.
- **Optional Gist cloud sync**: Cloud backup writes only to your own private GitHub Gist. Manifest + SHA-256 conditional GET minimises traffic; the token is stored encrypted locally. Disable sync to go fully offline.
- **No tracking · No analytics**: No usage data is collected; no statistics or advertising SDKs are included.

## 🚀 Quick Start

### 1. Install & Run

This project is built on [Bun](https://bun.sh):

```bash
# Clone and enter the repo
git clone https://github.com/xboss182/Tsukuyomi.git
cd Tsukuyomi

# Install dependencies
bun install

# Start the development server
bun run dev
```

### 2. Import Guide

- **Auto-scrape**: One-click import from `kakuyomu.jp`, `ncode.syosetu.com` (metadata), `nobadnovel.com`, `freewebnovel.com`, `novellunar.com` — see [docs/SCRAPER.md](docs/SCRAPER.md).
- **JSON import**: Import translation packages or backup files shared by other translators.

## 📖 Documentation Index

| Category | Guides (under `public/help`) |
| :------- | :--------------------------- |
| **Setup** | [Quick Start](public/help/front-page.md) \| [AI Model Config](public/help/ai-models-guide.md) \| [Settings & Sync](public/help/settings-guide.md) |
| **Library** | [Library Overview](public/help/library-guide.md) \| [Import & Scrape](public/help/books-page-guide.md) \| [Chapter Management](public/help/book-details-chapters.md) |
| **Translation** | [Translation Panel](public/help/book-details-translation.md) \| [Three Editing Modes](public/help/book-details-editing.md) \| [Toolbar Guide](public/help/toolbar-guide.md) |
| **Core Logic** | [Glossary](public/help/book-details-terminology.md) \| [Character Settings](public/help/book-details-characters.md) \| [Memory System](public/help/book-details-memory.md) |
| **Advanced** | [Chat Assistant](public/help/chat-assistant-guide.md) |

> 📖 **Online docs**: The full help documentation is also available on the [GitHub Wiki](https://github.com/rozx/Tsukuyomi/wiki).

## 🧱 Tech Stack

| Layer | Technology |
| :---- | :--------- |
| **Frontend** | Vue 3.5 · Quasar 2.18 · TypeScript 5.9 · Pinia 3 · PrimeVue 4.5 · Tailwind CSS 3.4 · Vue-i18n (zh-CN / zh-TW / en-US) |
| **Desktop** | Electron 39 (Web SPA and desktop share one codebase; `useDeviceVariant` forces the Desktop variant) |
| **Runtime / Build** | Bun ≥ 1.0 · Vite · Quasar CLI |
| **AI SDK** | OpenAI SDK · Google Generative AI · Custom Claude integration · Moonshot Kimi and other OpenAI-compatible models (BYOK) |
| **Local Embeddings** | Transformers.js (ONNX Runtime Web) · `gte-multilingual-base` · WebGPU + q4f16 (preferred) / WASM + q8 (fallback) |
| **Storage / Sync** | IndexedDB (`idb`) · GitHub Gist (`@octokit/rest`) · SHA-256 hash manifest · Conditional GET + pseudo-CAS concurrency protection |
| **Scraper** | Puppeteer + `puppeteer-extra-plugin-stealth` (Electron desktop) / HTTP proxy polling (web) |
| **Testing** | Bun test · fake-indexeddb |

## 🛠️ Development & Build

| Command | Purpose |
| :------ | :------ |
| `bun install` | Install dependencies |
| `bun run dev` | Start web dev mode (frontend :9000, backend :8080) |
| `bun run dev:electron` | Start Electron dev mode |
| `bun run build:spa` | Build production Web SPA |
| `bun run build:electron` | Package cross-platform desktop client (dmg/exe/deb) |
| `bun run start` | Start the private Bun web server (loopback only) |
| `bun run migrate` | Apply transactional SQLite migrations |
| `bun run backup` | Create a verified SQLite snapshot (`TSUKUYOMI_BACKUP_PATH`) |
| `bun run admin:set-password` | TTY-only first password bootstrap |
| `bun run admin:reset-password` | TTY-only emergency password reset; revokes sessions |
| `bun run lint` | Run ESLint |
| `bun run type-check` | TypeScript type check |
| `bun test` | Run test suite |
| `bun run bump` | Bump version number |

**Developer docs**: [Build Troubleshooting](docs/BUILD_TROUBLESHOOTING.md) \| [Private Web Deployment](docs/WEB_DEPLOYMENT.md) \| [Theme Guide](docs/THEME_GUIDE.md) \| [Translation Guide](docs/TRANSLATION_GUIDE.md) \| [Wiki Sync](docs/WIKI_SYNC.md) \| [Scraper Guide](docs/SCRAPER.md) \| [Contributor Guide](AGENTS.md) \| [Project Conventions (Claude Code)](CLAUDE.md)

## 🤝 Contributing

Issues, PRs, and translator feedback are all welcome. Before submitting code:

1. `bun run lint && bun run type-check` must pass locally.
2. New features should include tests in `src/__tests__/`.
3. UI changes must be manually verified at desktop, tablet, and mobile breakpoints, following the "device variant rules" in `CLAUDE.md`.

## 📄 License

[Apache License 2.0](LICENSE) — free for personal and commercial use; please retain the copyright notice in any redistribution.

---

> _Tsukuyomi — where every page turn flows like moonlight._
