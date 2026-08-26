# Scraper: Setup, Operation, and Adapter Development

Tsukuyomi's scraper imports novels from supported websites into the local
library. It runs entirely inside the Electron desktop app — no external
servers, no OS schedulers, no credentials required for the scraper adapters.

## Installation

1. Clone the repository and install dependencies:

   ```bash
   git clone git@github.com:xboss182/Tsukuyomi.git
   cd Tsukuyomi
   bun install
   bun run setup:git-hooks   # register .githooks/pre-commit (required after first clone)
   ```

2. Launch the desktop app:

   ```bash
   bun run dev:electron      # development mode
   bun run build:electron    # production build
   ```

No `.env` configuration is required for the scraper. Provider API credentials
(for AI translation only, not the scraper) are stored encrypted via the OS
`safeStorage` API at runtime and are never written to disk in plaintext.

## Supported Sources

| Source key       | Website                    | Metadata | Chapter content | Rate limit    |
|------------------|----------------------------|----------|-----------------|---------------|
| `kakuyomu`       | kakuyomu.jp                | ✓        | ✓               | 2 s between requests |
| `narou-metadata` | ncode.syosetu.com (via API)| ✓        | —               | 1 s between requests |
| `nobadnovel`     | nobadnovel.com             | ✓        | ✓               | 2 s between requests |
| `freewebnovel`   | freewebnovel.com           | ✓        | ✓               | 2 s between requests |
| `novellunar`     | novellunar.com             | ✓        | ✓               | 2 s between requests |

**Known limitations:**

- `narou-metadata` (Narou/syosetu) fetches title, author, description, and
  tags from the official API only. Chapter body import is not supported for
  this source — it is metadata-only.
- `kakuyomu` is enabled for personal use only. The import UI requires an
  explicit acknowledgement before the job is created (`privateUseAcknowledged`
  flag). Attempting to create a Kakuyomu job without this flag returns a
  `policy_disallowed` error.
- All adapters require HTTPS and exact hostname matching. Subdomains are
  accepted only where the adapter explicitly allows them (`www.*`). IP
  addresses and private-network URLs are blocked by the address policy.
- Total body bytes per import job are capped at 64 MiB (`MAX_SUCCESSFUL_BODY_BYTES`).

## Importing a Novel

From the app's Books page, paste a supported URL into the import field. The
app validates the URL with `SourceRegistry.detect()` and creates an
`ImportJob`.

**Import modes:**

| Mode           | Behaviour |
|----------------|-----------|
| `preview`      | Fetches and displays metadata (title, author, chapter list) without writing to the library. |
| `import`       | Full import: discovers the table of contents, then fetches every chapter body. |
| `refresh`      | Re-fetches the table of contents and any new or changed chapters into an existing library entry. |
| `retry_failed` | Re-queues only the chapters that failed in a previous job and were marked retryable. |

## Import Job Lifecycle

Each import runs as a serial worker against a single IndexedDB database named
`tsukuyomi` (version 12). Only one job runs at a time.

```
queued → discovering → fetching → applying → completed
                                           → completed_with_errors
                                           → failed
                                           → cancelled
```

**Status meanings:**

- `queued` — job is waiting in the serial queue.
- `discovering` — fetching the table of contents (or API metadata for Narou).
- `fetching` — fetching individual chapter bodies one by one.
- `applying` — writing fetched content to IndexedDB.
- `completed` — all chapters succeeded.
- `completed_with_errors` — at least one chapter failed, others succeeded.
- `failed` — the discovery step or a fatal error stopped the whole job.
- `cancelled` — cancelled by the user before or during processing.

Each chapter within a job is an `ImportJobItem` with its own
`queued → fetching → applying → completed | failed | cancelled` lifecycle.

### Retry behaviour

The worker retries each fetch up to 3 attempts with exponential backoff
(capped at 30 s, randomised). Only errors with `retryable: true` are retried.
After 3 attempts the item is marked `failed`.

To retry failed items from the UI use Settings → Import Queue → Retry, or
call `ImportJobService.retryFailedItems(jobId)` programmatically. This creates
a new job in `retry_failed` mode containing only the retryable failed chapters.

### Idempotency

`createImportJob` is idempotent: if a job with the same `idempotencyKey`
already exists it is returned unchanged. A second import for the same source
work while an active job exists returns the active job instead of creating a
new one.

## Progress and Synchronisation

Job and item state is persisted in IndexedDB on every state transition — the
worker never holds progress only in memory. The renderer dispatches a
`tsukuyomi-import-library-changed` custom event on `window` after every write
to the `books` store so the UI can react.

Existing chapter translations are preserved across refresh and retry: when a
chapter's content hash is unchanged the stored paragraphs are kept as-is. When
content changes the new paragraphs are merged — any paragraph whose text
matches a previously translated paragraph inherits that translation.

## Scheduling and Rate Limits

The serial worker calls `waitForSourceSlot(sourceKey, minimumSpacingMs)` before
every network request. This enforces a per-host cooldown (see the table above)
regardless of concurrency. The worker does not start a new job while
`shuttingDown` is set.

## Health Checks

### Queue readiness

```typescript
const queue = await ImportJobService.runtimeStatus();
// {
//   ready: boolean,          // idle, recovery done, no interrupted jobs
//   workerRunning: boolean,
//   shuttingDown: boolean,
//   activeJobs: number,
//   interruptedJobs: number,
//   failedJobs: number,      // does NOT affect `ready`
//   completedJobs: number,
//   totalJobs: number,
// }
```

`ready` is `true` when the worker is idle, graceful shutdown has not started,
and no interrupted jobs are pending recovery. Individual job failures increment
`failedJobs` but leave `ready` true — the runtime is healthy, those specific
jobs failed.

### Main-process readiness

```typescript
const status = await window.electronAPI.importRuntimeStatus();
// status.mainProcess: {
//   appReady: boolean,
//   safeStorageAvailable: boolean,
//   gatewayReady: boolean,
//   puppeteerReady: boolean,
//   version: string,
//   timestamp: string,
//   recentEvents: DiagnosticEntry[],
// }
```

### Diagnostic log

A bounded ring buffer (`DiagnosticLog`, capacity 200) records sanitised events
in categories: `startup`, `recovery`, `fetch`, `provider`, `credentials`,
`cooldown`, `budget`, `shutdown`. No response bodies, credentials, or secrets
are stored. Read via `mainProcessDiagnostics.recent()` or the
`import-runtime-status` IPC response.

## Restart Recovery

On launch `ImportJobService.start()` calls `recoverInterruptedJobs()` before
accepting new work. Any job left in `discovering`, `fetching`, or `applying`
(the interrupted statuses) is reset to `queued` and re-processed.

On `before-quit` `ImportJobService.beginShutdown()` sets a flag that stops the
worker from starting new jobs. The currently running fetch completes and
persists its result; remaining queued jobs are recovered on next launch.

## Backup and Restore

From **Settings → Import/Export** or programmatically:

```typescript
import { ImportLibraryBackupService } from 'src/services/importer/import-library-backup-service';

// Export
const backup = await ImportLibraryBackupService.createBackup();
const json = JSON.stringify(backup, null, 2);
// Write `json` to a file — this is your backup.

// Restore
const backup = ImportLibraryBackupService.parseJson(json);
await ImportLibraryBackupService.restoreBackup(backup);
```

The backup file contains:

- `version`: `1`
- `exportedAt`: ISO timestamp
- `books`: all `Novel` records
- `chapterContents`: all chapter body records
- `jobs`: all `ImportJob` records
- `jobItems`: all `ImportJobItem` records

Restore validates the entire payload before touching the database. A malformed
backup throws and leaves existing data intact. The restore write is a single
atomic IndexedDB transaction across all four stores.

No credentials are included in the backup.

## Scraping Providers (API Keys)

Some sites require routing requests through a third-party scraping provider to bypass bot-detection. FreeWebNovel always uses this path; NoBadNovel and NovelLunar fall back to it when a direct request is blocked.

See **[docs/PROVIDERS.md](PROVIDERS.md)** for the full guide: supported providers (Scrape.do, ScrapingAnt, ZenRows, Zyte), how to add API keys in Settings, cost tracking, and troubleshooting.

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| Import UI disabled, "desktop only" message | `window.electronAPI` not available | Run the Electron build (`bun run dev:electron`), not the web SPA |
| `policy_disallowed` on Kakuyomu import | Missing personal-use acknowledgement | Check the acknowledgement checkbox in the import dialog |
| `unsupported_source` | URL not matched by any adapter | Verify the URL matches a supported hostname exactly (see table above) |
| Job stuck in `discovering` after restart | App closed mid-discovery | Recovery resets it to `queued` automatically on next launch |
| `job_body_limit_exceeded` | Total body bytes for the job exceeded 64 MiB | Split the import into smaller batches using `selectedRemoteChapterIds` |
| Chapter body empty / `parse_failed` | Site HTML structure changed | The adapter's CSS selector may need updating (see Adapter Development below) |
| AI features disabled after restart | `safeStorage` unavailable (headless or missing keyring) | Credentials cannot be decrypted in this environment; scraper import still works |

## Adapter Development

An adapter is a plain object implementing `SourceAdapter`
(`src/services/importer/source-registry.ts`).

### Interface

```typescript
interface SourceAdapter {
  readonly key: SourceKey;                              // unique string key
  readonly capabilities: ReadonlySet<'metadata' | 'chapter-content'>;
  readonly allowedHosts: ReadonlySet<string>;           // exact hostnames allowed
  readonly minimumSpacingMs: number;                    // per-host cooldown
  readonly parserVersion: string;                       // bump on breaking parser changes

  detect(input: URL): SourceIdentity | null;
  discover(source: SourceIdentity, html: string, checkedAt: string): RemoteWorkSnapshot;
  parseChapter?(source: RemoteChapterStub, html: string): Promise<RemoteChapterBody>;
}
```

- `detect` — given a `URL`, return a `SourceIdentity` (keys + canonical work
  URL) or `null` if the URL is not for this source. Use exact hostname
  matching; never substring-match the full URL string.
- `discover` — parse the work's table-of-contents page (or API response) into
  a `RemoteWorkSnapshot`. Throw a `StructuredImportError` with
  `code: 'parse_failed'` on unrecoverable parse failures.
- `parseChapter` — parse a chapter page into a `RemoteChapterBody` (array of
  paragraph strings + content hash + parser version). Omit this method for
  metadata-only adapters.

### Minimal example

```typescript
import { hashString } from 'src/utils/content-hash';
import * as cheerio from 'cheerio';
import type { SourceAdapter, SourceIdentity, RemoteChapterStub } from './types';

const MY_HOSTS = new Set(['example-novels.com', 'www.example-novels.com']);

const exampleAdapter: SourceAdapter = {
  key: 'example',          // add to SourceKey union in src/models/importer.ts
  capabilities: new Set(['metadata', 'chapter-content']),
  allowedHosts: MY_HOSTS,
  minimumSpacingMs: 2000,
  parserVersion: 'example-v1',

  detect(input) {
    if (input.protocol !== 'https:' || !MY_HOSTS.has(input.hostname)) return null;
    const match = input.pathname.match(/^\/novel\/([a-z0-9-]+)/i);
    if (!match?.[1]) return null;
    const remoteWorkId = match[1].toLowerCase();
    return {
      sourceKey: 'example',
      remoteWorkId,
      canonicalWorkUrl: `https://example-novels.com/novel/${remoteWorkId}`,
    };
  },

  discover(source, html) {
    const $ = cheerio.load(html);
    const title = $('h1').first().text().trim();
    if (!title) throw new StructuredImportError({ code: 'parse_failed', message: 'No title', retryable: false });
    const chapters = $('a.chapter-link').map((i, el): RemoteChapterStub => ({
      ...source,
      remoteChapterId: $(el).attr('data-id') ?? String(i),
      canonicalChapterUrl: new URL($(el).attr('href') ?? '', source.canonicalWorkUrl).href,
      title: $(el).text().trim(),
      volume: { remoteVolumeId: 'main', title: 'Main', sequence: 0 },
      sequence: i,
    })).get();
    return { source, title, volumes: [{ remoteVolumeId: 'main', title: 'Main', sequence: 0 }], chapters, metadataOnly: false };
  },

  async parseChapter(_source, html) {
    const $ = cheerio.load(html);
    const root = $('#chapter-content').first();
    root.find('script,style,nav').remove();
    const paragraphs = root.find('p').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    if (paragraphs.length === 0) throw new StructuredImportError({ code: 'parse_failed', message: 'Empty chapter', retryable: false });
    return { paragraphs, contentHash: await hashString(paragraphs.join('\n\n')), parserVersion: 'example-v1' };
  },
};
```

### Registration

1. Add the new key to the `SourceKey` union in `src/models/importer.ts`.
2. Add the adapter instance to the `adapters` array at the bottom of
   `src/services/importer/source-registry.ts`.
3. Add the hostname to `allowedHosts` and verify the address policy in
   `src/services/importer/address-policy.ts` does not block it (private-range
   IPs and non-public addresses are always rejected).

### Validation and testing

Capture a real work-index HTML page and a chapter HTML page, save them as
fixtures under `src/__tests__/examplePages/`, then write a test:

```typescript
// src/__tests__/example-scraper.test.ts
import { describe, it, expect } from 'bun:test';
import './setup';
import fs from 'node:fs';
import path from 'node:path';
import { SourceRegistry } from '../services/importer/source-registry';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'examplePages', name), 'utf-8');

describe('example adapter', () => {
  const source = SourceRegistry.detect('https://example-novels.com/novel/my-novel')!;

  it('detects the URL', () => {
    expect(source).not.toBeNull();
    expect(source?.sourceKey).toBe('example');
    expect(source?.remoteWorkId).toBe('my-novel');
  });

  it('discovers the table of contents', () => {
    const adapter = SourceRegistry.get('example');
    const snapshot = adapter.discover(source, fixture('example-work.html'), new Date().toISOString());
    expect(snapshot.title).toBeTruthy();
    expect(snapshot.chapters.length).toBeGreaterThan(0);
  });

  it('parses a chapter', async () => {
    const adapter = SourceRegistry.get('example');
    const stub = { ...source, remoteChapterId: '1', canonicalChapterUrl: '...', title: 'Ch 1',
                   volume: { remoteVolumeId: 'main', title: 'Main', sequence: 0 }, sequence: 0 };
    const body = await adapter.parseChapter!(stub, fixture('example-chapter.html'));
    expect(body.paragraphs.length).toBeGreaterThan(0);
    expect(body.contentHash).toBeTruthy();
  });
});
```

Run with:

```bash
bun test src/__tests__/example-scraper.test.ts
```

**Security requirements for new adapters:**

- `detect` must validate `input.protocol === 'https:'` and check
  `input.hostname` against `allowedHosts` exactly — never substring-match the
  full URL string (CodeQL JS "incomplete URL substring sanitization").
- `allowedHosts` must list only public, externally-facing hostnames. Private
  IPs and internal hosts are blocked upstream by the address policy and will
  cause the job to fail with `unsafe_address`.
- `parseChapter` must strip `<script>`, `<style>`, `<noscript>`, `<iframe>`,
  `<form>`, `<nav>`, `<header>`, and `<footer>` from the content element before
  extracting paragraphs — never pass raw HTML to the library.
- Bump `parserVersion` (e.g. `example-v2`) whenever the paragraph-extraction
  logic changes so that existing chapters are correctly re-fetched on refresh.
