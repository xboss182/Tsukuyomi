# Scraper Guide

Tsukuyomi has a built-in web scraper that fetches novel metadata and chapter content directly from supported sites. This guide covers supported sources, how to import a novel, per-site notes, and troubleshooting.

## Supported Sources

| Source | URL pattern | What's fetched |
| :----- | :---------- | :------------- |
| **FreeWebNovel** | `freewebnovel.com/novel/<slug>` | Metadata + all chapters |
| **NoBadNovel** | `nobadnovel.com/series/<slug>` | Metadata + all chapters |
| **NovelLunar** | `novellunar.com/novel/<slug>` | Metadata + all chapters |
| **Kakuyomu** | `kakuyomu.jp/works/<id>` | Metadata + all chapters |
| **ncode.syosetu** | `ncode.syosetu.com/<ncode>` | Metadata only (no chapter content) |

> `ncode.syosetu.com` uses the official Narou API and returns metadata only — chapter text is not fetched.

## How to Import a Novel

1. Open the app and navigate to **Library → Import**.
2. Paste a novel URL from any supported site into the URL field.
3. Click **Preview** to fetch the chapter list and metadata without saving, or **Import** to add it to your library immediately.
4. Once the import job completes the novel appears in your library, ready for translation or reading.

You can also select specific chapters before importing — useful for large series where you only want a subset.

## Per-Site Notes

### FreeWebNovel (`freewebnovel.com`)

- URL format: `https://freewebnovel.com/novel/<slug>` — e.g. `https://freewebnovel.com/novel/solo-leveling`
- Chapter links are read from the `#idData` chapter list on the novel page.
- Chapter content is extracted from the `#article` element on each chapter page.
- No login required for public novels.

### NoBadNovel (`nobadnovel.com`)

- URL format: `https://www.nobadnovel.com/series/<slug>` — e.g. `https://www.nobadnovel.com/series/solo-leveling`
- Chapter links are read from `#chapter-list` on the series page.
- Chapter content is extracted from the element immediately after `h1` on each chapter page.
- No login required for public novels.

### NovelLunar (`novellunar.com`)

- URL format: `https://novellunar.com/novel/<slug>` — e.g. `https://novellunar.com/novel/solo-leveling`
- Chapter count is read from the novel page; chapters are numbered sequentially (`/chapter/1`, `/chapter/2`, …).
- Chapter content is extracted from `article > div`.
- No login required for public novels.

### Kakuyomu (`kakuyomu.jp`)

- URL format: `https://kakuyomu.jp/works/<numeric-id>`
- Metadata and chapter list are read from the embedded `__NEXT_DATA__` JSON on the work page.
- Kakuyomu content is **Japanese** and intended for personal use only. You must acknowledge the private-use flag when starting an import job.
- If a work requires a Kakuyomu account to read, you need to be logged in via the desktop (Electron) app — the web version cannot access login-gated content.

### ncode.syosetu (`ncode.syosetu.com`)

- URL format: `https://ncode.syosetu.com/<ncode>` — e.g. `https://ncode.syosetu.com/n4830bu`
- Only title, author, description, tags, and last-updated date are fetched via the Narou API. **No chapter text is imported.**
- Use this to bookmark a series and track updates without importing the full text.

## Rate Limits

Each source enforces a minimum delay between requests:

| Source | Minimum spacing |
| :----- | :-------------- |
| FreeWebNovel | 2 seconds |
| NoBadNovel | 2 seconds |
| NovelLunar | 2 seconds |
| Kakuyomu | 2 seconds |
| ncode.syosetu (API) | 1 second |

Large imports (100+ chapters) will take several minutes. The import panel shows live progress — you can navigate away and come back.

## Desktop vs Web

| Feature | Desktop (Electron) | Web |
| :------ | :----------------- | :-- |
| Scraping engine | Puppeteer + stealth plugin | HTTP proxy polling |
| Login-gated pages | ✅ Supported | ❌ Not supported |
| Public novel import | ✅ | ✅ |

For sites that serve bot-detection challenges, the desktop app is more reliable.

## Troubleshooting

**"Unsupported source" error**
The URL didn't match any known pattern. Double-check the URL format in the per-site notes above. Make sure you're using `https://` and the exact path prefix (`/novel/`, `/series/`, `/works/`, etc.).

**"Parse failed" error**
The site's HTML structure may have changed. Check for an app update. If the problem persists, open an issue with the URL (do not include login credentials).

**Import stalls or times out**
- Check your internet connection.
- For desktop: restart the app — the scraper session may have stalled.
- For web: the site may be rate-limiting your IP. Wait a few minutes and retry.
- Large novels (500+ chapters) can take 15–20 minutes. Leave the import panel open.

**Chapters import as blank / empty**
The chapter content selector may no longer match the site's layout. Open an issue with the chapter URL so the adapter can be updated.

**`challenge_detected` error**
The site returned a bot-detection page (Cloudflare, etc.). On desktop, make sure you are running the latest Electron build with the stealth plugin active. On web, this error is expected for heavily protected pages — use the desktop app instead.
