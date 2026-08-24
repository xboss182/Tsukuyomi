import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type {
  ImportError,
  ImportFetchProvider,
  ImportFetchRequest,
  ImportFetchResponse,
  ImportFetchResult,
  SourceKey,
} from '../src/models/importer';
import { validateImportFetchRequest } from './import-fetch';
import type {
  ManagedProvider,
  ProviderCredentialVault,
  UsableProviderCredential,
} from './provider-credentials';

const MAX_ATTEMPTS = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

export interface ProviderHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  timeoutMs: number;
  maxBytes: number;
}

export interface ProviderHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type ProviderHttpFetch = (request: ProviderHttpRequest) => Promise<ProviderHttpResponse>;

export interface ProviderDriverContext {
  credential: UsableProviderCredential;
  targetUrl: string;
  mode: 'http' | 'browser';
  timeoutMs: number;
  maxBytes: number;
}

export interface ProviderDriver {
  provider: ManagedProvider;
  /** Worst-case paid request cost in millionths of USD. */
  maxCostMicros: number;
  fetch(context: ProviderDriverContext): Promise<ImportFetchResult>;
}

interface KeyRuntime {
  inFlight: number;
  cooldownUntil: number;
  failureStreak: number;
}

interface GatewayOptions {
  credentials: ProviderCredentialVault;
  directFetch: (request: ImportFetchRequest) => Promise<ImportFetchResult>;
  drivers: ProviderDriver[];
  now?: (() => number) | undefined;
}

function error(
  code: ImportError['code'],
  message: string,
  retryable = false,
  status?: number,
): ImportError {
  return { code, message, retryable, ...(status === undefined ? {} : { status }) };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizedContentType(value: string | undefined): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || 'text/html';
}

function normalizedResponse(
  targetUrl: string,
  finalUrl: string,
  status: number,
  contentType: string,
  body: string,
  maxBytes: number,
): ImportFetchResult {
  const byteLength = Buffer.byteLength(body);
  if (byteLength > maxBytes) {
    return { ok: false, error: error('response_too_large', '服务商响应超过大小限制') };
  }
  if (status < 200 || status >= 300) {
    if (isChallengeResponse(status, body)) {
      return { ok: false, error: error('challenge_detected', '来源返回了验证挑战', true, status) };
    }
    return {
      ok: false,
      error: error(
        status === 429 ? 'rate_limited' : 'http_error',
        `来源返回 HTTP ${status}`,
        status === 408 || status === 429 || status >= 500,
        status,
      ),
    };
  }
  if (isChallengeResponse(status, body)) {
    return { ok: false, error: error('challenge_detected', '来源返回了验证挑战', true, status) };
  }
  return {
    ok: true,
    response: { finalUrl: finalUrl || targetUrl, status, contentType, body, byteLength },
  };
}

export function isChallengeResponse(status: number, body: string): boolean {
  if (status !== 403 && status !== 429 && !/<title>\s*just a moment/i.test(body)) return false;
  return /cf-chl|challenges\.cloudflare\.com|enable javascript and cookies|captcha/i.test(body);
}

function providerFailure(provider: ManagedProvider, status: number, body: string): ImportFetchResult {
  if (status === 401 || status === 402 || status === 403) {
    return {
      ok: false,
      provider,
      error: error('provider_unavailable', '服务商凭据无效或额度不足', false, status),
    };
  }
  const retryable = status === 409 || status === 423 || status === 429 || status >= 500;
  return {
    ok: false,
    provider,
    error: error(
      status === 409 || status === 429 ? 'rate_limited' : 'provider_error',
      `服务商返回 HTTP ${status}${body ? '' : ''}`,
      retryable,
      status,
    ),
  };
}

function withProvider(result: ImportFetchResult, provider: ManagedProvider): ImportFetchResult {
  return { ...result, provider };
}

function scrapeDoDriver(http: ProviderHttpFetch): ProviderDriver {
  return {
    provider: 'scrape-do',
    maxCostMicros: 1_160,
    async fetch(context) {
      const url = new URL('https://api.scrape.do/');
      url.searchParams.set('token', context.credential.secret);
      url.searchParams.set('url', context.targetUrl);
      url.searchParams.set('disableRetry', 'true');
      url.searchParams.set('timeout', String(context.timeoutMs));
      if (context.mode === 'browser') url.searchParams.set('render', 'true');
      const response = await http({
        url: url.href,
        method: 'GET',
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes,
      });
      if (response.status === 401 || response.status === 429 || response.status >= 500) {
        return providerFailure('scrape-do', response.status, response.body.toString('utf8'));
      }
      const result = normalizedResponse(
        context.targetUrl,
        header(response.headers, 'scrape.do-resolved-url') || context.targetUrl,
        response.status,
        normalizedContentType(header(response.headers, 'content-type')),
        response.body.toString('utf8'),
        context.maxBytes,
      );
      return {
        ...withProvider(result, 'scrape-do'),
        providerCreditsUsed: positiveInteger(header(response.headers, 'scrape.do-request-cost')),
      };
    },
  };
}

function scrapingAntDriver(http: ProviderHttpFetch): ProviderDriver {
  return {
    provider: 'scrapingant',
    maxCostMicros: 1_900,
    async fetch(context) {
      const url = new URL('https://api.scrapingant.com/v2/extended');
      url.searchParams.set('x-api-key', context.credential.secret);
      url.searchParams.set('url', context.targetUrl);
      url.searchParams.set('browser', String(context.mode === 'browser'));
      url.searchParams.set('proxy_type', 'datacenter');
      url.searchParams.set('timeout', String(Math.max(5, Math.floor(context.timeoutMs / 1000))));
      const response = await http({
        url: url.href,
        method: 'GET',
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes + 64 * 1024,
      });
      if (response.status < 200 || response.status >= 300) {
        return providerFailure('scrapingant', response.status, response.body.toString('utf8'));
      }
      try {
        const payload = JSON.parse(response.body.toString('utf8')) as {
          html?: unknown;
          status_code?: unknown;
          headers?: Array<{ name?: unknown; value?: unknown }>;
        };
        if (typeof payload.html !== 'string' || typeof payload.status_code !== 'number') {
          throw new Error('invalid');
        }
        const contentType = payload.headers?.find(
          (item) => typeof item.name === 'string' && item.name.toLowerCase() === 'content-type',
        )?.value;
        const result = normalizedResponse(
          context.targetUrl,
          context.targetUrl,
          payload.status_code,
          normalizedContentType(typeof contentType === 'string' ? contentType : undefined),
          payload.html,
          context.maxBytes,
        );
        return {
          ...withProvider(result, 'scrapingant'),
          providerCreditsUsed: positiveInteger(header(response.headers, 'ant-credits-cost')),
        };
      } catch {
        return {
          ok: false,
          provider: 'scrapingant',
          error: error('provider_error', 'ScrapingAnt 响应格式无效'),
        };
      }
    },
  };
}

function zenRowsDriver(http: ProviderHttpFetch): ProviderDriver {
  return {
    provider: 'zenrows',
    maxCostMicros: 8_800,
    async fetch(context) {
      const url = new URL('https://api.zenrows.com/v1/');
      url.searchParams.set('apikey', context.credential.secret);
      url.searchParams.set('url', context.targetUrl);
      url.searchParams.set('original_status', 'true');
      if (context.mode === 'browser') url.searchParams.set('js_render', 'true');
      const response = await http({
        url: url.href,
        method: 'GET',
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes,
      });
      if ([401, 402, 422, 429].includes(response.status) || response.status >= 500) {
        return providerFailure('zenrows', response.status, response.body.toString('utf8'));
      }
      return withProvider(
        normalizedResponse(
          context.targetUrl,
          header(response.headers, 'zr-final-url') || context.targetUrl,
          response.status,
          normalizedContentType(header(response.headers, 'content-type')),
          response.body.toString('utf8'),
          context.maxBytes,
        ),
        'zenrows',
      );
    },
  };
}

function zyteDriver(http: ProviderHttpFetch): ProviderDriver {
  return {
    provider: 'zyte',
    maxCostMicros: 16_080,
    async fetch(context) {
      const requestBody = JSON.stringify({
        url: context.targetUrl,
        ...(context.mode === 'browser'
          ? { browserHtml: true }
          : { httpResponseBody: true, httpResponseHeaders: true }),
      });
      const response = await http({
        url: 'https://api.zyte.com/v1/extract',
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${context.credential.secret}:`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: requestBody,
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes * 2 + 64 * 1024,
      });
      if (response.status < 200 || response.status >= 300) {
        return providerFailure('zyte', response.status, response.body.toString('utf8'));
      }
      try {
        const payload = JSON.parse(response.body.toString('utf8')) as {
          url?: unknown;
          statusCode?: unknown;
          browserHtml?: unknown;
          httpResponseBody?: unknown;
          httpResponseHeaders?: Array<{ name?: unknown; value?: unknown }>;
        };
        if (typeof payload.url !== 'string' || typeof payload.statusCode !== 'number') {
          throw new Error('invalid');
        }
        const body =
          context.mode === 'browser'
            ? payload.browserHtml
            : typeof payload.httpResponseBody === 'string'
              ? Buffer.from(payload.httpResponseBody, 'base64').toString('utf8')
              : undefined;
        if (typeof body !== 'string') throw new Error('invalid');
        const contentType = payload.httpResponseHeaders?.find(
          (item) => typeof item.name === 'string' && item.name.toLowerCase() === 'content-type',
        )?.value;
        return withProvider(
          normalizedResponse(
            context.targetUrl,
            payload.url,
            payload.statusCode,
            normalizedContentType(typeof contentType === 'string' ? contentType : undefined),
            body,
            context.maxBytes,
          ),
          'zyte',
        );
      } catch {
        return { ok: false, provider: 'zyte', error: error('provider_error', 'Zyte 响应格式无效') };
      }
    },
  };
}

export function createProviderDrivers(http: ProviderHttpFetch): ProviderDriver[] {
  return [scrapeDoDriver(http), scrapingAntDriver(http), zenRowsDriver(http), zyteDriver(http)];
}

function targetLimits(request: ImportFetchRequest): { timeoutMs: number; maxBytes: number } {
  const validated = validateImportFetchRequest(request);
  return { timeoutMs: validated.timeoutMs, maxBytes: validated.maxBytes };
}

function eligibleForFallback(result: ImportFetchResult): boolean {
  return (
    !result.ok &&
    (result.error.retryable ||
      result.error.code === 'challenge_detected' ||
      result.error.code === 'provider_unavailable')
  );
}

function providerRouteForSource(sourceKey: SourceKey): ImportFetchProvider[] {
  if (sourceKey === 'freewebnovel') return ['scrape-do', 'scrapingant', 'zenrows', 'zyte'];
  if (sourceKey === 'nobadnovel' || sourceKey === 'novellunar') {
    return ['direct', 'scrape-do', 'scrapingant', 'zenrows', 'zyte'];
  }
  return ['direct'];
}

export class PrivateScraperGateway {
  private readonly now: () => number;
  private readonly runtime = new Map<string, KeyRuntime>();
  private readonly cursors = new Map<ManagedProvider, number>();

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? Date.now;
  }

  private state(id: string): KeyRuntime {
    const existing = this.runtime.get(id);
    if (existing) return existing;
    const created = { inFlight: 0, cooldownUntil: 0, failureStreak: 0 };
    this.runtime.set(id, created);
    return created;
  }

  private async select(provider: ManagedProvider): Promise<UsableProviderCredential | undefined> {
    const credentials = (await this.options.credentials.usable(provider)).filter((credential) => {
      const state = this.state(credential.id);
      return state.cooldownUntil <= this.now() && state.inFlight < credential.maxConcurrency;
    });
    if (credentials.length === 0) return undefined;
    const cursor = this.cursors.get(provider) ?? 0;
    const credential = credentials[cursor % credentials.length];
    this.cursors.set(provider, cursor + 1);
    return credential;
  }

  private validateFinal(request: ImportFetchRequest, response: ImportFetchResponse): ImportFetchResult {
    try {
      const final = validateImportFetchRequest({ ...request, url: response.finalUrl });
      const original = validateImportFetchRequest(request);
      if (final.url.hostname !== original.url.hostname || final.url.pathname !== original.url.pathname) {
        return { ok: false, error: error('unsafe_redirect', '服务商返回了非预期来源地址') };
      }
      return { ok: true, response };
    } catch {
      return { ok: false, error: error('unsafe_redirect', '服务商返回了不安全地址') };
    }
  }

  async fetch(request: ImportFetchRequest): Promise<ImportFetchResult> {
    let limits: { timeoutMs: number; maxBytes: number };
    try {
      limits = targetLimits(request);
    } catch {
      return { ok: false, error: error('invalid_url', '导入请求无效') };
    }
    const route = providerRouteForSource(request.sourceKey);
    let attempts = 0;
    let last: ImportFetchResult = {
      ok: false,
      error: error('provider_unavailable', '没有可用的抓取路径'),
    };

    for (const provider of route) {
      while (attempts < MAX_ATTEMPTS) {
        attempts += 1;
        const outcome = await this.attemptProvider(provider, request, limits);
        last = { ...outcome, attempts };
        if (outcome.ok) return { ...outcome, attempts };
        if (outcome.stopRoute) break;
      }
      if (attempts >= MAX_ATTEMPTS) break;
      if (!eligibleForFallback(last)) return { ...last, attempts };
    }
    return { ...last, attempts };
  }

  private async attemptProvider(
    provider: ImportFetchProvider,
    request: ImportFetchRequest,
    limits: { timeoutMs: number; maxBytes: number },
  ): Promise<ImportFetchResult & { stopRoute?: boolean }> {
    if (provider === 'direct') {
      const result = await this.options.directFetch(request);
      if (result.ok) return { ...this.validateFinal(request, result.response), provider: 'direct' };
      return { ...result, provider: 'direct', stopRoute: true };
    }

    const driver = this.options.drivers.find((candidate) => candidate.provider === provider);
    if (!driver) return { ok: false, error: error('provider_unavailable', `${provider} 未安装`), stopRoute: true };
    const credential = await this.select(provider);
    if (!credential) return { ok: false, error: error('provider_unavailable', `${provider} 未配置凭据`), stopRoute: true };

    const paidCost = credential.paidPlan ? driver.maxCostMicros : 0;
    const used = request.providerCostMicrosUsed ?? 0;
    const ceiling = request.maxProviderCostMicros ?? 0;
    if (paidCost > 0 && (ceiling <= 0 || used + paidCost > ceiling)) {
      return { ok: false, provider, error: error('budget_exceeded', '抓取服务商费用上限已达到'), stopRoute: true };
    }

    const state = this.state(credential.id);
    state.inFlight += 1;
    let result: ImportFetchResult;
    try {
      result = await driver.fetch({ credential, targetUrl: request.url, mode: 'browser', ...limits });
    } catch {
      result = { ok: false, provider, error: error('provider_error', '抓取服务商请求失败', true) };
    } finally {
      state.inFlight -= 1;
    }
    if (paidCost > 0) await this.options.credentials.recordCost(credential.id, paidCost);
    if (result.ok) {
      state.failureStreak = 0;
      return { ...this.validateFinal(request, result.response), provider, costMicros: paidCost };
    }
    if (result.error.code === 'provider_unavailable' && [401, 402, 403].includes(result.error.status ?? 0)) {
      await this.options.credentials.disable(credential.id);
      return { ...result, provider, stopRoute: false };
    }
    if (result.error.code === 'rate_limited') {
      state.cooldownUntil = this.now() + (result.error.retryAfterMs ?? DEFAULT_COOLDOWN_MS);
      return { ...result, provider, stopRoute: false };
    }
    if (result.error.retryable) {
      state.failureStreak += 1;
      if (state.failureStreak >= 3) state.cooldownUntil = this.now() + CIRCUIT_COOLDOWN_MS;
    }
    return { ...result, provider, costMicros: paidCost, stopRoute: eligibleForFallback(result) };
  }}

export function performProviderHttpRequest(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(request.url);
    if (
      endpoint.protocol !== 'https:' ||
      !['api.scrape.do', 'api.scrapingant.com', 'api.zenrows.com', 'api.zyte.com'].includes(
        endpoint.hostname,
      )
    ) {
      reject(new Error('服务商端点无效'));
      return;
    }
    const client = httpsRequest(
      endpoint,
      { method: request.method, headers: request.headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > request.maxBytes) {
            response.destroy(new Error('服务商响应超过大小限制'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', reject);
        response.once('end', () => {
          const headers = Object.fromEntries(
            Object.entries(response.headers as IncomingHttpHeaders).flatMap(([name, value]) => {
              if (typeof value === 'string') return [[name.toLowerCase(), value]];
              if (Array.isArray(value)) return [[name.toLowerCase(), value.join(', ')]];
              return [];
            }),
          );
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    client.setTimeout(request.timeoutMs, () => client.destroy(new Error('服务商请求超时')));
    client.once('error', reject);
    if (request.body) client.write(request.body);
    client.end();
  });
}
