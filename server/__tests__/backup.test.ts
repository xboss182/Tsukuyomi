import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseBackup, restoreDatabaseBackup } from '../backup';
import { openDatabase } from '../database';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SQLite backup', () => {
  it('creates a verified snapshot and restores it without exposing database rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-backup-'));
    paths.push(directory);
    const databasePath = join(directory, 'app.sqlite3');
    const backupPath = join(directory, 'backup.sqlite3');
    const restorePath = join(directory, 'restore.sqlite3');
    const database = openDatabase(databasePath);
    database.exec("INSERT INTO state_documents (namespace, document_key, body_json, revision, updated_at) VALUES ('test', 'record', '{}', 1, '2026-08-26T00:00:00.000Z')");

    const backup = await createDatabaseBackup(database, backupPath);
    database.close();

    expect(backup.integrityCheck).toBe('ok');
    expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(backupPath)).byteLength).toBeGreaterThan(0);

    await restoreDatabaseBackup(backupPath, restorePath);
    const restored = openDatabase(restorePath);
    expect(restored.query<{ count: number }, []>("SELECT count(*) AS count FROM state_documents WHERE namespace = 'test'").get()?.count).toBe(1);
    restored.close();
  });
});
