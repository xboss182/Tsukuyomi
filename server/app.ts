import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { CreateImportJobRequest } from '../src/models/importer';
import {
  AuthService,
  type AuthClock,
  AuthServiceError,
  csrfCookieName,
  sessionCookieName,
  sessionDurationSeconds,
} from './auth';
import { openDatabase } from './database';
import { ImportJobRepository, ImportRepositoryError } from './import-repository';
import type { JobEvent } from './import-repository';
import { ServerImportWorker } from './import-worker';
import { LibraryRepository, RepositoryError } from './library-repository';
import { SQLiteProviderCredentialStore } from './provider-credential-store';
import type { ProviderCredentialInput } from '../src/services/importer/provider-credentials';
import {
  PrivateScraperGateway,
  createProviderDrivers,
  performProviderHttpRequest,
} from '../src/services/importer/provider-gateway';
import { performImportFetch } from '../src/services/importer/import-fetch';
import type { DataKey } from './secret-store';
import { DefaultServerAIGateway } from './ai-gateway';
import type { ServerAIGateway, ServerAIRequest } from './ai-gateway';
import { ServerModelStore, type ServerModelSummary } from './model-store';
import { ServerSyncConfigStore } from './sync-config-store';

const JSON_LIMIT_BYTES = 1024 * 1024;
const BACKUP_LIMIT_BYTES = 25 * 1024 * 1024;
const API_CACHE_HEADERS = {
  'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff',
} as const;

type WorkerOptions = ConstructorParameters<typeof ServerImportWorker>[1];

export type ServerApplicationOptions = {
  databasePath: string;
  version: string;
  commit: string;
  publicOrigin?: string;
  dataKey?: DataKey;
  authClock?: AuthClock;
  ssePollIntervalMs?: number;
  sseHeartbeatMs?: number;
  aiGateway?: ServerAIGateway;
  worker?: WorkerOptions;
};

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

type ApiFailure = {
  code: ApiErrorCode;
  status: number;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

class RequestFailure extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

function failure(
  code: ApiErrorCode,
  status: number,
  message: string,
  retryable = false,
  retryAfterMs?: number,
): RequestFailure {
  return new RequestFailure({ code, status, message, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', API_CACHE_HEADERS['cache-control']);
  responseHeaders.set('x-content-type-options', API_CACHE_HEADERS['x-content-type-options']);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maxLength = 50_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw failure('invalid_request', 400, `${field} 无效`);
  }
  return value;
}

function requireInteger(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw failure('invalid_request', 400, `${field} 无效`);
  }
  return value as number;
}

function parseCookies(request: Request): Map<string, string> {
  const values = new Map<string, string>();
  for (const pair of request.headers.get('cookie')?.split(';') ?? []) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name && value) values.set(name, value);
  }
  return values;
}

function readPathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) {
        throw new Error('invalid');
      }
      return decoded;
    } catch {
      throw failure('invalid_request', 400, '路径无效');
    }
  });
}

function cookie(name: string, value: string, options: { httpOnly?: boolean; maxAge?: number } = {}): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'Secure',
    ...(options.httpOnly ? ['HttpOnly'] : []),
    'SameSite=Strict',
    ...(options.maxAge !== undefined ? [`Max-Age=${options.maxAge}`] : []),
  ].join('; ');
}

function expiredCookie(name: string, httpOnly: boolean): string {
  return cookie(name, '', { httpOnly, maxAge: 0 });
}

function sseFrame(name: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseEventCursor(request: Request, url: URL): number {
  const header = request.headers.get('last-event-id');
  const raw = header ?? url.searchParams.get('after') ?? '0';
  if (!/^\d+$/.test(raw)) throw failure('invalid_request', 400, '事件游标无效');
  return Number(raw);
}

async function readLimitedText(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw failure('payload_too_large', 413, '请求内容过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export class ServerApplication {
  readonly database: Database;
  readonly library: LibraryRepository;
  readonly imports: ImportJobRepository;
  readonly auth: AuthService;
  readonly worker: ServerImportWorker;
  readonly providerCredentials: SQLiteProviderCredentialStore | undefined;
  readonly models: ServerModelStore | undefined;
  readonly syncConfigs: ServerSyncConfigStore | undefined;
  private readonly aiGateway: ServerAIGateway;
  private readonly publicOrigin: string | undefined;
  private readonly ssePollIntervalMs: number;
  private readonly sseHeartbeatMs: number;
  private ready = false;
  private closed = false;

  constructor(private readonly options: ServerApplicationOptions) {
    if (
      options.publicOrigin &&
      (new URL(options.publicOrigin).origin !== options.publicOrigin ||
        new URL(options.publicOrigin).protocol !== 'https:')
    ) {
      throw new Error('TSUKUYOMI_ORIGIN 必须是不含路径的 HTTPS 源');
    }
    this.publicOrigin = options.publicOrigin;
    this.ssePollIntervalMs = this.interval(options.ssePollIntervalMs, 1_000);
    this.sseHeartbeatMs = this.interval(options.sseHeartbeatMs, 15_000);
    this.database = openDatabase(options.databasePath);
    this.library = new LibraryRepository(this.database);
    this.imports = new ImportJobRepository(this.database, this.library);
    this.auth = new AuthService(this.database, options.authClock);
    this.providerCredentials = options.dataKey
      ? new SQLiteProviderCredentialStore(this.database, options.dataKey)
      : undefined;
    this.models = options.dataKey ? new ServerModelStore(this.database, options.dataKey) : undefined;
    this.syncConfigs = options.dataKey ? new ServerSyncConfigStore(this.database, options.dataKey) : undefined;
    this.aiGateway = options.aiGateway ?? new DefaultServerAIGateway();
    const gateway = this.providerCredentials
      ? new PrivateScraperGateway({
          credentials: this.providerCredentials,
          directFetch: (request) => performImportFetch(request),
          drivers: createProviderDrivers((request) => performProviderHttpRequest(request)),
        })
      : undefined;
    this.worker = new ServerImportWorker(this.imports, {
      ...options.worker,
      ...(options.worker?.fetch || !gateway ? {} : { fetch: (request) => gateway.fetch(request) }),
    });
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error('服务已关闭');
    if (this.ready) return;
    await this.worker.start();
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.ready = false;
    await this.worker.beginShutdown();
    this.database.close();
    this.closed = true;
  }

  close(): void {
    if (this.closed) return;
    this.ready = false;
    this.database.close();
    this.closed = true;
  }

  fetch = async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    try {
      return await this.route(request, requestId);
    } catch (error) {
      return this.errorResponse(this.normalizeError(error), requestId);
    }
  };

  private async route(request: Request, requestId: string): Promise<Response> {
    const url = new URL(request.url);
    const path = readPathSegments(url);
    if (request.method === 'GET' && path.length === 1 && path[0] === 'healthz') {
      return json({ status: 'ok', version: this.options.version, commit: this.options.commit });
    }
    if (request.method === 'GET' && path.length === 1 && path[0] === 'readyz') {
      if (!this.ready || this.closed) {
        throw failure('not_ready', 503, '服务尚未就绪', true);
      }
      return json({ status: 'ready', version: this.options.version, commit: this.options.commit });
    }
    if (!this.ready || this.closed) throw failure('not_ready', 503, '服务尚未就绪', true);

    if (path[0] !== 'api' || path[1] !== 'v1') throw failure('not_found', 404, '资源不存在');
    const route = path.slice(2);
    this.validateRouteIdentifiers(route);
    if (route[0] === 'auth') return await this.authRoute(request, url, route.slice(1), requestId);
    return await this.protectedRoute(request, url, route, requestId);
  }

  private async authRoute(request: Request, url: URL, route: string[], requestId: string): Promise<Response> {
    if (request.method === 'GET' && route.length === 1 && route[0] === 'session') {
      const session = await this.auth.verifySession(parseCookies(request).get(sessionCookieName));
      return this.success({ authenticated: session !== null, ...(session ? { expiresAt: session.expiresAt } : {}) }, requestId);
    }
    if (request.method === 'POST' && route.length === 1 && route[0] === 'login') {
      this.requireOrigin(request, url);
      const body = await this.readJson(request, ['password']);
      const session = await this.auth.login(requireString(body.password, '密码', 1024));
      const headers = new Headers(API_CACHE_HEADERS);
      headers.append('set-cookie', cookie(sessionCookieName, session.token, { httpOnly: true, maxAge: sessionDurationSeconds }));
      headers.append('set-cookie', cookie(csrfCookieName, session.csrfToken, { maxAge: sessionDurationSeconds }));
      return this.success({ expiresAt: session.expiresAt }, requestId, 200, headers);
    }

    const sessionToken = await this.requireSession(request);
    this.requireMutationProtection(request, url, sessionToken);
    if (request.method === 'POST' && (route[0] === 'logout' || route[0] === 'password') && route.length === 1) {
      if (route[0] === 'logout') {
        await this.auth.revokeSession(sessionToken);
      } else {
        const body = await this.readJson(request, ['currentPassword', 'newPassword']);
        await this.auth.changePassword(
          requireString(body.currentPassword, '当前密码', 1024),
          requireString(body.newPassword, '新密码', 1024),
        );
      }
      const headers = new Headers(API_CACHE_HEADERS);
      headers.append('set-cookie', expiredCookie(sessionCookieName, true));
      headers.append('set-cookie', expiredCookie(csrfCookieName, false));
      return new Response(null, { status: 204, headers });
    }
    throw failure('not_found', 404, '资源不存在');
  }

  private async protectedRoute(request: Request, url: URL, route: string[], requestId: string): Promise<Response> {
    const sessionToken = await this.requireSession(request);
    if (route[0] === 'library') {
      return await this.libraryRoute(request, url, route.slice(1), requestId, sessionToken);
    }
    if (route[0] === 'import-jobs') {
      return await this.importRoute(request, url, route.slice(1), requestId, sessionToken);
    }
    if (route[0] === 'settings') {
      return await this.settingsRoute(request, url, route.slice(1), requestId, sessionToken);
    }
    if (route[0] === 'ai') {
      return await this.aiRoute(request, url, route.slice(1), requestId, sessionToken);
    }
    throw failure('not_found', 404, '资源不存在');
  }

  private async libraryRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    if (request.method === 'GET' && route.length === 1 && route[0] === 'backup') {
      const backup = this.library.createBackup();
      return new Response(JSON.stringify(backup), {
        status: 200,
        headers: {
          ...API_CACHE_HEADERS,
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="tsukuyomi-library-backup-v2.json"',
        },
      });
    }
    if (request.method === 'POST' && route.length === 1 && route[0] === 'restore') {
      this.requireMutationProtection(request, url, sessionToken);
      const body = await this.readJson(request, ['backup', 'confirmation'], BACKUP_LIMIT_BYTES);
      await this.worker.pause();
      try {
        this.library.restoreBackup(body.backup, requireString(body.confirmation, '确认值', 64));
      } finally {
        this.worker.resume();
      }
      return this.success({ restored: true }, requestId);
    }
    if (route[0] === 'books') return await this.booksRoute(request, url, route.slice(1), requestId, sessionToken);
    throw failure('not_found', 404, '资源不存在');
  }

  // Books use optimistic revisions; import jobs also wake the worker after create.
  // fallow-ignore-next-line code-duplication
  private async booksRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    if (route.length === 0) {
      if (request.method === 'GET') {
        const limit = url.searchParams.has('limit') ? requireInteger(Number(url.searchParams.get('limit')), '分页大小', 1, 100) : 50;
        return this.success(this.library.listBooks(limit, url.searchParams.get('cursor') ?? undefined), requestId);
      }
      if (request.method === 'POST') {
        this.requireMutationProtection(request, url, sessionToken);
        const body = await this.readJson(request, ['book']);
        return this.success(this.library.createBook(body.book), requestId, 201);
      }
    }
    const bookId = route[0];
    if (!bookId) throw failure('not_found', 404, '资源不存在');
    if (route.length === 1) {
      if (request.method === 'GET') {
        const book = this.library.getBook(bookId);
        if (!book) throw failure('not_found', 404, '书籍不存在');
        return this.success(book, requestId);
      }
      if (request.method === 'PUT') {
        this.requireMutationProtection(request, url, sessionToken);
        const body = await this.readJson(request, ['book', 'expectedRevision']);
        return this.success(
          // fallow-ignore-next-line code-duplication
          this.library.updateBook(bookId, body.book, requireInteger(body.expectedRevision, '版本', 1)),
          requestId,
        );
      }
      if (request.method === 'DELETE') {
        this.requireMutationProtection(request, url, sessionToken);
        const body = await this.readJson(request, ['expectedRevision']);
        this.library.deleteBook(bookId, requireInteger(body.expectedRevision, '版本', 1));
        return new Response(null, { status: 204, headers: API_CACHE_HEADERS });
      }
    }
    if (route.length === 4 && route[1] === 'chapters' && route[3] === 'content') {
      return await this.chapterContentRoute(request, url, bookId, route[2]!, requestId, sessionToken);
    }
    if (route.length === 2 && route[1] === 'memories') {
      if (request.method === 'GET') {
        return this.success({ items: this.library.listMemories(bookId) }, requestId);
      }
      if (request.method === 'POST') {
        this.requireMutationProtection(request, url, sessionToken);
        const body = await this.readJson(request, ['memory']);
        return this.success(this.library.createMemory(bookId, body.memory), requestId, 201);
      }
    }
    if (route.length === 3 && route[1] === 'memories') {
      return await this.memoryRoute(request, url, bookId, route[2]!, requestId, sessionToken);
    }
    throw failure('not_found', 404, '资源不存在');
  }

  private async chapterContentRoute(
    request: Request,
    url: URL,
    bookId: string,
    chapterId: string,
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    if (request.method === 'GET') {
      const content = this.library.getChapterContent(bookId, chapterId);
      if (!content) throw failure('not_found', 404, '章节正文不存在');
      return this.success(content, requestId);
    }
    if (request.method === 'PUT') {
      this.requireMutationProtection(request, url, sessionToken);
      const body = await this.readJson(request, ['paragraphs', 'expectedRevision']);
      return this.success(
        this.library.putChapterContent(
          bookId,
          chapterId,
          body.paragraphs,
          requireInteger(body.expectedRevision, '版本', 0),
        ),
        requestId,
      );
    }
    throw failure('not_found', 404, '资源不存在');
  }

  // Memory DTOs are nested below books, unlike the import job resource.
  // fallow-ignore-next-line code-duplication
  private async memoryRoute(
    request: Request,
    url: URL,
    bookId: string,
    memoryId: string,
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    if (request.method === 'GET') {
      const memory = this.library.getMemory(bookId, memoryId);
      if (!memory) throw failure('not_found', 404, '记忆不存在');
      return this.success(memory, requestId);
    }
    if (request.method === 'PUT') {
      this.requireMutationProtection(request, url, sessionToken);
      const body = await this.readJson(request, ['memory', 'expectedRevision']);
      return this.success(
        // fallow-ignore-next-line code-duplication
        this.library.updateMemory(bookId, memoryId, body.memory, requireInteger(body.expectedRevision, '版本', 1)),
        requestId,
      );
    }
    if (request.method === 'DELETE') {
      this.requireMutationProtection(request, url, sessionToken);
      const body = await this.readJson(request, ['expectedRevision']);
      this.library.deleteMemory(bookId, memoryId, requireInteger(body.expectedRevision, '版本', 1));
      return new Response(null, { status: 204, headers: API_CACHE_HEADERS });
    }
    throw failure('not_found', 404, '资源不存在');
  }

  // Collection semantics intentionally mirror books while using import-specific DTOs and worker wake-up.
  // fallow-ignore-next-line code-duplication
  private async importRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    if (route.length === 0) {
      if (request.method === 'GET') {
        const limit = url.searchParams.has('limit') ? requireInteger(Number(url.searchParams.get('limit')), '分页大小', 1, 100) : 50;
        return this.success({ items: this.imports.list(limit, url.searchParams.get('cursor') ?? undefined) }, requestId);
      }
      if (request.method === 'POST') {
        this.requireMutationProtection(request, url, sessionToken);
        const body = await this.readJson(request, [
          'url',
          'mode',
          'idempotencyKey',
          'selectedRemoteChapterIds',
          'privateUseAcknowledged',
          'maxProviderCostMicros',
        ]);
        const created = this.imports.create(this.createImportRequest(body));
        if (created.created) this.worker.wake();
        return this.success({ job: created.job, deduplicated: created.deduplicated }, requestId, created.created ? 202 : 200);
      }
    }
    const jobId = route[0];
    if (!jobId) throw failure('not_found', 404, '资源不存在');
    if (route.length === 1 && request.method === 'GET') {
      const job = this.imports.get(jobId);
      if (!job) throw failure('not_found', 404, '导入任务不存在');
      return this.success(job, requestId);
    }
    if (route.length === 2 && route[1] === 'items' && request.method === 'GET') {
      return this.success({ items: this.imports.listItems(jobId) }, requestId);
    }
    if (route.length === 2 && route[1] === 'cancel' && request.method === 'POST') {
      this.requireMutationProtection(request, url, sessionToken);
      await this.readJson(request, []);
      const job = this.imports.cancel(jobId);
      if (!job) throw failure('not_found', 404, '导入任务不存在');
      return this.success(job, requestId);
    }
    if (route.length === 2 && route[1] === 'retry-failed' && request.method === 'POST') {
      this.requireMutationProtection(request, url, sessionToken);
      await this.readJson(request, []);
      const job = this.imports.retryFailedItems(jobId);
      this.worker.wake();
      return this.success(job, requestId, 202);
    }
    if (route.length === 2 && route[1] === 'events' && request.method === 'GET') {
      return this.sseResponse(request, url, jobId, sessionToken);
    }
    throw failure('not_found', 404, '资源不存在');
  }

  private async settingsRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    if (route[0] === 'import-providers') {
      return await this.providerCredentialRoute(request, url, route.slice(1), requestId, sessionToken);
    }
    if (route[0] === 'ai-models') {
      return await this.aiModelRoute(request, url, route.slice(1), requestId, sessionToken);
    }
    if (route[0] === 'sync-configs') {
      return await this.syncConfigRoute(request, url, route.slice(1), requestId, sessionToken);
    }
    if (route.length !== 0) throw failure('not_found', 404, '资源不存在');
    if (request.method === 'GET') return this.success(this.library.getPublicSettings(), requestId);
    if (request.method === 'PUT') {
      this.requireMutationProtection(request, url, sessionToken);
      const body = await this.readJson(request, ['settings', 'expectedRevision']);
      return this.success(
        this.library.putPublicSettings(body.settings, requireInteger(body.expectedRevision, '版本', 0)),
        requestId,
      );
    }
    throw failure('not_found', 404, '资源不存在');
  }

  /** Generic collection/item CRUD for settings resources backed by an id-keyed store. */
  private async settingsCollectionRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
    options: {
      store: { list(): unknown[]; get(id: string): unknown; upsert(value: unknown): unknown; delete(id: string): void };
      fields: string[];
      notFound: string;
      mismatch: string;
    },
  ): Promise<Response> {
    const { store, fields, notFound, mismatch } = options;
    if (route.length === 0 && request.method === 'GET') {
      return this.success({ items: store.list() }, requestId);
    }
    if (route.length === 0 && request.method === 'POST') {
      this.requireMutationProtection(request, url, sessionToken);
      return this.success(store.upsert(await this.readJson(request, fields)), requestId, 201);
    }
    if (route.length === 1 && request.method === 'GET') {
      const item = store.get(route[0]!);
      if (!item) throw failure('not_found', 404, notFound);
      return this.success(item, requestId);
    }
    if (route.length === 1 && request.method === 'PUT') {
      this.requireMutationProtection(request, url, sessionToken);
      const body = await this.readJson(request, fields);
      if (body.id !== route[0]) throw failure('invalid_request', 400, mismatch);
      return this.success(store.upsert(body), requestId);
    }
    if (route.length === 1 && request.method === 'DELETE') {
      this.requireMutationProtection(request, url, sessionToken);
      await this.readJson(request, []);
      store.delete(route[0]!);
      return new Response(null, { status: 204, headers: API_CACHE_HEADERS });
    }
    throw failure('not_found', 404, '资源不存在');
  }

  private async syncConfigRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    const store = this.syncConfigs;
    if (!store) throw failure('not_ready', 503, '同步密钥存储未配置', true);
    return await this.settingsCollectionRoute(request, url, route, requestId, sessionToken, {
      store,
      fields: ['id', 'enabled', 'lastSyncTime', 'syncInterval', 'syncType', 'syncParams', 'apiEndpoint', 'secret'],
      notFound: '同步配置不存在',
      mismatch: '同步配置 ID 不匹配',
    });
  }

  // Model and sync collections share HTTP mechanics but enforce distinct schemas and secret stores.
  // fallow-ignore-next-line code-duplication
  private async aiModelRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    const store = this.models;
    if (!store) throw failure('not_ready', 503, 'AI 密钥存储未配置', true);
    return await this.settingsCollectionRoute(request, url, route, requestId, sessionToken, {
      store,
      fields: [
        'id',
        'name',
        'provider',
        'model',
        'temperature',
        'maxInputTokens',
        'maxOutputTokens',
        'rateLimit',
        'apiKey',
        'baseUrl',
        'isDefault',
        'customHeaders',
        'enabled',
        'lastEdited',
      ],
      notFound: 'AI 模型不存在',
      mismatch: 'AI 模型 ID 不匹配',
    });
  }

  // AI execution must retain its own gateway and streaming path rather than become a CRUD collection.
  // fallow-ignore-next-line code-duplication
  private async aiRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    const store = this.models;
    if (!store) throw failure('not_ready', 503, 'AI 密钥存储未配置', true);
    if (route.length !== 3 || route[0] !== 'models' || (route[2] !== 'test' && route[2] !== 'generate')) {
      throw failure('not_found', 404, '资源不存在');
    }
    this.requireMutationProtection(request, url, sessionToken);
    const configured = store.getForGateway(route[1]!);
    if (!configured || !configured.model.enabled) throw failure('not_found', 404, 'AI 模型不存在或未启用');
    if (route[2] === 'test') {
      await this.readJson(request, []);
      return this.success(await this.aiGateway.test(route[1]!, configured), requestId);
    }
    const body = await this.readJson(request, ['prompt', 'messages', 'temperature', 'maxOutputTokens']);
    return this.aiStreamResponse(route[1]!, configured, this.aiRequest(body));
  }

  private async providerCredentialRoute(
    request: Request,
    url: URL,
    route: string[],
    requestId: string,
    sessionToken: string,
  ): Promise<Response> {
    const store = this.providerCredentials;
    if (!store) throw failure('not_ready', 503, '服务商密钥存储未配置', true);
    const fields = [
      'provider',
      'label',
      'secret',
      'authorizedForUse',
      'enabled',
      'maxConcurrency',
      'paidPlan',
      'paidEnabled',
      'monthlyCostLimitMicros',
    ];
    if (route.length === 0 && request.method === 'GET') {
      return this.success({ items: await store.list() }, requestId);
    }
    if (route.length === 0 && request.method === 'POST') {
      this.requireMutationProtection(request, url, sessionToken);
      return this.success(await store.upsert(this.providerCredentialInput(await this.readJson(request, fields))), requestId, 201);
    }
    if (route.length === 1 && request.method === 'PUT') {
      this.requireMutationProtection(request, url, sessionToken);
      return this.success(
        await store.upsert({ ...this.providerCredentialInput(await this.readJson(request, fields)), id: route[0]! }),
        requestId,
      );
    }
    if (route.length === 1 && request.method === 'DELETE') {
      this.requireMutationProtection(request, url, sessionToken);
      await store.remove(route[0]!);
      return new Response(null, { status: 204, headers: API_CACHE_HEADERS });
    }
    throw failure('not_found', 404, '资源不存在');
  }

  private async requireSession(request: Request): Promise<string> {
    const token = parseCookies(request).get(sessionCookieName);
    if (!(await this.auth.verifySession(token))) throw failure('not_authenticated', 401, '需要登录');
    return token!;
  }

  private validateRouteIdentifiers(route: string[]): void {
    const identifiers =
      route[0] === 'library' && route[1] === 'books'
        ? [route[2], route[4], route[6]]
        : route[0] === 'import-jobs'
          ? [route[1]]
          : route[0] === 'settings' && ['import-providers', 'ai-models', 'sync-configs'].includes(route[1] ?? '')
            ? [route[2]]
            : route[0] === 'ai' && route[1] === 'models'
              ? [route[2]]
              : [];
    for (const value of identifiers) {
      if (value !== undefined) requireString(value, '路径 ID', 128);
    }
  }

  private requireMutationProtection(request: Request, url: URL, sessionToken: string): void {
    this.requireOrigin(request, url);
    const csrfCookie = parseCookies(request).get(csrfCookieName);
    const csrfHeader = request.headers.get('x-csrf-token');
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      throw failure('csrf_rejected', 403, 'CSRF 校验失败');
    }
    if (!sessionToken) throw failure('not_authenticated', 401, '需要登录');
    if (!this.auth.verifyCsrf(sessionToken, csrfCookie)) {
      throw failure('csrf_rejected', 403, 'CSRF 校验失败');
    }
  }

  private requireOrigin(request: Request, url: URL): void {
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    if (origin !== (this.publicOrigin ?? url.origin) || (fetchSite !== null && fetchSite !== 'same-origin')) {
      throw failure('csrf_rejected', 403, '请求来源被拒绝');
    }
  }

  private async readJson(request: Request, allowed: string[], maxBytes = JSON_LIMIT_BYTES): Promise<Record<string, unknown>> {
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw failure('invalid_request', 415, '请求内容类型无效');
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw failure('payload_too_large', 413, '请求内容过大');
    }
    const text = await readLimitedText(request, maxBytes);
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw failure('invalid_request', 400, '请求 JSON 无效');
    }
    if (!isRecord(value)) throw failure('invalid_request', 400, '请求 JSON 无效');
    const allowedKeys = new Set(allowed);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) throw failure('invalid_request', 400, '请求包含未知字段');
    }
    return value;
  }

  private createImportRequest(value: Record<string, unknown>): CreateImportJobRequest {
    const mode = value.mode;
    if (mode !== 'preview' && mode !== 'import' && mode !== 'refresh') {
      throw failure('invalid_request', 400, '导入模式无效');
    }
    const chapters = value.selectedRemoteChapterIds;
    if (chapters !== undefined && (!Array.isArray(chapters) || chapters.some((id) => typeof id !== 'string'))) {
      throw failure('invalid_request', 400, '选择章节无效');
    }
    if (value.privateUseAcknowledged !== undefined && typeof value.privateUseAcknowledged !== 'boolean') {
      throw failure('invalid_request', 400, '个人使用确认无效');
    }
    return {
      url: requireString(value.url, '来源 URL', 4096),
      mode,
      idempotencyKey: requireString(value.idempotencyKey, '幂等键', 256),
      ...(chapters ? { selectedRemoteChapterIds: chapters as string[] } : {}),
      ...(value.privateUseAcknowledged === true ? { privateUseAcknowledged: true } : {}),
      ...(value.maxProviderCostMicros !== undefined
        ? { maxProviderCostMicros: requireInteger(value.maxProviderCostMicros, '服务商预算', 0) }
        : {}),
    };
  }

  private providerCredentialInput(value: Record<string, unknown>): ProviderCredentialInput {
    const provider = value.provider;
    if (provider !== 'scrape-do' && provider !== 'scrapingant' && provider !== 'zenrows' && provider !== 'zyte') {
      throw failure('invalid_request', 400, '服务商无效');
    }
    if (value.authorizedForUse !== true) throw failure('invalid_request', 400, '必须确认授权使用');
    const enabled = value.enabled;
    const paidPlan = value.paidPlan;
    const paidEnabled = value.paidEnabled;
    if (
      (enabled !== undefined && typeof enabled !== 'boolean') ||
      (paidPlan !== undefined && typeof paidPlan !== 'boolean') ||
      (paidEnabled !== undefined && typeof paidEnabled !== 'boolean')
    ) {
      throw failure('invalid_request', 400, '服务商配置无效');
    }
    return {
      provider,
      label: requireString(value.label, '服务商标签', 256),
      secret: requireString(value.secret, '服务商密钥', 4096),
      authorizedForUse: true,
      maxConcurrency: requireInteger(value.maxConcurrency, '服务商并发', 1, 100),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(paidPlan !== undefined ? { paidPlan } : {}),
      ...(paidEnabled !== undefined ? { paidEnabled } : {}),
      ...(value.monthlyCostLimitMicros !== undefined
        ? { monthlyCostLimitMicros: requireInteger(value.monthlyCostLimitMicros, '月度预算', 0) }
        : {}),
    };
  }

  private aiRequest(value: Record<string, unknown>): ServerAIRequest {
    const prompt = value.prompt;
    const messages = value.messages;
    if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > 1_000_000)) {
      throw failure('invalid_request', 400, 'AI 提示词无效');
    }
    if (
      messages !== undefined &&
      (!Array.isArray(messages) ||
        messages.length > 100 ||
        messages.some(
          (message) =>
            !isRecord(message) ||
            !['system', 'user', 'assistant'].includes(String(message.role)) ||
            typeof message.content !== 'string' ||
            message.content.length > 1_000_000,
        ))
    ) {
      throw failure('invalid_request', 400, 'AI 消息无效');
    }
    if (!prompt && (!messages || messages.length === 0)) {
      throw failure('invalid_request', 400, 'AI 提示词或消息不能为空');
    }
    const temperature = value.temperature;
    if (
      temperature !== undefined &&
      (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    ) {
      throw failure('invalid_request', 400, 'AI 温度无效');
    }
    return {
      ...(typeof prompt === 'string' ? { prompt } : {}),
      ...(Array.isArray(messages)
        ? {
            messages: messages.map((message) => {
              const row = message as Record<string, unknown>;
              return { role: row.role as 'system' | 'user' | 'assistant', content: row.content as string };
            }),
          }
        : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(value.maxOutputTokens !== undefined
        ? { maxOutputTokens: requireInteger(value.maxOutputTokens, 'AI 最大输出 token', 1, 10_000_000) }
        : {}),
    };
  }

  private aiStreamResponse(
    modelId: string,
    config: { model: ServerModelSummary; apiKey: string },
    request: ServerAIRequest,
  ): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for await (const chunk of this.aiGateway.stream(modelId, config, request)) {
            controller.enqueue(encoder.encode(sseFrame(chunk.done ? 'done' : 'chunk', chunk)));
          }
          controller.close();
        } catch {
          controller.enqueue(encoder.encode(sseFrame('error', { code: 'internal', message: 'AI 生成失败' })));
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        ...API_CACHE_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        connection: 'keep-alive',
      },
    });
  }

  private sseResponse(request: Request, url: URL, jobId: string, sessionToken: string): Response {
    const cursor = parseEventCursor(request, url);
    const job = this.imports.get(jobId);
    if (!job) throw failure('not_found', 404, '导入任务不存在');
    const events = this.imports.eventsAfter(jobId, 0);
    const oldest = this.imports.oldestEventId(jobId);
    const reset = oldest !== undefined && cursor < oldest - 1;
    const effectiveCursor = reset ? oldest - 1 : cursor;
    let sentThrough = effectiveCursor;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        const send = (name: string, data: unknown, id?: number) => controller.enqueue(encoder.encode(sseFrame(name, data, id)));
        const snapshot = () => ({ job: this.imports.get(jobId), items: this.imports.listItems(jobId) });
        send('snapshot', snapshot());
        if (reset) send('reset', snapshot());
        const flush = () => {
          const session = this.auth.verifySession(sessionToken);
          void session.then((active) => {
            if (closed) return;
            if (!active) {
              send('session-expired', {});
              cleanup();
              controller.close();
              return;
            }
            const pending = this.imports.eventsAfter(jobId, sentThrough);
            for (const event of pending) {
              send(event.name, event.data, event.id);
              sentThrough = event.id;
              if (event.name === 'terminal') {
                cleanup();
                controller.close();
                return;
              }
            }
          });
        };
        for (const event of events.filter((event) => event.id > sentThrough)) {
          send(event.name, event.data, event.id);
          sentThrough = event.id;
          if (event.name === 'terminal') {
            cleanup();
            controller.close();
            return;
          }
        }
        pollTimer = setInterval(flush, this.ssePollIntervalMs);
        heartbeatTimer = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }, this.sseHeartbeatMs);
        request.signal.addEventListener('abort', () => {
          cleanup();
          controller.close();
        }, { once: true });
      },
      cancel: cleanup,
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...API_CACHE_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        connection: 'keep-alive',
      },
    });
  }

  private success(data: unknown, requestId: string, status = 200, headers: HeadersInit = {}): Response {
    return json({ data, requestId }, status, headers);
  }

  private interval(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
      ? (value as number)
      : fallback;
  }

  private errorResponse(error: ApiFailure, requestId: string): Response {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        },
        requestId,
      },
      error.status,
      error.code === 'rate_limited' && error.retryAfterMs !== undefined
        ? { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) }
        : {},
    );
  }

  private normalizeError(error: unknown): ApiFailure {
    if (error instanceof RequestFailure) return error.failure;
    if (error instanceof AuthServiceError) {
      return {
        code: error.code,
        status: error.status,
        message: error.message,
        retryable: error.code === 'rate_limited',
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    if (error instanceof RepositoryError || error instanceof ImportRepositoryError) {
      const code = error.code === 'unsupported_source' || error.code === 'policy_disallowed' ? error.code : error.code;
      return {
        code,
        status: error.status,
        message: error.message,
        retryable: false,
      };
    }
    return { code: 'internal', status: 500, message: '服务器内部错误', retryable: false };
  }
}

export function createServerApplication(options: ServerApplicationOptions): ServerApplication {
  return new ServerApplication(options);
}

export type { JobEvent };
