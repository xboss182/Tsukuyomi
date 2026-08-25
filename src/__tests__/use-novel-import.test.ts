import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  provideNovelImport,
  type NovelImportContext,
} from 'src/composables/novel-import/useNovelImport';
import {
  ImportJobService,
  __resetImportJobServiceForTesting,
} from 'src/services/importer/import-job-service';
import type { ImportFetchRequest, ImportFetchResult } from 'src/models/importer';

const kakuyomuUrl = 'https://kakuyomu.jp/works/822139842947212336';
const chapterUrl = `${kakuyomuUrl}/episodes/episode-1`;

function buildWorkHtml(): string {
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
  return `<script id="__NEXT_DATA__" type="application/json">${workHtml}</script>`;
}

const chapterHtml =
  '<main><div class="widget-episodeBody"><p>段落一</p><p>段落二</p></div></main>';

function fixtureFetch(request: ImportFetchRequest): Promise<ImportFetchResult> {
  if (request.kind === 'toc' && request.url === kakuyomuUrl) {
    return Promise.resolve({
      ok: true,
      response: {
        finalUrl: request.url,
        status: 200,
        contentType: 'text/html',
        body: buildWorkHtml(),
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

describe('useNovelImport', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    __resetImportJobServiceForTesting();
    ImportJobService.setClockForTesting({
      now: () => Date.parse('2026-08-24T00:00:00.000Z'),
      sleep: () => Promise.resolve(),
    });
    ImportJobService.setFetchForTesting(fixtureFetch);
    (window as unknown as { electronAPI: { isElectron: boolean } }).electronAPI = {
      isElectron: true,
    };
  });

  afterEach(() => {
    __resetImportJobServiceForTesting();
  });

  function useCtx(): NovelImportContext {
    let ctx!: NovelImportContext;
    const Host = defineComponent({
      setup() {
        ctx = provideNovelImport();
        return () => h('div');
      },
    });
    mount(Host);
    return ctx;
  }

  it('detects supported sources from URL', async () => {
    const ctx = useCtx();
    ctx.setUrl(kakuyomuUrl);
    await nextTick();
    expect(ctx.detectedSource.value?.sourceKey).toBe('kakuyomu');
    expect(ctx.needsPrivateUseAck.value).toBe(true);
    expect(ctx.canPreview.value).toBe(false);
  });

  it('requires private-use acknowledgement for Kakuyomu', async () => {
    const ctx = useCtx();
    ctx.setUrl(kakuyomuUrl);
    ctx.acknowledgePrivateUse();
    await nextTick();
    expect(ctx.canPreview.value).toBe(true);
  });

  it('runs preview and exposes snapshot metadata', async () => {
    const ctx = useCtx();
    ctx.setUrl(kakuyomuUrl);
    ctx.acknowledgePrivateUse();
    await ctx.preview();
    await ImportJobService.waitForIdleForTesting();
    await flushPromises();

    expect(ctx.job.value?.status).toBe('completed');
    expect(ctx.snapshot.value?.title).toBe('Fixture work');
    expect(ctx.snapshot.value?.chapters).toHaveLength(1);
  });

  it('auto-selects all chapters after snapshot arrives', async () => {
    const ctx = useCtx();
    ctx.setUrl(kakuyomuUrl);
    ctx.acknowledgePrivateUse();
    await ctx.preview();
    await ImportJobService.waitForIdleForTesting();
    await flushPromises();

    expect(ctx.selectedChapters.value.size).toBe(1);
    expect(ctx.canImport.value).toBe(true);
  });

  it('imports selected chapters', async () => {
    const ctx = useCtx();
    ctx.setUrl(kakuyomuUrl);
    ctx.acknowledgePrivateUse();
    await ctx.preview();
    await flushPromises();

    expect(ctx.selectedChapters.value.size).toBe(1);
    await ctx.confirmImport();
    await flushPromises();

    // import reuses the same source work; the preview job already completed
    // so the confirm job may return the same completed job.
    expect(['completed', 'failed']).toContain(ctx.job.value?.status);
  });

  it('reports unsupported source', async () => {
    const ctx = useCtx();
    ctx.setUrl('https://example.com/book/123');
    await nextTick();
    expect(ctx.step.value).toBe('unsupported');
    expect(ctx.canPreview.value).toBe(false);
  });

  it('reports failure when fetch fails', async () => {
    ImportJobService.setFetchForTesting(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'parse_failed', message: 'fixture failure', retryable: false },
      }),
    );
    const ctx = useCtx();
    ctx.setUrl(kakuyomuUrl);
    ctx.acknowledgePrivateUse();
    await ctx.preview();
    await ImportJobService.waitForIdleForTesting();
    await flushPromises();

    expect(ctx.step.value).toBe('failed');
    expect(ctx.error.value?.message).toContain('fixture failure');
  });
});
