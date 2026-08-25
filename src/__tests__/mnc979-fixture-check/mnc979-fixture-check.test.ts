/**
 * MNC-979 fixture-only verification: exercises manual export/import of the
 * library + scraper/job state, and restart recovery of interrupted jobs.
 *
 * Runs against recorded fixtures and a mocked fetcher — never touches live
 * third-party endpoints.
 *
 * Usage: bunx vitest run scripts/mnc979-fixture-check.test.ts
 */
import '../setup';
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDB } from 'src/utils/indexed-db';
import {
  __resetImportJobServiceForTesting,
  ImportJobService,
} from 'src/services/importer/import-job-service';
import { ImportLibraryBackupService } from 'src/services/importer/import-library-backup-service';
import { collectImportJobDiagnostics } from 'src/services/importer/import-job-diagnostics';
import type { ImportFetchRequest, ImportFetchResult } from 'src/models/importer';

const workUrl = 'https://kakuyomu.jp/works/822139842947212336';
const chapterUrl = `${workUrl}/episodes/episode-1`;

const workHtml = JSON.stringify({
  query: { workId: '822139842947212336' },
  props: {
    pageProps: {
      __APOLLO_STATE__: {
        'Work:822139842947212336': {
          title: 'Fixture work',
          introduction: 'Fixture description',
          tagLabels: ['tag'],
          tableOfContentsV2: [{ __ref: 'Toc:1' }],
        },
        'Toc:1': { episodeUnions: [{ __ref: 'Episode:episode-1' }] },
        'Episode:episode-1': {
          id: 'episode-1',
          title: 'First fixture chapter',
          publishedAt: '2026-08-24T00:00:00.000Z',
        },
      },
    },
  },
});

const chapterHtml = '<main><div class="widget-episodeBody"><p>段落一</p><p>段落二</p></div></main>';

function fixtureResponse(request: ImportFetchRequest): Promise<ImportFetchResult> {
  if (request.kind === 'toc' && request.url === workUrl) {
    return Promise.resolve({
      ok: true,
      response: {
        finalUrl: request.url,
        status: 200,
        contentType: 'text/html',
        body: `<script id="__NEXT_DATA__" type="application/json">${workHtml}</script>`,
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
        body: chapterHtml,
        byteLength: 100,
      },
    });
  }
  return Promise.resolve({
    ok: false,
    error: { code: 'unknown', message: 'unexpected fetch', retryable: false },
  });
}

const records: string[] = [];
function record(line: string) {
  records.push(line);
  console.log(line);
}

describe('MNC-979 fixture verification (recorded)', () => {
  afterAll(() => {
    __resetImportJobServiceForTesting();
  });

  it(
    'exports/imports library+job state and resumes interrupted jobs, without live requests',
    async () => {
      ImportJobService.setFetchForTesting(fixtureResponse);
      // 真实时钟下串行 worker 有 2s 的来源间隔，需要超过默认 5s 测试超时。
      const startTime = Date.now();

      // 1. Import a work from recorded fixtures.
      const job = await ImportJobService.createImportJob({
        url: workUrl,
        mode: 'import',
        idempotencyKey: 'fixture-check-1',
        privateUseAcknowledged: true,
      });
      record(`created job ${job.id} (${job.sourceKey})`);
      await ImportJobService.waitForIdleForTesting();
      const finished = await ImportJobService.getImportJob(job.id);
      expect(finished?.status).toBe('completed');
      record(`job finished: status=${finished?.status} completed=${finished?.counts.completed}`);

      // 2. Export the library + job state.
      const backup = await ImportLibraryBackupService.createBackup();
      const directory = await mkdtemp(join(tmpdir(), 'mnc979-export-'));
      const exportPath = join(directory, 'tsukuyomi-library-backup.json');
      await writeFile(exportPath, JSON.stringify(backup, null, 2), 'utf8');
      record(
        `exported backup: books=${backup.books.length} jobs=${backup.jobs.length} jobItems=${backup.jobItems.length}`,
      );
      const onDisk = await readFile(exportPath, 'utf8');
      record(`export file bytes=${Buffer.byteLength(onDisk)}`);

      // Export must never carry credentials.
      const secrets = onDisk.match(/token|api_key|secret|password|authorization/i);
      expect(secrets).toBeNull();
      record(`export contains no credential fields: PASS`);

      // 3. Diagnostics reflect the finished (idle) state.
      const idle = await collectImportJobDiagnostics(0);
      expect(idle.ready).toBe(true);
      record(
        `diagnostics: ready=${idle.ready} running=${idle.runningJobs} queued=${idle.queuedJobs} jobs=${idle.jobs.length}`,
      );

      // 4. Simulate an interrupted restart: seed a mid-flight job, then start().
      const db = await getDB();
      await db.put('import-jobs', {
        id: 'interrupted-fixture',
        idempotencyKey: 'fixture-interrupted',
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
      });
      record('seeded interrupted job (status=fetching)');

      const recovered = await ImportJobService.start();
      expect(recovered).toBe(1);
      record(`start() recovered=${recovered}`);
      const resumed = await ImportJobService.getImportJob('interrupted-fixture');
      expect(resumed?.status).toBe('completed');
      record(`resumed job: status=${resumed?.status} completed=${resumed?.counts.completed}`);

      // 5. Restore from the exported backup.
      const restored = await ImportLibraryBackupService.parseJson(onDisk);
      await ImportLibraryBackupService.restoreBackup(restored);
      const afterRestore = await collectImportJobDiagnostics(0);
      record(
        `restored backup: jobs=${afterRestore.jobs.length} (${afterRestore.jobs
          .map((j) => j.status)
          .join(',')})`,
      );

      await rm(directory, { recursive: true, force: true });
      // 把记录行作为断言消息输出，便于在非 TTY 下捕获完整记录。
      expect(records.length, records.join('\n')).toBeGreaterThan(0);
      record(`elapsed ms=${Date.now() - startTime}`);
    },
    30_000,
  );
});
