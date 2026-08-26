import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApplication } from '../app';
import { DataKey } from '../secret-store';

const paths: string[] = [];

function cookie(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-provider-api-'));
  paths.push(directory);
  const app = createServerApplication({
    databasePath: join(directory, 'app.sqlite3'),
    version: 'test-version',
    commit: 'test-commit',
    dataKey: DataKey.parse(Buffer.alloc(32, 13).toString('base64')),
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
  const sessionCookie = cookie(login);
  const csrfToken = sessionCookie.match(/__Host-tsukuyomi_csrf=([^;]+)/)?.[1] ?? '';
  return { app, sessionCookie, csrfToken };
}

describe('provider credential API', () => {
  it('stores a write-only provider secret and returns only its summary', async () => {
    const { app, sessionCookie, csrfToken } = await application();
    const headers = {
      cookie: sessionCookie,
      origin: 'https://novel.example',
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    };
    const created = await app.fetch(
      new Request('https://novel.example/api/v1/settings/import-providers', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: 'scrape-do',
          label: 'fixture provider',
          secret: 'fixture-secret-not-a-real-key',
          authorizedForUse: true,
          maxConcurrency: 1,
        }),
      }),
    );

    expect(created.status).toBe(201);
    const payload = (await created.json()) as { data: { id: string; secret?: string } };
    expect(payload.data.id).toEqual(expect.any(String));
    expect(payload.data).not.toHaveProperty('secret');
    expect(JSON.stringify(payload)).not.toContain('fixture-secret-not-a-real-key');

    const listed = await app.fetch(
      new Request('https://novel.example/api/v1/settings/import-providers', { headers: { cookie: sessionCookie } }),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ data: { items: [{ id: payload.data.id }] } });
    app.close();
  });
});

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
