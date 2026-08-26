import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { provideWebAuth, injectWebAuth } from 'src/composables/web-app/useWebApp';
import { setWebClientSessionExpiredHandler } from 'src/services/web-client';

function mockFetch(responses: Map<string, { status: number; body?: unknown }>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const response = responses.get(url);
    if (!response) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'not found', retryable: false } }), { status: 404 });
    }
    const body = response.body !== undefined ? JSON.stringify(response.body) : '';
    return new Response(body, { status: response.status });
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
      new Map([['/api/v1/auth/session', { status: 200, body: { data: { authenticated: true }, requestId: 'r1' } }]]),
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
        ['/api/v1/auth/session', { status: 200, body: { data: { authenticated: true }, requestId: 'r3' } }],
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
            body: { error: { code: 'not_authenticated', message: 'bad password', retryable: false }, requestId: 'r4' },
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
});
