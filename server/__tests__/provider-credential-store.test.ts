import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database';
import { DataKey } from '../secret-store';
import { SQLiteProviderCredentialStore } from '../provider-credential-store';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SQLiteProviderCredentialStore', () => {
  it('keeps provider secrets encrypted while exposing only credential summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-provider-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const store = new SQLiteProviderCredentialStore(
      database,
      DataKey.parse(Buffer.alloc(32, 12).toString('base64')),
    );

    const summary = await store.upsert({
      provider: 'scrape-do',
      label: 'fixture provider',
      secret: 'fixture-secret-not-a-real-key',
      authorizedForUse: true,
      maxConcurrency: 1,
    });

    expect(await store.list()).toEqual([summary]);
    expect((await store.usable('scrape-do'))[0]).toMatchObject({ id: summary.id, secret: 'fixture-secret-not-a-real-key' });
    expect(
      database.query<{ body_json: string }, []>("SELECT body_json FROM state_documents WHERE namespace = 'import-provider-credentials'").get()?.body_json,
    ).not.toContain('fixture-secret-not-a-real-key');
    expect(database.query<{ ciphertext: Uint8Array }, []>('SELECT ciphertext FROM encrypted_secrets').get()?.ciphertext).not.toEqual(
      Buffer.from('fixture-secret-not-a-real-key'),
    );

    await store.recordCost(summary.id, 42);
    expect((await store.list())[0]).toMatchObject({ monthlyCostMicrosUsed: 42 });
    await store.disable(summary.id);
    expect(await store.usable('scrape-do')).toEqual([]);
    await store.remove(summary.id);
    expect(await store.list()).toEqual([]);
    database.close();
  });
});
