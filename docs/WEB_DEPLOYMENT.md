# Private web deployment

Tsukuyomi's web server is a single Bun process intended for a private, single-user deployment behind Caddy. It binds only to `127.0.0.1` or `::1`; Caddy remains the public TLS endpoint.

## Required runtime environment

Create a root-owned runtime environment file outside the repository:

```text
HOST=127.0.0.1
PORT=3010
TSUKUYOMI_ORIGIN=https://novel.shieldme.cc
TSUKUYOMI_DATABASE_PATH=/var/lib/tsukuyomi/app.sqlite3
TSUKUYOMI_DATA_KEY=<base64 for exactly 32 random bytes>
TSUKUYOMI_COMMIT=<deployed git SHA>
```

`TSUKUYOMI_DATA_KEY` encrypts provider and AI-model credentials using AES-256-GCM. The service refuses to start without it. Do not reuse it casually: rotation requires decrypting/re-encrypting stored secrets or re-entering credentials.

Bootstrap the one account from an interactive local terminal:

```bash
TSUKUYOMI_DATABASE_PATH=/var/lib/tsukuyomi/app.sqlite3 bun run admin:set-password
```

Emergency reset revokes all browser sessions:

```bash
TSUKUYOMI_DATABASE_PATH=/var/lib/tsukuyomi/app.sqlite3 bun run admin:reset-password
```

## Commands

```bash
bun run migrate
bun run start
TSUKUYOMI_BACKUP_PATH=/var/backups/tsukuyomi/app.sqlite3 bun run backup
```

The server provides unauthenticated `/healthz` and `/readyz`. Readiness becomes healthy only after SQLite migrations and interrupted-job recovery. A failed historical scraper job does not make the service unready.

Protected state-changing endpoints require an authenticated `__Host-tsukuyomi_session` cookie, an exact same-origin `Origin`, and double-submit `__Host-tsukuyomi_csrf` / `X-CSRF-Token` values. There is no CORS configuration and no unauthenticated bootstrap/reset endpoint.

## Caddy contract

Serve the SPA from the release directory and reverse proxy only `/api/*` to the loopback server. SSE routes must preserve immediate flushing and response headers:

```caddyfile
reverse_proxy 127.0.0.1:3010 {
  flush_interval -1
  transport http {
    read_timeout 0
    write_timeout 0
  }
}
```

Do not cache or transform `/api/*`, including SSE. The application emits `Cache-Control: no-store, no-transform`.

## Backup and recovery

`bun run backup` checkpoints WAL, verifies `PRAGMA integrity_check`, atomically writes a mode-`0600` snapshot, and reports its SHA-256. Keep backups outside the release directory.

A restore candidate is validated before it replaces a production database. Pause the service before an operator-approved destructive swap, retain the previous verified database, then restart and verify `/readyz`.

Library import is separately supported through authenticated `web-library-backup-v2` endpoints. It validates all records before replacement and deliberately excludes sessions, CSRF values, encrypted secrets, provider credentials, AI API keys, sync secrets, raw remote content, and diagnostics.

## Deployment checks

```bash
bun run type-check
bun test server
bun run build:spa
curl --fail http://127.0.0.1:3010/healthz
curl --fail http://127.0.0.1:3010/readyz
```

Verify the public HTTPS hostname independently after Caddy and Cloudflare are configured. The origin application port must not be public.

Skipped: systemd/Caddy/Cloudflare files stay owned by the deployment issue; add them when Stage 3 is promoted.
