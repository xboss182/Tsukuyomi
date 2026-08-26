import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApplication } from '../app';
import { DataKey } from '../secret-store';

const paths: string[] = [];
const defaults = {
  translation: { enabled: true, temperature: 0.7 },
  proofreading: { enabled: true, temperature: 0.7 },
  termsTranslation: { enabled: true, temperature: 0.7 },
  assistant: { enabled: true, temperature: 0.7 },
};

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-ai-api-'));
  paths.push(directory);
  const app = createServerApplication({
    databasePath: join(directory, 'app.sqlite3'),
    version: 'test-version',
    commit: 'test-commit',
    dataKey: DataKey.parse(Buffer.alloc(32, 16).toString('base64')),
    aiGateway: {
      test: (modelId) => Promise.resolve({ model: modelId }),
      stream: async function* () {
        await Promise.resolve();
        yield { text: 'fixture output', done: false, model: 'fixture-model' };
        yield { text: '', done: true, model: 'fixture-model' };
      },
    },
  });
  await app.initialize();
  await app.auth.setInitialPassword('correct horse battery staple');
  const login = await app.fetch(
    new Request('https://novel.example/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://novel.example' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    }),
  );
  return { app, cookie: cookies(login), csrf: cookies(login).match(/__Host-tsukuyomi_csrf=([^;]+)/)?.[1] ?? '' };
}

describe('AI model API', () => {
  it('keeps model API keys write-only and streams server-owned generation', async () => {
    const { app, cookie, csrf } = await application();
    const headers = {
      cookie,
      origin: 'https://novel.example',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    };
    const created = await app.fetch(
      new Request('https://novel.example/api/v1/settings/ai-models', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'model-1',
          name: 'Fixture model',
          provider: 'openai',
          model: 'gpt-fixture',
          temperature: 0.7,
          maxInputTokens: 1000,
          maxOutputTokens: 500,
          apiKey: 'fixture-secret-not-a-real-key',
          baseUrl: 'https://api.openai.com/v1',
          isDefault: defaults,
          enabled: true,
          lastEdited: '2026-08-26T00:00:00.000Z',
        }),
      }),
    );
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.clone().json())).not.toContain('fixture-secret-not-a-real-key');

    const tested = await app.fetch(
      new Request('https://novel.example/api/v1/ai/models/model-1/test', { method: 'POST', headers, body: '{}' }),
    );
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ data: { model: 'model-1' } });

    const generated = await app.fetch(
      new Request('https://novel.example/api/v1/ai/models/model-1/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: 'Say hello.' }),
      }),
    );
    expect(generated.status).toBe(200);
    expect(generated.headers.get('content-type')).toContain('text/event-stream');
    const stream = await generated.text();
    expect(stream).toContain('event: chunk');
    expect(stream).toContain('fixture output');
    expect(stream).toContain('event: done');
    app.close();
  });
});

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
