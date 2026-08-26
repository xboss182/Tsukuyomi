import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database';
import { DataKey } from '../secret-store';
import { ServerSyncConfigStore } from '../sync-config-store';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ServerSyncConfigStore', () => {
  it('keeps the sync credential write-only while preserving non-secret state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-sync-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const store = new ServerSyncConfigStore(database, DataKey.parse(Buffer.alloc(32, 17).toString('base64')));

    const saved = store.upsert({
      id: 'sync-gist',
      enabled: true,
      lastSyncTime: 0,
      syncInterval: 300000,
      syncType: 'gist',
      syncParams: { username: 'fixture', gistId: 'abc' },
      apiEndpoint: 'https://api.github.com',
      secret: 'fixture-sync-secret-not-a-real-token',
    });

    expect(saved).toMatchObject({ id: 'sync-gist', hasSecret: true, syncParams: { username: 'fixture' } });
    expect(saved).not.toHaveProperty('secret');
    expect(JSON.stringify(saved)).not.toContain('fixture-sync-secret-not-a-real-token');
    expect(store.getSecret('sync-gist')).toBe('fixture-sync-secret-not-a-real-token');
    expect(
      database.query<{ body_json: string }, []>("SELECT body_json FROM state_documents WHERE namespace = 'sync-configs'").get()?.body_json,
    ).not.toContain('fixture-sync-secret-not-a-real-token');

    const retained = store.upsert({ ...saved, syncInterval: 600000 });
    expect(retained).toMatchObject({ syncInterval: 600000, hasSecret: true });
    store.delete('sync-gist');
    expect(store.list()).toEqual([]);
    expect(store.getSecret('sync-gist')).toBeUndefined();
    database.close();
  });

  it('rejects secret-bearing sync params and local endpoints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-sync-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const store = new ServerSyncConfigStore(database, DataKey.parse(Buffer.alloc(32, 18).toString('base64')));
    const input = {
      id: 'sync-gist',
      enabled: true,
      lastSyncTime: 0,
      syncInterval: 300000,
      syncType: 'gist' as const,
      apiEndpoint: 'https://api.github.com',
      secret: 'fixture',
    };

    expect(() => store.upsert({ ...input, syncParams: { token: 'leak' } })).toThrow();
    expect(() => store.upsert({ ...input, syncParams: {}, apiEndpoint: 'http://127.0.0.1' })).toThrow();
    database.close();
  });
});
