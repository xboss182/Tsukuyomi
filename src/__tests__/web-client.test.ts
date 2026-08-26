import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { WebClient, setWebClientSessionExpiredHandler } from 'src/services/web-client';

const sessionResponse = { authenticated: true, expiresAt: '2026-08-24T12:00:00.000Z' };

function mockFetch(responses: Map<string, { status: number; body?: unknown }>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = responses.get(url);
    if (!response) {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: 'not found', retryable: false } }), { status: 404 }));
    }
    const body = response.body !== undefined ? JSON.stringify(response.body) : '';
    return Promise.resolve(new Response(body, { status: response.status }));
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('WebClient', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setWebClientSessionExpiredHandler(null);
  });

  afterEach(() => {
    setWebClientSessionExpiredHandler(null);
  });

  it('performs a same-origin GET and returns data', async () => {
    const restore = mockFetch(
      new Map([['/api/v1/auth/session', { status: 200, body: { data: sessionResponse, requestId: 'r1' } }]]),
    );
    try {
      const result = await WebClient.get('/api/v1/auth/session');
      expect(result).toEqual(sessionResponse);
    } finally {
      restore();
    }
  });

  it('emits session expired on 401', async () => {
    let expired = false;
    setWebClientSessionExpiredHandler(() => {
      expired = true;
    });
    const restore = mockFetch(
      new Map([['/api/v1/auth/session', { status: 401, body: { error: { code: 'not_authenticated', message: 'nope', retryable: false }, requestId: 'r2' } }]]),
    );
    try {
      await expect(WebClient.get('/api/v1/auth/session')).rejects.toThrow();
      expect(expired).toBe(true);
    } finally {
      restore();
    }
  });

  it('sends JSON body with Content-Type header on POST', async () => {
    let capturedInit: RequestInit | undefined;
    const restore = mockFetchWithInit((init) => {
      capturedInit = init;
      return { status: 200, body: { data: { ok: true }, requestId: 'r3' } };
    });
    try {
      await WebClient.post('/api/v1/auth/login', { password: 'secret' });
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(capturedInit?.body).toBe(JSON.stringify({ password: 'secret' }));
      expect(capturedInit?.credentials).toBe('same-origin');
    } finally {
      restore();
    }
  });
});

function mockFetchWithInit(
  handler: (init: RequestInit | undefined) => { status: number; body?: unknown },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const response = handler(init);
    const body = response.body !== undefined ? JSON.stringify(response.body) : '';
    return Promise.resolve(new Response(body, { status: response.status }));
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
