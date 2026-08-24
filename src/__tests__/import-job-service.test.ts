import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getDB } from 'src/utils/indexed-db';
import {
  __resetImportJobServiceForTesting,
  ImportJobService,
} from 'src/services/importer/import-job-service';
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

let clockTime = 0;
let pacingDelays: number[] = [];

function response(request: ImportFetchRequest): ImportFetchResult {
  if (request.kind === 'toc' && request.url === workUrl) {
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
  if (request.kind === 'chapter' && request.url === chapterUrl) {
    return {
      ok: true,
      response: {
        finalUrl: request.url,
        status: 200,
        contentType: 'text/html',
        body: chapterHtml,
        byteLength: 100,
      },
    };
  }
  return { ok: false, error: { code: 'unknown', message: 'unexpected fetch', retryable: false } };
}

beforeEach(() => {
  clockTime = Date.parse('2026-08-24T00:00:00.000Z');
  pacingDelays = [];
  ImportJobService.setClockForTesting({
    now: () => clockTime,
    sleep: async (ms) => {
      pacingDelays.push(ms);
      clockTime += ms;
    },
  });
});

afterEach(() => {
  __resetImportJobServiceForTesting();
});

describe('ImportJobService', () => {
  it('uses idempotency keys, preserves existing translations, and records per-item success', async () => {
    ImportJobService.setFetchForTesting(async (request) => response(request));

    const first = await ImportJobService.createImportJob({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'first-import',
    });
    const duplicate = await ImportJobService.createImportJob({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'first-import',
    });
    expect(duplicate.id).toBe(first.id);

    await ImportJobService.waitForIdleForTesting();
    const completed = await ImportJobService.getImportJob(first.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.counts).toEqual({ total: 1, completed: 1, failed: 0, cancelled: 0 });

    const db = await getDB();
    const book = await db.get('books', completed?.novelId || '');
    const chapter = book?.volumes?.[0]?.chapters?.[0];
    if (!chapter) throw new Error('chapter was not persisted');
    const stored = await db.get('chapter-contents', chapter.id);
    const paragraphs = JSON.parse(stored?.content || '[]') as Array<{
      id: string;
      text: string;
      selectedTranslationId: string;
      translations: Array<{ id: string; translation: string; aiModelId: string }>;
    }>;
    paragraphs[0]!.selectedTranslationId = 'translation-1';
    paragraphs[0]!.translations = [{ id: 'translation-1', translation: '保留译文', aiModelId: 'model-1' }];
    await db.put('chapter-contents', {
      chapterId: chapter.id,
      content: JSON.stringify(paragraphs),
      lastModified: '2026-08-24T00:00:01.000Z',
    });

    const refresh = await ImportJobService.createImportJob({
      url: workUrl,
      mode: 'refresh',
      idempotencyKey: 'refresh-import',
    });
    await ImportJobService.waitForIdleForTesting();
    expect((await ImportJobService.getImportJob(refresh.id))?.status).toBe('completed');
    const afterRefresh = await db.get('chapter-contents', chapter.id);
    expect(JSON.parse(afterRefresh?.content || '[]')[0]?.translations[0]?.translation).toBe('保留译文');
    expect(pacingDelays).toEqual([2000, 2000, 2000]);
  });

  it('persists successful chapters when a later chapter fails', async () => {
    const partialWork = JSON.parse(workHtml) as {
      props: { pageProps: { __APOLLO_STATE__: Record<string, unknown> } };
    };
    const state = partialWork.props.pageProps.__APOLLO_STATE__;
    state['Toc:1'] = {
      episodeUnions: [{ __ref: 'Episode:episode-1' }, { __ref: 'Episode:episode-2' }],
    };
    state['Episode:episode-2'] = {
      id: 'episode-2',
      title: 'Broken chapter',
      publishedAt: '2026-08-24T00:00:00.000Z',
    };
    const populatedWorkHtml = JSON.stringify(partialWork);
    ImportJobService.setFetchForTesting(async (request) => {
      if (request.kind === 'toc') {
        return {
          ok: true,
          response: {
            finalUrl: request.url,
            status: 200,
            contentType: 'text/html',
            body: `<script id="__NEXT_DATA__" type="application/json">${populatedWorkHtml}</script>`,
            byteLength: 100,
          },
        };
      }
      if (request.url.endsWith('/episode-1')) return response(request);
      return { ok: false, error: { code: 'parse_failed', message: 'fixture failure', retryable: false } };
    });

    const job = await ImportJobService.createImportJob({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'partial-import',
    });
    await ImportJobService.waitForIdleForTesting();

    const completed = await ImportJobService.getImportJob(job.id);
    expect(completed?.status).toBe('completed_with_errors');
    expect(completed?.counts).toEqual({ total: 2, completed: 1, failed: 1, cancelled: 0 });
    expect((await ImportJobService.listImportJobItems(job.id)).map((item) => item.status).sort()).toEqual([
      'completed',
      'failed',
    ]);
  });

  it('requeues interrupted jobs at startup', async () => {
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
    });

    await ImportJobService.recoverInterruptedJobs();
    expect((await ImportJobService.getImportJob('interrupted'))?.status).toBe('queued');
  });
});
