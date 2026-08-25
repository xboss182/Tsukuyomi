import './setup';
import { describe, expect, it } from 'bun:test';
import { getDB } from 'src/utils/indexed-db';
import { collectImportJobDiagnostics } from 'src/services/importer/import-job-diagnostics';
import type { ImportJob, ImportJobItem } from 'src/models/importer';

function job(overrides: Partial<ImportJob>): ImportJob {
  const base = overrides.id ?? `job-${Math.random().toString(36).slice(2)}`;
  return {
    id: base,
    idempotencyKey: `key-${base}`,
    mode: 'import',
    inputUrl: 'https://kakuyomu.jp/works/822139842947212336',
    sourceKey: 'kakuyomu',
    remoteWorkId: '822139842947212336',
    canonicalWorkUrl: 'https://kakuyomu.jp/works/822139842947212336',
    sourceWorkKey: 'kakuyomu:822139842947212336',
    status: 'completed',
    counts: { total: 1, completed: 1, failed: 0, cancelled: 0 },
    bodyBytes: 100,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function item(jobId: string, status: ImportJobItem['status'], overrides: Partial<ImportJobItem> = {}): ImportJobItem {
  return {
    id: `${jobId}:episode-${Math.random()}`,
    jobId,
    sourceKey: 'kakuyomu',
    remoteWorkId: '822139842947212336',
    remoteChapterId: 'episode-1',
    jobStatusKey: `${jobId}:${status}`,
    sourceChapterKey: 'kakuyomu:822139842947212336:episode-1',
    canonicalChapterUrl: 'https://kakuyomu.jp/works/822139842947212336/episodes/episode-1',
    title: 'Fixture chapter',
    remoteVolumeId: 'volume-1',
    remoteVolumeTitle: '卷一',
    sequence: 1,
    status,
    attempts: 0,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('ImportJobDiagnostics', () => {
  it('reports readiness with running and queued job counts from fixtures', async () => {
    const db = await getDB();
    await db.put('import-jobs', job({ id: 'a', status: 'fetching' }));
    await db.put('import-jobs', job({ id: 'b', status: 'queued' }));
    await db.put('import-jobs', job({ id: 'c', status: 'completed', completedAt: '2026-08-24T01:00:00.000Z' }));
    await db.put('import-job-items', item('a', 'completed'));
    await db.put('import-job-items', item('a', 'failed'));

    const diagnostics = await collectImportJobDiagnostics(2);
    expect(diagnostics.ready).toBe(false); // 仍有任务执行/排队，未空闲
    expect(diagnostics.queuedJobs).toBe(1);
    expect(diagnostics.runningJobs).toBe(1);
    expect(diagnostics.recoveredJobs).toBe(2);
    expect(diagnostics.jobs).toHaveLength(3);
    const running = diagnostics.jobs.find((summary) => summary.id === 'a');
    expect(running?.status).toBe('fetching');
    expect(running?.failedItems).toBe(1);
    expect(running?.queuedItems).toBe(0);
    const finished = diagnostics.jobs.find((summary) => summary.id === 'c');
    expect(finished?.completedAt).toBe('2026-08-24T01:00:00.000Z');
  });

  it('never exposes response bodies or secrets in the summary', async () => {
    const db = await getDB();
    await db.put(
      'import-jobs',
      job({
        id: 'failed-job-1',
        status: 'failed',
        error: { code: 'http_error', message: '来源返回 HTTP 500', retryable: true },
      }),
    );
    await db.put('import-job-items', item('failed-job-1', 'failed'));

    const diagnostics = await collectImportJobDiagnostics();
    const serialized = JSON.stringify(diagnostics);
    // 快照只含任务元数据与错误码，不含机密或响应正文
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('"response"');
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain('providerCredential');
    expect(diagnostics.jobs[0]?.error?.code).toBe('http_error');
  });
});
