import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApplication } from '../app';

const paths: string[] = [];

async function createApplication() {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-server-'));
  paths.push(directory);
  const app = createServerApplication({
    databasePath: join(directory, 'app.sqlite3'),
    version: 'test-version',
    commit: 'test-commit',
    worker: { fetch: () => Promise.resolve({ ok: false, error: { code: 'network_error', message: 'fixture', retryable: false } }) },
  });
  await app.initialize();
  return app;
}

async function request(app: Awaited<ReturnType<typeof createApplication>>, path: string, init?: RequestInit) {
  return app.fetch(new Request(`https://novel.example${path}`, init));
}

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

describe('server application', () => {
  it('rejects an overlong path identifier before authentication', async () => {
    const app = await createApplication();

    const response = await request(app, `/api/v1/library/books/${'a'.repeat(129)}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    app.close();
  });

  it('reports liveness/readiness and denies protected data without a session', async () => {
    const app = await createApplication();

    expect(await (await request(app, '/healthz')).json()).toEqual({
      status: 'ok',
      version: 'test-version',
      commit: 'test-commit',
    });
    expect((await request(app, '/readyz')).status).toBe(200);
    expect((await request(app, '/api/v1/library/books')).status).toBe(401);
    expect((await request(app, '/api/v1/import-jobs/test/events')).status).toBe(401);
    app.close();
  });

  it('rejects an oversized body before buffering it', async () => {
    const app = await createApplication();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });
    const response = await app.fetch(
      new Request('https://novel.example/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://novel.example' },
        body: oversized,
        // Bun supports streaming request bodies; lib.dom's RequestInit omits duplex.
        ...( { duplex: 'half' } as unknown as RequestInit ),
      }),
    );
    expect(response.status).toBe(413);
    app.close();
  });

  it('requires origin and double-submit CSRF for mutations', async () => {
    const app = await createApplication();
    await app.auth.setInitialPassword('correct horse battery staple');
    const login = await request(app, '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://novel.example' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    const cookie = cookies(login);
    const csrf = cookie.match(/__Host-tsukuyomi_csrf=([^;]+)/)?.[1];
    expect(login.status).toBe(200);
    expect(csrf).toEqual(expect.any(String));

    const rejected = await request(app, '/api/v1/library/books', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://novel.example' },
      body: JSON.stringify({ book: { id: 'book', title: 'Book' } }),
    });
    expect(rejected.status).toBe(403);

    const forged = await request(app, '/api/v1/library/books', {
      method: 'POST',
      headers: {
        cookie: `${cookie}; __Host-tsukuyomi_csrf=forged`,
        'content-type': 'application/json',
        origin: 'https://novel.example',
        'x-csrf-token': 'forged',
      },
      body: JSON.stringify({
        book: {
          id: 'forged-book',
          title: 'Forged book',
          createdAt: '2026-08-26T00:00:00.000Z',
          lastEdited: '2026-08-26T00:00:00.000Z',
        },
      }),
    });
    expect(forged.status).toBe(403);

    const accepted = await request(app, '/api/v1/library/books', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: 'https://novel.example',
        'x-csrf-token': csrf ?? '',
      },
      body: JSON.stringify({
        book: {
          id: 'book',
          title: 'Book',
          createdAt: '2026-08-26T00:00:00.000Z',
          lastEdited: '2026-08-26T00:00:00.000Z',
        },
      }),
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ data: { revision: 1 } });
    app.close();
  });
});

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
