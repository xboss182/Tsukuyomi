import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApplication } from '../app';

const paths: string[] = [];
const workUrl = 'https://kakuyomu.jp/works/822139842947212336';

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
): Promise<{ done: boolean; text: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('SSE timed out')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return { done: result.done, text: new TextDecoder().decode(result.value) };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
  timeoutMs = 2_000,
): Promise<string> {
  let text = '';
  while (!text.includes(expected)) {
    const chunk = await readChunk(reader, timeoutMs);
    text += chunk.text;
    if (chunk.done) throw new Error(`SSE closed before ${expected}`);
  }
  return text;
}

async function application(options: { now?: () => number; pollMs?: number; heartbeatMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-sse-'));
  paths.push(directory);
  const app = createServerApplication({
    databasePath: join(directory, 'app.sqlite3'),
    version: 'test-version',
    commit: 'test-commit',
    worker: { fetch: () => Promise.resolve({ ok: false, error: { code: 'network_error', message: 'fixture', retryable: false } }) },
    ...(options.now ? { authClock: { now: options.now } } : {}),
    ...(options.pollMs ? { ssePollIntervalMs: options.pollMs } : {}),
    ...(options.heartbeatMs ? { sseHeartbeatMs: options.heartbeatMs } : {}),
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
  return { app, cookie: cookies(login) };
}

function queuedJob(app: Awaited<ReturnType<typeof application>>['app']) {
  return app.imports.create({
    url: workUrl,
    mode: 'import',
    idempotencyKey: `sse-${crypto.randomUUID()}`,
    privateUseAcknowledged: true,
  }).job;
}

describe('import job SSE', () => {
  it('authenticates, snapshots, replays, and promptly closes on terminal events', async () => {
    const { app, cookie } = await application();
    const job = queuedJob(app);
    const response = await app.fetch(
      new Request(`https://novel.example/api/v1/import-jobs/${job.id}/events`, { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE body missing');
    const initial = await readChunk(reader);
    expect(initial.text).toContain('event: snapshot');

    app.imports.setJobStatus(job.id, { status: 'failed', completedAt: '2026-08-26T00:00:00.000Z' });
    const terminal = await readUntil(reader, 'event: terminal');
    expect(terminal).toContain('event: terminal');
    expect((await readChunk(reader)).done).toBe(true);
    app.close();
  });

  it('lets Last-Event-ID override after and resets a stale cursor', async () => {
    const { app, cookie } = await application();
    const job = queuedJob(app);
    const replay = await app.fetch(
      new Request(`https://novel.example/api/v1/import-jobs/${job.id}/events?after=0`, {
        headers: { cookie, 'last-event-id': '1' },
      }),
    );
    const replayReader = replay.body?.getReader();
    if (!replayReader) throw new Error('SSE body missing');
    const replayChunk = await readChunk(replayReader);
    expect(replayChunk.text).toContain('event: snapshot');
    expect(replayChunk.text).not.toContain('id: 1\nevent: job');
    await replayReader.cancel();

    app.database.query('DELETE FROM job_events WHERE job_id = ?').run(job.id);
    app.imports.setJobStatus(job.id, { status: 'failed', completedAt: '2026-08-26T00:00:00.000Z' });
    const reset = await app.fetch(
      new Request(`https://novel.example/api/v1/import-jobs/${job.id}/events`, {
        headers: { cookie, 'last-event-id': '0' },
      }),
    );
    const resetReader = reset.body?.getReader();
    if (!resetReader) throw new Error('SSE body missing');
    const resetChunk = await readUntil(resetReader, 'event: reset');
    expect(resetChunk).toContain('event: reset');
    await resetReader.cancel();
    app.close();
  });

  it('sends heartbeats and ends a live stream after session expiry', async () => {
    let now = Date.parse('2026-08-26T00:00:00.000Z');
    const { app, cookie } = await application({ now: () => now, pollMs: 5, heartbeatMs: 10 });
    const job = queuedJob(app);
    const response = await app.fetch(
      new Request(`https://novel.example/api/v1/import-jobs/${job.id}/events`, { headers: { cookie } }),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE body missing');
    await readUntil(reader, 'event: snapshot');
    expect(await readUntil(reader, ': heartbeat', 500)).toContain(': heartbeat');

    now += 12 * 60 * 60 * 1000 + 1;
    expect(await readUntil(reader, 'event: session-expired', 500)).toContain('event: session-expired');
    expect((await readChunk(reader)).done).toBe(true);
    app.close();
  });
});

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
