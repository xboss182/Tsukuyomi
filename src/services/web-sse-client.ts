import type { ImportJob, ImportJobItem } from 'src/models/importer';
import type { ApiError } from 'src/services/web-client';

export type SseEventName =
  | 'snapshot'
  | 'job'
  | 'item'
  | 'terminal'
  | 'reset'
  | 'session-expired'
  | 'heartbeat';

export interface SseJobEvent {
  name: SseEventName;
  data: unknown;
  id?: string;
}

export type SseEventHandler = (event: SseJobEvent) => void;

export interface SseConnection {
  close: () => void;
}

const HEARTBEAT_TIMEOUT_MS = 45_000;

/**
 * Connect to the server-sent events endpoint for an import job.
 *
 * Uses native EventSource with `credentials: 'include'` so the HttpOnly
 * session cookie is sent automatically. Reconnect uses `Last-Event-ID`.
 */
export function connectImportJobSSE(
  jobId: string,
  onEvent: SseEventHandler,
  options?: {
    onError?: (error: Error) => void;
    after?: string;
  },
): SseConnection {
  const encodedJobId = encodeURIComponent(jobId);
  let eventSource: EventSource | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEventId: string | undefined = options?.after;
  let closed = false;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function resetHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      eventSource?.close();
      eventSource = null;
      if (!closed) connect();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  function connect(): void {
    if (closed || typeof EventSource === 'undefined') return;

    const params = new URLSearchParams();
    if (lastEventId) params.set('after', lastEventId);
    const url = `/api/v1/import-jobs/${encodedJobId}/events?${params.toString()}`;

    eventSource = new EventSource(url, { withCredentials: true });

    eventSource.onopen = () => {
      resetHeartbeat();
    };

    eventSource.addEventListener('snapshot', (e) => {
      const event = e as MessageEvent;
      lastEventId = event.lastEventId;
      resetHeartbeat();
      onEvent({ name: 'snapshot', data: parseEventData(event.data), id: event.lastEventId });
    });

    eventSource.addEventListener('job', (e) => {
      const event = e as MessageEvent;
      lastEventId = event.lastEventId;
      resetHeartbeat();
      onEvent({ name: 'job', data: parseEventData(event.data), id: event.lastEventId });
    });

    eventSource.addEventListener('item', (e) => {
      const event = e as MessageEvent;
      lastEventId = event.lastEventId;
      resetHeartbeat();
      onEvent({ name: 'item', data: parseEventData(event.data), id: event.lastEventId });
    });

    eventSource.addEventListener('terminal', (e) => {
      const event = e as MessageEvent;
      lastEventId = event.lastEventId;
      resetHeartbeat();
      onEvent({ name: 'terminal', data: parseEventData(event.data), id: event.lastEventId });
      close();
    });

    eventSource.addEventListener('reset', (e) => {
      const event = e as MessageEvent;
      lastEventId = event.lastEventId;
      resetHeartbeat();
      onEvent({ name: 'reset', data: parseEventData(event.data), id: event.lastEventId });
    });

    eventSource.addEventListener('session-expired', (e) => {
      const event = e as MessageEvent;
      lastEventId = event.lastEventId;
      onEvent({ name: 'session-expired', data: {}, id: event.lastEventId });
      close();
    });

    eventSource.onmessage = (e) => {
      const event = e as MessageEvent;
      lastEventId = event.lastEventId;
      resetHeartbeat();
      onEvent({ name: 'heartbeat', data: {}, id: event.lastEventId });
    };

    eventSource.onerror = () => {
      clearHeartbeat();
      if (closed) return;
      // Let the browser reconnect automatically on recoverable errors. If the
      // session expired, the next connect will return 401 and the browser will
      // stop retrying; we rely on `session-expired` event or 401 propagation.
      options?.onError?.(new Error('SSE connection error'));
    };
  }

  function close(): void {
    closed = true;
    clearHeartbeat();
    eventSource?.close();
    eventSource = null;
  }

  function parseEventData(data: string): unknown {
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return data;
    }
  }

  connect();
  return { close };
}
