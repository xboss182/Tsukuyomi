# Operational Guide: Import Queue & Scraper Runtime

Single-user Electron deployment of the Tsukuyomi scraper/import runtime. Covers
non-secret configuration, restart recovery, manual backup/restore, and local
diagnostics. No credentials, API keys, or secrets are documented here.

## Configuration (non-secret)

All configuration is local to the Electron app's `userData` directory. No
external services, Redis, OS scheduler, or public HTTP listener are used.

### Provider credentials (encrypted)

Provider API credentials (for the AI translation gateway, not the scraper
adapters) are stored encrypted in:

```
<userData>/provider-credentials.json
```

Encryption uses the OS `safeStorage` API (macOS Keychain, Windows DPAPI, Linux
libsecret/keyring). The credential vault is initialized at startup. If
`safeStorage` is unavailable (headless environments, missing keyring), provider
features are disabled — the app still runs, but AI translation is unavailable.

No plaintext credentials are ever written to disk, logs, exports, or commits.

### Scraper adapters (no credentials required)

The implemented adapters — NoBadNovel, FreeWebNovel, NovelLunar, Kakuyomu,
Narou — do not store credentials. They use per-host cooldowns and the embedded
serial queue to respect rate limits. No configuration is needed for these.

### Local IndexedDB

All library data, chapter content, import jobs, and job items live in a single
IndexedDB database named `tsukuyomi` (version 12). This is managed by the
renderer process. No external database server is used.

## Startup sequence

On launch, the Electron main process:

1. Initializes `puppeteer-in-electron` (for headless page rendering in adapters
   that need it).
2. Logs `startup` diagnostics to the in-memory ring buffer.
3. Initializes the credential vault (if `safeStorage` is available).
4. Initializes the provider gateway (scraper + AI).
5. Opens the renderer window, which loads the SPA.

The renderer process opens IndexedDB and calls `ImportJobService.start()`,
which runs `recoverInterruptedJobs()` before accepting new work.

## Restart recovery

### Interrupted jobs

If the app is closed while a job is mid-fetch (status `fetching`), that job
is left in the `fetching` state in IndexedDB. On next launch:

1. `ImportJobService.start()` calls `recoverInterruptedJobs()`.
2. Any job in an interrupted status (`fetching`, `pending_fetch`) is reset to
   `queued`.
3. The serial worker picks them up in order.

This is verified by the test `interrupted jobs make the queue not ready until
recovery requeues them` in `import-operational-controls.test.ts`.

### Graceful shutdown drain

On `before-quit`, the main process calls `ImportJobService.beginShutdown()`:

1. Sets a `shuttingDown` flag that stops `scheduleNextImportJob` from starting
   new jobs.
2. The currently running fetch completes and persists its result.
3. The process exits. Any remaining queued jobs are persisted and will run on
   next launch via recovery.

This is verified by the test `beginShutdown returns the active worker promise
and prevents new jobs` in `import-operational-controls.test.ts`.

## Manual backup and restore

The `ImportLibraryBackupService` exports and imports the full library state
in a single JSON file. No credentials are included.

### Export (backup)

From the app's Settings → Import/Export tab, or programmatically:

```typescript
import { ImportLibraryBackupService } from 'src/services/importer/import-library-backup-service';

const backup = await ImportLibraryBackupService.createBackup();
const json = JSON.stringify(backup, null, 2);
// Write `json` to a file — this is your manual backup.
```

The backup contains:
- `version`: 1
- `exportedAt`: ISO timestamp
- `books`: all `Novel` records
- `chapterContents`: all chapter body records
- `jobs`: all `ImportJob` records
- `jobItems`: all `ImportJobItem` records

### Restore (import)

```typescript
const json = fs.readFileSync('backup.json', 'utf-8');
const backup = ImportLibraryBackupService.parseJson(json);
await ImportLibraryBackupService.restoreBackup(backup);
```

Restore validates the entire backup before clearing any existing data. A
malformed backup throws before touching the database — existing data is
preserved. The restore uses a single IndexedDB transaction across all four
stores, so it is atomic.

This is verified by the tests in `import-library-backup.test.ts`:
- `round-trips the library, chapter bodies, and both import job stores`
- `rejects malformed input before clearing existing data`
- `invalidates cached chapter bodies after restore`

## Local diagnostics

### Health/readiness IPC

The `import-runtime-status` IPC returns a main-process readiness snapshot:

```typescript
const status = await window.electronAPI.importRuntimeStatus();
// status.mainProcess: {
//   appReady: boolean,
//   safeStorageAvailable: boolean,
//   gatewayReady: boolean,
//   puppeteerReady: boolean,
//   version: string,
//   timestamp: string,
//   recentEvents: DiagnosticEntry[]
// }
// status.queue: null (renderer queries ImportJobService.runtimeStatus() directly)
```

The renderer can also call `ImportJobService.runtimeStatus()` directly for
queue-level readiness:

```typescript
const queue = await ImportJobService.runtimeStatus();
// queue: {
//   ready: boolean,           // worker idle, recovery done, no interrupted jobs
//   workerRunning: boolean,
//   shuttingDown: boolean,
//   activeJobs: number,
//   interruptedJobs: number,
//   failedJobs: number,       // individual failures — does NOT affect `ready`
//   completedJobs: number,
//   totalJobs: number,
// }
```

`ready` distinguishes runtime readiness from individual job failures: a failed
job increments `failedJobs` but `ready` stays `true` (the runtime is healthy,
that specific job failed).

No public network listener is used. Diagnostics are local IPC only.

### Diagnostic log

A bounded ring buffer (`DiagnosticLog`, cap 200 entries) records sanitized
startup, provider, credential, fetch, cooldown, budget, and shutdown events.
No response bodies, credentials, or secrets are stored — messages carry only
structured labels.

Entries are available via `mainProcessDiagnostics.recent()` and surfaced in the
`import-runtime-status` IPC response.

## Verification commands

```bash
# Run fixture/mock-only tests (no live third-party requests)
bun test src/__tests__/import-library-backup.test.ts
bun test src/__tests__/import-operational-controls.test.ts

# Full test suite
bun test

# Lint + type-check + quality gates
bun run lint
bun run type-check
bun run quality-check

# Build
bun run build:spa
bun run build:electron
```
