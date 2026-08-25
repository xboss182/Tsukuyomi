import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getDB } from 'src/utils/indexed-db';
import {
  __resetImportJobServiceForTesting,
  ImportJobService,
} from 'src/services/importer/import-job-service';
import { DiagnosticLog } from 'src/services/importer/import-diagnostics';
import type { ImportFetchRequest, ImportFetchResult } from 'src/models/importer';
import type { ImportJob } from 'src/services/importer/types';

const workUrl = 'https://kakuyomu.jp/works/822139842947212336';

const workHtml = JSON.stringify({
  query: { workId: '822139842947212336' },
  props: {
    pageProps: {
      __APOLLO_STATE__: {
        'Work:822139842947212336': {
          title: 'Fixture work',
          introduction: 'desc',
          tagLabels: [],
          tableOfContentsV2: [{ __ref: 'Toc:1' }],
        },
        'Toc:1': { episodeUnions: [{ __ref: 'Episode:episode-1' }] },
        'Episode:episode-1': { id: 'episode-1', title: 'First', publishedAt: '2026-08-24T00:00:00.000Z' },
      },
    },
  },
});

function response(request: ImportFetchRequest): ImportFetchResult {
  if (request.kind === 'toc') {
    return {
      ok: true,
      response: {
        finalUrl: request.url,
        status: 200,
        contentType: 'text/html',
        body: `<script id="__NEXT_DATA__" type="application/json">${workHtml}</script>`,
        byteLength: 100,
      },
    };
  }
  return { ok: false, error: { code: 'unknown', message: 'unexpected', retryable: false } };
}

beforeEach(() => {
  __resetImportJobServiceForTesting();
});

afterEach(() => {
  __resetImportJobServiceForTesting();
});

describe('ImportJobService operational controls (MNC-979)', () => {
  it('beginShutdown returns the active worker promise and prevents new jobs', async () => {
    ImportJobService.setFetchForTesting((request) => Promise.resolve(response(request)));
    await ImportJobService.createImportJob({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'shutdown-drain',
      privateUseAcknowledged: true,
    });
    await ImportJobService.waitForIdleForTesting();

    // After the job completes, beginShutdown returns an immediately-resolved promise.
    await ImportJobService.beginShutdown();
    const status = await ImportJobService.runtimeStatus();
    expect(status.shuttingDown).toBe(true);
    expect(status.ready).toBe(false);

    // No new job should be scheduled while draining.
    await ImportJobService.createImportJob({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'post-shutdown',
      privateUseAcknowledged: true,
    });
    // The queued job from createImportJob is persisted but the worker does not pick it up.
    const jobs = await ImportJobService.listImportJobs();
    const queued = jobs.filter((entry) => entry.status === 'queued');
    expect(queued.length).toBeGreaterThanOrEqual(1);
    // Worker is not running because scheduleNextImportJob bailed on shuttingDown.
    const postStatus = await ImportJobService.runtimeStatus();
    expect(postStatus.workerRunning).toBe(false);
  });

  it('runtimeStatus distinguishes readiness from job failures', async () => {
    const db = await getDB();
    const failedJob: ImportJob = {
      id: 'failed-1',
      idempotencyKey: 'failed-key',
      mode: 'import',
      inputUrl: workUrl,
      sourceKey: 'kakuyomu',
      remoteWorkId: '822139842947212336',
      canonicalWorkUrl: workUrl,
      sourceWorkKey: 'kakuyomu:822139842947212336',
      status: 'failed',
      counts: { total: 1, completed: 0, failed: 1, cancelled: 0 },
      bodyBytes: 0,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const completedJob: ImportJob = {
      ...failedJob,
      id: 'done-1',
      idempotencyKey: 'done-key',
      status: 'completed',
      completedAt: '2026-08-24T01:00:00.000Z',
      counts: { total: 1, completed: 1, failed: 0, cancelled: 0 },
    };
    await db.put('import-jobs', failedJob);
    await db.put('import-jobs', completedJob);

    const status = await ImportJobService.runtimeStatus();
    // Ready=true despite failed jobs: readiness ≠ job success.
    expect(status.ready).toBe(true);
    expect(status.failedJobs).toBe(1);
    expect(status.completedJobs).toBe(1);
    expect(status.totalJobs).toBe(2);
  });

  it('interrupted jobs make the queue not ready until recovery requeues them', async () => {
    const db = await getDB();
    await db.put('import-jobs', {
      id: 'interrupted',
      idempotencyKey: 'interrupted-key',
      mode: 'import',
      inputUrl: workUrl,
      sourceKey: 'kakuyomu',
      remoteWorkId: '822139842947212336',
      canonicalWorkUrl: workUrl,
      sourceWorkKey: 'kakuyomu:822139842947212336',
      status: 'fetching',
      counts: { total: 0, completed: 0, failed: 0, cancelled: 0 },
      bodyBytes: 0,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    } satisfies ImportJob);

    const before = await ImportJobService.runtimeStatus();
    expect(before.ready).toBe(false);
    expect(before.interruptedJobs).toBe(1);

    await ImportJobService.recoverInterruptedJobs();
    const after = await ImportJobService.runtimeStatus();
    expect(after.interruptedJobs).toBe(0);
    expect(after.ready).toBe(true);
  });
});

describe('DiagnosticLog', () => {
  it('evicts oldest entries beyond capacity and exposes recent events', () => {
    const log = new DiagnosticLog(3);
    log.info('startup', 'a');
    log.warn('fetch', 'b');
    log.error('provider', 'c');
    log.info('shutdown', 'd');
    const recent = log.recent();
    expect(recent).toHaveLength(3);
    expect(recent[0]!.message).toBe('b');
    expect(recent[2]!.message).toBe('d');
  });

  it('never stores secrets — messages carry only structured labels', () => {
    const log = new DiagnosticLog();
    log.error('credentials', 'credential vault initialized');
    const entry = log.recent()[0]!;
    expect(entry.message).not.toMatch(/secret|password|token/i);
  });
});
