import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDatabaseReady, openDatabase } from '../database';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('openDatabase', () => {
  it('migrates an empty database with the required durable constraints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-server-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));

    try {
      expect(
        database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check,
      ).toBe('ok');
      expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM schema_migrations').get()?.count).toBe(1);
      expect(() =>
        database.exec(
          "INSERT INTO books (id, body_json, created_at, last_edited, revision) VALUES ('book', 'not-json', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z', 1)",
        ),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});

describe('isDatabaseReady', () => {
  it('requires an ok integrity result and treats database errors as not ready', () => {
    const corrupt = { query: () => ({ get: () => ({ integrity_check: 'corrupt' }) }) };
    const unavailable = { query: () => { throw new Error('database is closed'); } };

    expect(isDatabaseReady(corrupt as never)).toBeFalse();
    expect(isDatabaseReady(unavailable as never)).toBeFalse();
  });
});
