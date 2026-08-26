import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

export const ACTIVE_JOB_STATUSES = ['queued', 'discovering', 'fetching', 'applying'] as const;

type Migration = {
  version: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_web_storage',
    sql: `
      CREATE TABLE books (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
        body_json TEXT NOT NULL CHECK(json_valid(body_json)),
        source_key TEXT,
        remote_work_id TEXT,
        canonical_work_url TEXT,
        created_at TEXT NOT NULL,
        last_edited TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT;
      CREATE UNIQUE INDEX books_source_identity_unique
        ON books(source_key, remote_work_id)
        WHERE source_key IS NOT NULL AND remote_work_id IS NOT NULL;
      CREATE INDEX books_last_edited ON books(last_edited DESC, id DESC);

      CREATE TABLE chapter_contents (
        chapter_id TEXT PRIMARY KEY CHECK(length(chapter_id) BETWEEN 1 AND 128),
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        paragraphs_json TEXT NOT NULL CHECK(json_valid(paragraphs_json)),
        last_modified TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT;
      CREATE INDEX chapter_contents_book_id ON chapter_contents(book_id, chapter_id);

      CREATE TABLE memories (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        body_json TEXT NOT NULL CHECK(json_valid(body_json)),
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT;
      CREATE INDEX memories_book_accessed ON memories(book_id, last_accessed_at DESC, id DESC);

      CREATE TABLE state_documents (
        namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 128),
        document_key TEXT NOT NULL CHECK(length(document_key) BETWEEN 1 AND 128),
        body_json TEXT NOT NULL CHECK(json_valid(body_json)),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(namespace, document_key)
      ) STRICT;

      CREATE TABLE encrypted_secrets (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
        kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 128),
        ciphertext BLOB NOT NULL,
        nonce BLOB NOT NULL CHECK(length(nonce) = 12),
        auth_tag BLOB NOT NULL CHECK(length(auth_tag) = 16),
        key_version INTEGER NOT NULL CHECK(key_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
        body_json TEXT NOT NULL CHECK(json_valid(body_json)),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 256),
        source_work_key TEXT NOT NULL CHECK(length(source_work_key) BETWEEN 1 AND 256),
        source_key TEXT NOT NULL,
        remote_work_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT;
      CREATE INDEX import_jobs_created_at ON import_jobs(created_at DESC, id DESC);
      CREATE INDEX import_jobs_source_work ON import_jobs(source_work_key, created_at DESC);
      CREATE UNIQUE INDEX import_jobs_one_active_source
        ON import_jobs(source_work_key)
        WHERE status IN ('queued', 'discovering', 'fetching', 'applying');

      CREATE TABLE import_job_items (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 192),
        job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        body_json TEXT NOT NULL CHECK(json_valid(body_json)),
        remote_chapter_id TEXT NOT NULL,
        source_chapter_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, remote_chapter_id)
      ) STRICT;
      CREATE INDEX import_job_items_job_status ON import_job_items(job_id, status, id);
      CREATE INDEX import_job_items_source_chapter ON import_job_items(source_chapter_key);

      CREATE TABLE job_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_name TEXT NOT NULL CHECK(event_name IN ('job', 'item', 'terminal', 'reset')),
        data_json TEXT NOT NULL CHECK(json_valid(data_json)),
        created_at TEXT NOT NULL,
        UNIQUE(job_id, sequence)
      ) STRICT;
      CREATE INDEX job_events_replay ON job_events(job_id, event_id);
      CREATE INDEX job_events_retention ON job_events(created_at);

      CREATE TABLE auth_account (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        password_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
        csrf_hash TEXT NOT NULL CHECK(length(csrf_hash) = 64),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX sessions_expiry ON sessions(expires_at);

      CREATE TABLE login_throttle (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        window_started_at TEXT NOT NULL,
        failed_attempts INTEGER NOT NULL CHECK(failed_attempts >= 0),
        locked_until TEXT
      ) STRICT;
    `,
  },
];

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function rollback(database: Database): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // No transaction was opened or SQLite already rolled it back.
  }
}

export function migrateDatabase(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const existingRows = database
    .query('SELECT version, checksum FROM schema_migrations')
    .all() as Array<{ version: number; checksum: string }>;
  const existing = new Map(existingRows.map((row) => [row.version, row.checksum]));

  for (const migration of migrations) {
    const migrationChecksum = checksum(migration.sql);
    const appliedChecksum = existing.get(migration.version);
    if (appliedChecksum) {
      if (appliedChecksum !== migrationChecksum) {
        throw new Error(`数据库迁移校验失败: ${migration.name}`);
      }
      continue;
    }

    try {
      database.exec('BEGIN IMMEDIATE');
      database.exec(migration.sql);
      database
        .query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, migrationChecksum, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      rollback(database);
      throw error;
    }
  }
}

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const database = new Database(path);
  try {
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function isDatabaseReady(database: Database): boolean {
  try {
    const result = database.query<{ integrity_check?: unknown }, []>('PRAGMA integrity_check').get();
    return result?.integrity_check === 'ok';
  } catch {
    return false;
  }
}

export function cleanExpiredJobEvents(database: Database, before: string): void {
  database.query('DELETE FROM job_events WHERE created_at < ?').run(before);
}
