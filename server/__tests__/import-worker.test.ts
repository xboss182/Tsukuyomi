import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportFetchRequest, ImportFetchResult } from '../../src/models/importer';
import { openDatabase } from '../database';
import { ImportJobRepository } from '../import-repository';
import { ServerImportWorker } from '../import-worker';
import { LibraryRepository } from '../library-repository';

const paths: string[] = [];
const workUrl = 'https://kakuyomu.jp/works/822139842947212336';
const chapterUrl = `${workUrl}/episodes/episode-1`;
const workData = JSON.stringify({
  query: { workId: '822139842947212336' },
  props: {
    pageProps: {
      __APOLLO_STATE__: {
        'Work:822139842947212336': {
          title: 'Worker fixture',
          tableOfContentsV2: [{ __ref: 'Toc:1' }],
        },
        'Toc:1': { episodeUnions: [{ __ref: 'Episode:episode-1' }] },
        'Episode:episode-1': { id: 'episode-1', title: 'First chapter' },
      },
    },
  },
});

function fetchFixture(request: ImportFetchRequest): Promise<ImportFetchResult> {
  if (request.kind === 'toc' && request.url === workUrl) {
    return Promise.resolve({
      ok: true,
      response: {
        finalUrl: request.url,
        status: 200,
        contentType: 'text/html',
        body: `<script id="__NEXT_DATA__" type="application/json">${workData}</script>`,
        byteLength: 100,
      },
    });
  }
  if (request.kind === 'chapter' && request.url === chapterUrl) {
    return Promise.resolve({
      ok: true,
      response: {
        finalUrl: request.url,
        status: 200,
        contentType: 'text/html',
        body: '<main><div class="widget-episodeBody"><p>正文</p></div></main>',
        byteLength: 100,
      },
    });
  }
  return Promise.resolve({
    ok: false,
    error: { code: 'network_error', message: 'unexpected fixture URL', retryable: false },
  });
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ServerImportWorker', () => {
  it('uses the shared source parser to persist a completed import and durable events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-worker-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const library = new LibraryRepository(database);
    const jobs = new ImportJobRepository(database, library);
    const worker = new ServerImportWorker(jobs, {
      fetch: fetchFixture,
      clock: { now: () => Date.parse('2026-08-26T00:00:00.000Z'), sleep: () => Promise.resolve() },
    });
    const job = jobs.create({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'worker-import',
      privateUseAcknowledged: true,
    }).job;

    await worker.start();
    await worker.waitForIdle();

    const completed = jobs.get(job.id);
    expect(completed).toMatchObject({ status: 'completed', counts: { completed: 1 } });
    expect(completed?.novelId).toEqual(expect.any(String));
    const importedBook = library.getBook(completed?.novelId ?? '')?.book;
    const volumes = Array.isArray(importedBook?.volumes) ? importedBook.volumes : [];
    const firstVolume = volumes[0] as { chapters?: Array<{ id?: string }> } | undefined;
    const importedChapter = firstVolume?.chapters?.[0];
    expect(importedChapter?.id).toEqual(expect.any(String));
    expect(library.getChapterContent(completed?.novelId ?? '', importedChapter?.id ?? '')?.paragraphs).toMatchObject([
      { text: '正文' },
    ]);
    expect(jobs.eventsAfter(job.id, 0).at(-1)).toMatchObject({ name: 'terminal' });
    database.close();
  });

  it('leaves an interrupted active job durable for startup recovery during shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-worker-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const library = new LibraryRepository(database);
    const jobs = new ImportJobRepository(database, library);
    let releaseDiscovery!: () => void;
    let signalDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      signalDiscoveryStarted = resolve;
    });
    const worker = new ServerImportWorker(jobs, {
      fetch: (request: ImportFetchRequest) => {
        if (request.kind !== 'toc') return fetchFixture(request);
        signalDiscoveryStarted();
        return new Promise<ImportFetchResult>((resolve) => {
          releaseDiscovery = () => resolve({
            ok: true,
            response: {
              finalUrl: workUrl,
              status: 200,
              contentType: 'text/html',
              body: `<script id="__NEXT_DATA__" type="application/json">${workData}</script>`,
              byteLength: 100,
            },
          });
        });
      },
      clock: { now: () => Date.parse('2026-08-26T00:00:00.000Z'), sleep: () => Promise.resolve() },
    });
    const job = jobs.create({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'shutdown-import',
      privateUseAcknowledged: true,
    }).job;

    await worker.start();
    await discoveryStarted;
    const shutdown = worker.beginShutdown();
    releaseDiscovery();
    await shutdown;

    expect(jobs.get(job.id)?.status).not.toBe('cancelled');
    jobs.recoverInterruptedJobs();
    expect(jobs.get(job.id)?.status).toBe('queued');
    database.close();
  });
});
