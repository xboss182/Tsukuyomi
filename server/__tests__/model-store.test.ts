import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database';
import { DataKey } from '../secret-store';
import { ServerModelStore } from '../model-store';

const paths: string[] = [];

const defaults = {
  translation: { enabled: true, temperature: 0.7 },
  proofreading: { enabled: true, temperature: 0.7 },
  termsTranslation: { enabled: true, temperature: 0.7 },
  assistant: { enabled: true, temperature: 0.7 },
};

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ServerModelStore', () => {
  it('stores AI credentials encrypted and returns a redacted model DTO', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-model-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const store = new ServerModelStore(database, DataKey.parse(Buffer.alloc(32, 14).toString('base64')));

    const saved = store.upsert({
      id: 'model-1',
      name: 'Fixture model',
      provider: 'openai',
      model: 'gpt-fixture',
      temperature: 0.7,
      maxInputTokens: 1000,
      maxOutputTokens: 500,
      baseUrl: 'https://api.openai.com/v1',
      isDefault: defaults,
      enabled: true,
      apiKey: 'fixture-model-secret-not-a-real-key',
      lastEdited: '2026-08-26T00:00:00.000Z',
    });

    expect(saved).toMatchObject({ id: 'model-1', hasApiKey: true });
    expect(saved).not.toHaveProperty('apiKey');
    expect(JSON.stringify(saved)).not.toContain('fixture-model-secret-not-a-real-key');
    expect(store.getSecret('model-1')).toBe('fixture-model-secret-not-a-real-key');
    expect(
      database.query<{ body_json: string }, []>("SELECT body_json FROM state_documents WHERE namespace = 'ai-models'").get()?.body_json,
    ).not.toContain('fixture-model-secret-not-a-real-key');

    const retained = store.upsert({ ...saved, name: 'Renamed fixture model' });
    expect(retained).toMatchObject({ name: 'Renamed fixture model', hasApiKey: true });
    store.delete('model-1');
    expect(store.get('model-1')).toBeUndefined();
    expect(store.getSecret('model-1')).toBeUndefined();
    database.close();
  });

  it('rejects insecure model base URLs and untrusted custom secret headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-model-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const store = new ServerModelStore(database, DataKey.parse(Buffer.alloc(32, 15).toString('base64')));
    const input = {
      id: 'model-1',
      name: 'Fixture model',
      provider: 'openai' as const,
      model: 'gpt-fixture',
      temperature: 0.7,
      maxInputTokens: 1000,
      maxOutputTokens: 500,
      isDefault: defaults,
      enabled: true,
      apiKey: 'fixture-model-secret-not-a-real-key',
      lastEdited: '2026-08-26T00:00:00.000Z',
    };

    expect(() => store.upsert({ ...input, baseUrl: 'http://127.0.0.1:3010/v1' })).toThrow();
    expect(() =>
      store.upsert({ ...input, baseUrl: 'https://api.openai.com/v1', customHeaders: { Authorization: 'secret' } }),
    ).toThrow();
    database.close();
  });
});
