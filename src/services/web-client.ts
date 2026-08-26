/**
 * Same-origin HTTP client for the browser deployment.
 *
 * This module is the only renderer code that talks to `/api/v1`. It enforces:
 * - JSON request bodies with `Content-Type: application/json`
 * - Double-submit CSRF token from the `__Host-tsukuyomi_csrf` cookie
 * - Bounded, structured `ApiError` responses
 * - 401/403 session expiry propagation
 *
 * Browser code never imports `getDB()`, `window.electronAPI`, or Electron IPC.
 */

type ApiErrorCode =
  | 'invalid_request'
  | 'not_authenticated'
  | 'csrf_rejected'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_source'
  | 'policy_disallowed'
  | 'rate_limited'
  | 'not_ready'
  | 'internal';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface ApiResult<T> {
  data: T;
  requestId: string;
}

export type ApiResponse<T> = ApiResult<T> | { error: ApiError; requestId: string };

let sessionExpiredHandler: (() => void) | null = null;

export function setWebClientSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

function getCsrfToken(): string | undefined {
  const match = document.cookie.match(/(?:^|; )__Host-tsukuyomi_csrf=([^;]*)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extra,
  };
  const csrf = getCsrfToken();
  if (csrf) {
    headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

function isApiErrorPayload(body: unknown): body is { error: ApiError } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as Record<string, unknown>).error === 'object' &&
    (body as Record<string, unknown>).error !== null
  );
}

export class WebClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'WebClientError';
  }
}

async function parseError(response: Response): Promise<WebClientError> {
  let code: ApiErrorCode = 'internal';
  let message = response.statusText || '请求失败';
  let retryable = false;
  let retryAfterMs: number | undefined;
  try {
    const body = (await response.json()) as unknown;
    if (isApiErrorPayload(body)) {
      code = body.error.code;
      message = body.error.message;
      retryable = body.error.retryable;
      retryAfterMs = body.error.retryAfterMs;
    }
  } catch {
    /* keep defaults */
  }
  return new WebClientError(message, response.status, code, retryable, retryAfterMs);
}

function emitSessionExpired(): void {
  if (sessionExpiredHandler) {
    sessionExpiredHandler();
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = buildHeaders(
    body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  );
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    emitSessionExpired();
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  const result = (await response.json()) as ApiResponse<T>;
  if ('error' in result) {
    throw new WebClientError(
      result.error.message,
      response.status,
      result.error.code,
      result.error.retryable,
      result.error.retryAfterMs,
    );
  }
  return result.data;
}

export const WebClient = {
  get<T>(path: string): Promise<T> {
    return request<T>('GET', path);
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body);
  },

  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, body);
  },

  delete<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('DELETE', path, body);
  },

  getCsrfToken,
};
