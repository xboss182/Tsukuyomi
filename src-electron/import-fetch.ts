import { lookup as nodeLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction, Socket } from 'node:net';
import type { ImportError, ImportErrorCode, ImportFetchRequest, ImportFetchResult } from '../src/models/importer';
import { toError } from '../src/utils/error-message';
import {
  isIpLiteralHost,
  isPublicIpAddress,
  normalizeIpAddress,
} from '../src/services/importer/address-policy';

const MAX_REDIRECTS = 3;
const DNS_AND_CONNECT_TIMEOUT_MS = 5_000;
const METADATA_TIMEOUT_MS = 20_000;
const CHAPTER_TIMEOUT_MS = 30_000;
const TOC_MAX_BYTES = 2 * 1024 * 1024;
const CHAPTER_MAX_BYTES = 1024 * 1024;

export type DnsLookup = (hostname: string) => Promise<LookupAddress[]>;

type ValidatedRequest = {
  url: URL;
  expectedContentType: 'html' | 'json';
  timeoutMs: number;
  maxBytes: number;
};

type RequestOnceResult =
  | { kind: 'response'; result: ImportFetchResult }
  | { kind: 'redirect'; location: string }
  | { kind: 'error'; error: ImportError };

export class ImportFetchPolicyError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportFetchPolicyError';
  }
}

function error(code: ImportErrorCode, message: string, retryable = false): ImportError {
  return { code, message, retryable };
}

export function toImportFetchError(reason: unknown): ImportError {
  if (reason instanceof ImportFetchPolicyError) {
    return error(
      reason.code,
      reason.message,
      reason.code === 'timeout' || reason.code === 'network_error',
    );
  }
  return error('network_error', '导入请求失败', true);
}

function headerValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - Date.now()), 60_000);
}

export function isAllowedImportContentType(
  contentType: string | undefined,
  expected: 'html' | 'json',
): boolean {
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return expected === 'html'
    ? mime === 'text/html' || mime === 'application/xhtml+xml'
    : mime === 'application/json' || mime === 'text/json';
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isImportChallengeResponse(status: number, body: string): boolean {
  if (status !== 403 && status !== 429 && !/<title>\s*just a moment/i.test(body)) return false;
  return /cf-chl|challenges\.cloudflare\.com|enable javascript and cookies|captcha/i.test(body);
}

function cleanUrl(url: URL): URL {
  if (url.hash) url.hash = '';
  return url;
}

function containsUserinfo(rawUrl: string): boolean {
  const authority = rawUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  return authority?.includes('@') === true;
}

function validateKakuyomu(url: URL, kind: ImportFetchRequest['kind']): ValidatedRequest {
  if (url.hostname !== 'kakuyomu.jp' || url.search || url.hash) {
    throw new ImportFetchPolicyError('invalid_url', 'Kakuyomu 导入地址无效');
  }
  const match = url.pathname.match(/^\/works\/(\d+)(?:\/episodes\/(\d+))?\/?$/);
  if (!match?.[1]) throw new ImportFetchPolicyError('invalid_url', 'Kakuyomu 导入地址无效');
  const hasEpisode = Boolean(match[2]);
  if ((kind === 'chapter') !== hasEpisode || (kind !== 'chapter' && hasEpisode)) {
    throw new ImportFetchPolicyError('policy_disallowed', '该导入请求不符合 Kakuyomu 来源策略');
  }
  return {
    url,
    expectedContentType: 'html',
    timeoutMs: kind === 'chapter' ? CHAPTER_TIMEOUT_MS : METADATA_TIMEOUT_MS,
    maxBytes: kind === 'chapter' ? CHAPTER_MAX_BYTES : TOC_MAX_BYTES,
  };
}

function validateNarou(url: URL, kind: ImportFetchRequest['kind']): ValidatedRequest {
  if (
    kind !== 'metadata' ||
    url.hostname !== 'api.syosetu.com' ||
    url.pathname !== '/novelapi/api/' ||
    url.hash
  ) {
    throw new ImportFetchPolicyError('policy_disallowed', 'Narou 仅支持官方 API 元数据导入');
  }
  const entries = Array.from(url.searchParams.entries());
  const ncode = url.searchParams.get('ncode');
  if (
    entries.length !== 2 ||
    url.searchParams.get('out') !== 'json' ||
    !ncode ||
    !/^n[a-z0-9]{5,6}$/i.test(ncode) ||
    entries.some(([key]) => key !== 'out' && key !== 'ncode')
  ) {
    throw new ImportFetchPolicyError('invalid_url', 'Narou API 请求无效');
  }
  return {
    url,
    expectedContentType: 'json',
    timeoutMs: METADATA_TIMEOUT_MS,
    maxBytes: TOC_MAX_BYTES,
  };
}

function validatePrivateNovelSource(
  url: URL,
  kind: ImportFetchRequest['kind'],
  hosts: ReadonlySet<string>,
  workPattern: RegExp,
  chapterPattern: RegExp,
  sourceName: string,
): ValidatedRequest {
  if (!hosts.has(url.hostname) || url.search || url.hash || kind === 'metadata') {
    throw new ImportFetchPolicyError('policy_disallowed', `${sourceName} 导入请求不符合来源策略`);
  }
  const chapter = chapterPattern.test(url.pathname);
  if ((kind === 'chapter') !== chapter || (!chapter && !workPattern.test(url.pathname))) {
    throw new ImportFetchPolicyError('invalid_url', `${sourceName} 导入地址无效`);
  }
  return {
    url,
    expectedContentType: 'html',
    timeoutMs: chapter ? CHAPTER_TIMEOUT_MS : METADATA_TIMEOUT_MS,
    maxBytes: chapter ? CHAPTER_MAX_BYTES : TOC_MAX_BYTES,
  };
}

/** Validate a renderer request as an adapter-owned URL, not as a generic proxy target. */
export function validateImportFetchRequest(request: unknown): ValidatedRequest {
  if (
    !request ||
    typeof request !== 'object' ||
    ![
      'kakuyomu',
      'narou-metadata',
      'nobadnovel',
      'freewebnovel',
      'novellunar',
    ].includes((request as { sourceKey?: unknown }).sourceKey as string) ||
    !['metadata', 'toc', 'chapter'].includes((request as { kind?: unknown }).kind as string) ||
    typeof (request as { url?: unknown }).url !== 'string'
  ) {
    throw new ImportFetchPolicyError('invalid_url', '导入请求无效');
  }
  const typedRequest = request as ImportFetchRequest;
  let url: URL;
  try {
    if (containsUserinfo(typedRequest.url)) {
      throw new ImportFetchPolicyError('invalid_url', '导入地址无效');
    }
    url = cleanUrl(new URL(typedRequest.url));
  } catch {
    throw new ImportFetchPolicyError('invalid_url', '导入地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    isIpLiteralHost(url.hostname)
  ) {
    throw new ImportFetchPolicyError('invalid_url', '导入地址无效');
  }
  switch (typedRequest.sourceKey) {
    case 'kakuyomu':
      return validateKakuyomu(url, typedRequest.kind);
    case 'narou-metadata':
      return validateNarou(url, typedRequest.kind);
    case 'nobadnovel':
      return validatePrivateNovelSource(
        url,
        typedRequest.kind,
        new Set(['nobadnovel.com', 'www.nobadnovel.com']),
        /^\/series\/[a-z0-9-]+\/?$/i,
        /^\/series\/[a-z0-9-]+\/chapter-[a-z0-9-]+\/?$/i,
        'NoBadNovel',
      );
    case 'freewebnovel':
      return validatePrivateNovelSource(
        url,
        typedRequest.kind,
        new Set(['freewebnovel.com', 'www.freewebnovel.com']),
        /^\/novel\/[a-z0-9-]+\/?$/i,
        /^\/novel\/[a-z0-9-]+\/chapter-[a-z0-9.-]+\/?$/i,
        'FreeWebNovel',
      );
    case 'novellunar':
      return validatePrivateNovelSource(
        url,
        typedRequest.kind,
        new Set(['novellunar.com', 'www.novellunar.com']),
        /^\/novel\/[a-z0-9-]+\/?$/i,
        /^\/novel\/[a-z0-9-]+\/chapter\/\d+\/?$/i,
        'NovelLunar',
      );
  }
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return nodeLookup(hostname, { all: true, verbatim: true });
}

/** Resolve every hop and refuse a hostname with any private/special answer. */
export async function resolvePublicAddress(
  hostname: string,
  lookup: DnsLookup = defaultLookup,
): Promise<LookupAddress> {
  if (isIpLiteralHost(hostname)) {
    throw new ImportFetchPolicyError('unsafe_address', '不允许使用 IP 字面量地址');
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new ImportFetchPolicyError('network_error', '无法解析导入来源地址');
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address.address))) {
    throw new ImportFetchPolicyError('unsafe_address', '导入来源解析到了不安全地址');
  }
  const selected = addresses[0];
  if (!selected) throw new ImportFetchPolicyError('network_error', '无法解析导入来源地址');
  return selected;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ImportFetchPolicyError('timeout', message)),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(toError(reason, message));
      },
    );
  });
}

function checkPinnedSocket(socket: Socket, address: LookupAddress): void {
  const expected = normalizeIpAddress(address.address);
  const actual = socket.remoteAddress ? normalizeIpAddress(socket.remoteAddress) : null;
  if (!expected || !actual || expected !== actual || !isPublicIpAddress(socket.remoteAddress || '')) {
    throw new ImportFetchPolicyError('unsafe_address', '导入连接未连接到已验证地址');
  }
}

export function createPinnedLookup(address: LookupAddress): LookupFunction {
  return ((_hostname, options, callback) => {
    if (typeof options === 'object' && options !== null && 'all' in options && options.all === true) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  }) as LookupFunction;
}

export function classifyImportHttpError(
  status: number,
  retryAfter: string | undefined,
): ImportError {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  return {
    ...error(
      status === 429 ? 'rate_limited' : 'http_error',
      `导入来源返回 HTTP ${status}`,
      isRetryableHttpStatus(status),
    ),
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function requestOnce(validated: ValidatedRequest, pinned: LookupAddress): Promise<RequestOnceResult> {
  return new Promise<RequestOnceResult>((resolve) => {
    let settled = false;
    let connected = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let request: ClientRequest | undefined;

    const finish = (result: RequestOnceResult): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (totalTimer) clearTimeout(totalTimer);
      resolve(result);
    };

    const fail = (value: unknown): void => {
      finish({ kind: 'error', error: toImportFetchError(value) });
    };

    try {
      request = httpsRequest(
        {
          protocol: 'https:',
          hostname: validated.url.hostname,
          port: 443,
          path: `${validated.url.pathname}${validated.url.search}`,
          method: 'GET',
          servername: validated.url.hostname,
          rejectUnauthorized: true,
          agent: false,
          lookup: createPinnedLookup(pinned),
          headers: {
            Accept:
              validated.expectedContentType === 'json'
                ? 'application/json'
                : 'text/html,application/xhtml+xml',
            'User-Agent': 'Tsukuyomi personal-library importer',
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = headerValue(response.headers, 'location');
          if (status >= 300 && status < 400) {
            response.resume();
            if (location) finish({ kind: 'redirect', location });
            else finish({ kind: 'error', error: error('http_error', '导入来源返回无效重定向') });
            return;
          }
          if (status < 200 || status >= 300) {
            if (status === 403 || status === 429) {
              collectResponseBody(response, validated.maxBytes, (result) => {
                if (result.ok && isImportChallengeResponse(status, result.body)) {
                  finish({
                    kind: 'error',
                    error: error('challenge_detected', '导入来源返回了验证挑战', true),
                  });
                  return;
                }
                finish({
                  kind: 'error',
                  error: result.ok
                    ? classifyImportHttpError(status, headerValue(response.headers, 'retry-after'))
                    : result.error,
                });
              });
              return;
            }
            response.resume();
            finish({
              kind: 'error',
              error: classifyImportHttpError(status, headerValue(response.headers, 'retry-after')),
            });
            return;
          }
          const contentType = headerValue(response.headers, 'content-type');
          if (!isAllowedImportContentType(contentType, validated.expectedContentType)) {
            response.resume();
            finish({
              kind: 'error',
              error: error('unexpected_content_type', '导入来源返回了不支持的内容类型'),
            });
            return;
          }
          const contentLength = Number(headerValue(response.headers, 'content-length'));
          if (Number.isFinite(contentLength) && contentLength > validated.maxBytes) {
            response.resume();
            finish({
              kind: 'error',
              error: error('response_too_large', '导入来源响应超过大小限制'),
            });
            return;
          }
          collectResponseBody(response, validated.maxBytes, (result) => {
            if (!result.ok) {
              finish({ kind: 'error', error: result.error });
              return;
            }
            finish({
              kind: 'response',
              result: {
                ok: true,
                response: {
                  finalUrl: validated.url.href,
                  status,
                  contentType: contentType || '',
                  body: result.body,
                  byteLength: result.byteLength,
                },
              },
            });
          });
        },
      );

      request.once('socket', (socket) => {
        const verify = () => {
          try {
            checkPinnedSocket(socket, pinned);
            connected = true;
            if (connectTimer) clearTimeout(connectTimer);
          } catch (reason) {
            request?.destroy(reason as Error);
          }
        };
        socket.once('secureConnect', verify);
        socket.once('connect', () => {
          if (!connected && socket.remoteAddress) verify();
        });
      });
      connectTimer = setTimeout(() => {
        request?.destroy(new ImportFetchPolicyError('timeout', '导入连接超时'));
      }, DNS_AND_CONNECT_TIMEOUT_MS);
      totalTimer = setTimeout(() => {
        request?.destroy(new ImportFetchPolicyError('timeout', '导入请求超时'));
      }, validated.timeoutMs);
      request.once('error', fail);
      request.end();
    } catch (reason) {
      fail(reason);
    }
  });
}

function collectResponseBody(
  response: IncomingMessage,
  maxBytes: number,
  callback: (result: { ok: true; body: string; byteLength: number } | { ok: false; error: ImportError }) => void,
): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let completed = false;
  const finish = (result: Parameters<typeof callback>[0]) => {
    if (completed) return;
    completed = true;
    callback(result);
  };
  response.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      response.destroy();
      finish({ ok: false, error: error('response_too_large', '导入来源响应超过大小限制') });
      return;
    }
    chunks.push(buffer);
  });
  response.once('error', () => finish({ ok: false, error: error('network_error', '读取导入响应失败', true) }));
  response.once('end', () => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8'), byteLength: total }));
}

/** Electron-main boundary: constrained GET fetch with DNS pinning and validated redirects. */
export async function performImportFetch(request: unknown): Promise<ImportFetchResult> {
  let validated: ValidatedRequest;
  try {
    validated = validateImportFetchRequest(request);
  } catch (reason) {
    if (reason instanceof ImportFetchPolicyError) return { ok: false, error: error(reason.code, reason.message) };
    return { ok: false, error: error('invalid_url', '导入地址无效') };
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    try {
      const pinned = await withTimeout(
        resolvePublicAddress(validated.url.hostname),
        DNS_AND_CONNECT_TIMEOUT_MS,
        '导入来源 DNS 解析超时',
      );
      const once = await requestOnce(validated, pinned);
      if (once.kind === 'response') return once.result;
      if (once.kind === 'error') return { ok: false, error: once.error };
      if (redirects === MAX_REDIRECTS) {
        return { ok: false, error: error('unsafe_redirect', '导入来源重定向次数过多') };
      }
      try {
        const redirectUrl = new URL(once.location, validated.url);
        validated = validateImportFetchRequest({
          ...(request as ImportFetchRequest),
          url: redirectUrl.href,
        });
      } catch {
        return { ok: false, error: error('unsafe_redirect', '导入来源重定向到不安全地址') };
      }
    } catch (reason) {
      return { ok: false, error: toImportFetchError(reason) };
    }
  }
  return { ok: false, error: error('unsafe_redirect', '导入来源重定向次数过多') };
}
