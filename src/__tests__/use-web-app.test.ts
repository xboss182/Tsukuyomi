import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import type { ImportJob } from 'src/models/importer';
import {
  createWebNovelImportContext,
  provideWebAuth,
  injectWebAuth,
} from 'src/composables/web-app/useWebApp';
import WebBootstrap from 'src/components/web/WebBootstrap.vue';
import { WebLibraryApi } from 'src/services/web-library-api';
import { setWebClientSessionExpiredHandler } from 'src/services/web-client';
import messages from 'src/i18n';

const i18n = createI18n({ locale: 'en-US', fallbackLocale: 'en-US', legacy: false, messages });

const sse = vi.hoisted(() => ({
  handler: null as ((event: { name: string; data: unknown }) => void) | null,
  close: vi.fn(),
}));

vi.mock('src/services/web-sse-client', () => ({
  connectImportJobSSE: vi.fn(
    (_jobId: string, handler: (event: { name: string; data: unknown }) => void) => {
      sse.handler = handler;
      return { close: sse.close };
    },
  ),
}));

function mockFetch(responses: Map<string, { status: number; body?: unknown }>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = responses.get(url);
    if (!response) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'not found', retryable: false } }),
          { status: 404 },
        ),
      );
    }
    const body = response.body !== undefined ? JSON.stringify(response.body) : '';
    return Promise.resolve(new Response(body, { status: response.status }));
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('useWebApp auth', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setWebClientSessionExpiredHandler(null);
  });

  function useAuth() {
    let auth!: ReturnType<typeof provideWebAuth>;
    const Host = defineComponent({
      setup() {
        auth = provideWebAuth();
        return () => h('div');
      },
    });
    mount(Host);
    return auth;
  }

  it('checks session on mount', async () => {
    const restore = mockFetch(
      new Map([
        [
          '/api/v1/auth/session',
          { status: 200, body: { data: { authenticated: true }, requestId: 'r1' } },
        ],
      ]),
    );
    try {
      const auth = useAuth();
      await flushPromises();
      expect(auth.state.value).toBe('authenticated');
    } finally {
      restore();
    }
  });

  it('logs in and updates state', async () => {
    const restore = mockFetch(
      new Map([
        ['/api/v1/auth/login', { status: 200, body: { data: { ok: true }, requestId: 'r2' } }],
        [
          '/api/v1/auth/session',
          { status: 200, body: { data: { authenticated: true }, requestId: 'r3' } },
        ],
      ]),
    );
    try {
      const auth = useAuth();
      await auth.login('secret');
      expect(auth.state.value).toBe('authenticated');
      expect(auth.error.value).toBeNull();
    } finally {
      restore();
    }
  });

  it('reports error on invalid password', async () => {
    const restore = mockFetch(
      new Map([
        [
          '/api/v1/auth/login',
          {
            status: 401,
            body: {
              error: { code: 'not_authenticated', message: 'bad password', retryable: false },
              requestId: 'r4',
            },
          },
        ],
      ]),
    );
    try {
      const auth = useAuth();
      await expect(auth.login('wrong')).rejects.toThrow();
      expect(auth.state.value).toBe('unauthenticated');
      expect(auth.error.value).toContain('bad password');
    } finally {
      restore();
    }
  });

  it('injects provided auth context', () => {
    let injected: ReturnType<typeof injectWebAuth> | null = null;
    const Child = defineComponent({
      setup() {
        injected = injectWebAuth();
        return () => h('div');
      },
    });
    const Host = defineComponent({
      setup() {
        provideWebAuth();
        return () => h(Child);
      },
    });
    mount(Host);
    expect(injected).not.toBeNull();
  });

  it('does not render application content while session state is unknown', () => {
    const Host = defineComponent({
      setup() {
        provideWebAuth();
        return () => h(WebBootstrap, null, { default: () => h('span', 'private library') });
      },
    });
    const wrapper = mount(Host, { global: { plugins: [i18n], stubs: { WebLoginPage: true } } });
    expect(wrapper.text()).toContain('Verifying session');
    expect(wrapper.text()).not.toContain('private library');
    wrapper.unmount();
  });
});

describe.sequential('useWebApp import', () => {
  beforeEach(() => {
    sse.handler = null;
    sse.close.mockClear();
  });

  it('sends the selected chapter subset when importing a preview', async () => {
    const createImportJob = vi
      .spyOn(WebLibraryApi, 'createImportJob')
      .mockResolvedValue({ id: 'job-1', status: 'queued' } as ImportJob);
    const context = createWebNovelImportContext();
    context.setUrl('https://kakuyomu.jp/works/12345678901234567890');
    context.snapshot.value = {
      source: {
        sourceKey: 'kakuyomu',
        remoteWorkId: '12345678901234567890',
        canonicalWorkUrl: 'https://kakuyomu.jp/works/12345678901234567890',
      },
      title: 'Test',
      volumes: [],
      chapters: [],
      metadataOnly: false,
    };
    context.selectedChapters.value = new Set(['chapter-2']);

    await context.confirmImport();

    expect(createImportJob).toHaveBeenCalledWith(
      expect.objectContaining({ selectedRemoteChapterIds: ['chapter-2'] }),
    );
    createImportJob.mockRestore();
  });

  it('applies snapshot, job, item, reset, terminal, and session-expired SSE events', async () => {
    const queued = { id: 'job-1', status: 'queued' } as ImportJob;
    const failed = {
      ...queued,
      status: 'failed',
      error: { code: 'network_error', message: 'failed', retryable: false },
    } as ImportJob;
    const createImportJob = vi.spyOn(WebLibraryApi, 'createImportJob').mockResolvedValue(queued);
    const context = createWebNovelImportContext();
    context.setUrl('https://kakuyomu.jp/works/12345678901234567890');

    await context.preview();
    expect(sse.handler).not.toBeNull();

    sse.handler!({ name: 'snapshot', data: { job: queued } });
    expect(context.step.value).toBe('queued');

    sse.handler!({ name: 'job', data: failed });
    expect(context.error.value).toEqual({ code: 'network_error', message: 'failed' });

    const item = { id: 'item-1' };
    sse.handler!({ name: 'item', data: item });
    sse.handler!({ name: 'item', data: { ...item, status: 'completed' } });
    expect(context.items.value).toEqual([{ id: 'item-1', status: 'completed' }]);

    sse.handler!({ name: 'reset', data: { job: queued } });
    expect(context.items.value).toEqual([]);

    sse.handler!({ name: 'session-expired', data: {} });
    expect(sse.close).toHaveBeenCalledTimes(1);

    await context.preview();
    sse.handler!({ name: 'terminal', data: failed });
    expect(context.step.value).toBe('failed');
    expect(sse.close).toHaveBeenCalledTimes(2);
    createImportJob.mockRestore();
  });
});
