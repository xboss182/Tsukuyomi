import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ImportFetchProvider,
  ImportFetchRequest,
  ImportFetchResult,
} from 'src/models/importer';
import {
  ProviderCredentialVault,
  type CredentialCrypto,
} from '../../src-electron/provider-credentials';
import {
  PrivateScraperGateway,
  createProviderDrivers,
  type ProviderDriver,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
} from '../../src-electron/provider-gateway';

const temporaryDirectories: string[] = [];
const crypto: CredentialCrypto = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`cipher:${value}`, 'utf8'),
  decrypt: (value) => value.toString('utf8').replace(/^cipher:/, ''),
};

async function vault(): Promise<ProviderCredentialVault> {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-provider-'));
  temporaryDirectories.push(directory);
  return new ProviderCredentialVault(join(directory, 'credentials.json'), crypto);
}

function success(
  body = '<html><body>fixture</body></html>',
  finalUrl = 'https://freewebnovel.com/novel/fixture',
): ImportFetchResult {
  return {
    ok: true,
    response: {
      finalUrl,
      status: 200,
      contentType: 'text/html',
      body,
      byteLength: Buffer.byteLength(body),
    },
  };
}

function driver(
  provider: Exclude<ImportFetchProvider, 'direct'>,
  calls: string[],
  result?: ImportFetchResult,
): ProviderDriver {
  return {
    provider,
    maxCostMicros: 1_000,
    fetch: ({ credential, targetUrl }) => {
      calls.push(credential.id);
      return Promise.resolve({ ...(result ?? success(undefined, targetUrl)), provider });
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('ProviderCredentialVault', () => {
  it('persists only encrypted authorized provider credentials', async () => {
    const store = await vault();
    await store.upsert({
      provider: 'scrape-do',
      label: 'free key',
      secret: 'plaintext-token',
      authorizedForUse: true,
      maxConcurrency: 1,
    });

    const disk = await readFile(store.filePath, 'utf8');
    expect(disk).not.toContain('plaintext-token');
    expect(disk).toContain(Buffer.from('cipher:plaintext-token').toString('base64'));
    expect(store.list()[0]).not.toHaveProperty('secret');
    expect((await store.usable('scrape-do'))[0]?.secret).toBe('plaintext-token');

    const upsertPromise = store.upsert({
      provider: 'zyte',
      label: 'unapproved',
      secret: 'nope',
      authorizedForUse: false,
      maxConcurrency: 1,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(upsertPromise).rejects.toThrow('授权');
  });
});

describe('PrivateScraperGateway', () => {
  it('routes FreeWebNovel to rendered providers first and keeps paid keys disabled', async () => {
    const store = await vault();
    await store.upsert({
      provider: 'scrape-do',
      label: 'free',
      secret: 'free-token',
      authorizedForUse: true,
      maxConcurrency: 1,
    });
    await store.upsert({
      provider: 'zyte',
      label: 'paid but disabled',
      secret: 'paid-token',
      authorizedForUse: true,
      maxConcurrency: 1,
      paidPlan: true,
    });
    const directCalls: ImportFetchRequest[] = [];
    const scrapeCalls: string[] = [];
    const gateway = new PrivateScraperGateway({
      credentials: store,
      directFetch: (request) => {
        directCalls.push(request);
        return Promise.resolve(success());
      },
      drivers: [driver('scrape-do', scrapeCalls)],
    });

    const result = await gateway.fetch({
      sourceKey: 'freewebnovel',
      kind: 'toc',
      url: 'https://freewebnovel.com/novel/fixture',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('scrape-do');
    expect(scrapeCalls).toEqual([store.list()[0]!.id]);
    expect(directCalls).toEqual([]);
  });

  it('round-robins legitimate keys, cools quota failures, and caps total attempts', async () => {
    const store = await vault();
    for (const label of ['one', 'two']) {
      await store.upsert({
        provider: 'scrape-do',
        label,
        secret: label,
        authorizedForUse: true,
        maxConcurrency: 1,
      });
    }
    const calls: string[] = [];
    const quotaDriver: ProviderDriver = {
      provider: 'scrape-do',
      maxCostMicros: 1_000,
      fetch: ({ credential }) => {
        calls.push(credential.id);
        return Promise.resolve({
          ok: false,
          provider: 'scrape-do',
          error: { code: 'rate_limited', message: 'quota fixture', retryable: true, status: 429 },
        });
      },
    };
    const gateway = new PrivateScraperGateway({
      credentials: store,
      directFetch: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'challenge_detected', message: 'fixture', retryable: true },
        }),
      drivers: [quotaDriver],
      now: () => 1_000,
    });

    const result = await gateway.fetch({
      sourceKey: 'nobadnovel',
      kind: 'toc',
      url: 'https://www.nobadnovel.com/series/fixture',
      jobId: 'job-2',
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBeLessThanOrEqual(4);
    expect(new Set(calls).size).toBe(2);
  });

  it('falls back after a detected direct challenge and enforces the per-job paid ceiling', async () => {
    const store = await vault();
    await store.upsert({
      provider: 'scrape-do',
      label: 'paid',
      secret: 'paid-token',
      authorizedForUse: true,
      maxConcurrency: 1,
      paidPlan: true,
      paidEnabled: true,
      monthlyCostLimitMicros: 10_000,
    });
    const calls: string[] = [];
    const gateway = new PrivateScraperGateway({
      credentials: store,
      directFetch: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'challenge_detected', message: 'fixture', retryable: true },
        }),
      drivers: [driver('scrape-do', calls)],
    });
    const baseRequest: ImportFetchRequest = {
      sourceKey: 'nobadnovel',
      kind: 'toc',
      url: 'https://www.nobadnovel.com/series/fixture',
      jobId: 'job-3',
    };

    const blocked = await gateway.fetch(baseRequest);
    expect(blocked).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    expect(calls).toEqual([]);

    const allowed = await gateway.fetch({ ...baseRequest, maxProviderCostMicros: 1_000 });
    expect(allowed.ok).toBe(true);
    expect(allowed).toMatchObject({ provider: 'scrape-do', costMicros: 1_000 });
    expect(calls).toHaveLength(1);
  });

  it('skips a paid provider with zero budget and lets a later free provider serve', async () => {
    const store = await vault();
    await store.upsert({
      provider: 'scrape-do',
      label: 'paid-key',
      secret: 'paid-token',
      authorizedForUse: true,
      maxConcurrency: 1,
      paidPlan: true,
      paidEnabled: true,
      monthlyCostLimitMicros: 10_000,
    });
    await store.upsert({
      provider: 'scrapingant',
      label: 'free-key',
      secret: 'free-token',
      authorizedForUse: true,
      maxConcurrency: 1,
    });

    const calls: string[] = [];
    const gateway = new PrivateScraperGateway({
      credentials: store,
      directFetch: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'challenge_detected', message: 'fixture', retryable: true },
        }),
      drivers: [
        driver('scrape-do', calls, success()),
        driver('scrapingant', calls, success('<html><body>free-ok</body></html>', 'https://www.nobadnovel.com/series/fixture')),
      ],
    });

    const result = await gateway.fetch({
      sourceKey: 'nobadnovel',
      kind: 'toc',
      url: 'https://www.nobadnovel.com/series/fixture',
      jobId: 'job-skip-paid-zero-budget',
      maxProviderCostMicros: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('scrapingant');
  });

  it('falls back to the next provider when every key of a provider is quota exhausted', async () => {
    const store = await vault();
    for (const label of ['quota-1', 'quota-2']) {
      await store.upsert({
        provider: 'scrape-do',
        label,
        secret: label,
        authorizedForUse: true,
        maxConcurrency: 1,
      });
    }
    await store.upsert({
      provider: 'scrapingant',
      label: 'healthy',
      secret: 'healthy-token',
      authorizedForUse: true,
      maxConcurrency: 1,
    });

    const calls: string[] = [];
    const gateway = new PrivateScraperGateway({
      credentials: store,
      directFetch: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'challenge_detected', message: 'fixture', retryable: true },
        }),
      drivers: [
        driver('scrape-do', calls, {
          ok: false,
          provider: 'scrape-do',
          error: { code: 'rate_limited', message: 'quota fixture', retryable: true, status: 429 },
        }),
        driver('scrapingant', calls, success('<html><body>ok</body></html>', 'https://www.nobadnovel.com/series/fixture')),
      ],
      now: () => 1_000,
    });

    const result = await gateway.fetch({
      sourceKey: 'nobadnovel',
      kind: 'toc',
      url: 'https://www.nobadnovel.com/series/fixture',
      jobId: 'job-fallback-quota',
      maxProviderCostMicros: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('scrapingant');
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(result.provider).toBe('scrapingant');
  });

  it('uses plain HTTP for NoBadNovel/NovelLunar fallbacks and browser only for FreeWebNovel', async () => {
    const store = await vault();
    for (const provider of ['scrape-do', 'scrapingant', 'zenrows', 'zyte'] as const) {
      await store.upsert({
        provider,
        label: `${provider}-key`,
        secret: `${provider}-token`,
        authorizedForUse: true,
        maxConcurrency: 1,
      });
    }

    const modes = new Map<string, string>();
    const nobadnovelUrl = 'https://www.nobadnovel.com/series/fixture';
    const freewebnovelUrl = 'https://freewebnovel.com/novel/fixture';

    function createModeGateway(): PrivateScraperGateway {
      return new PrivateScraperGateway({
        credentials: store,
        directFetch: () =>
          Promise.resolve({
            ok: false,
            error: { code: 'challenge_detected', message: 'fixture', retryable: true },
          }),
        drivers: [
          {
            provider: 'scrape-do',
            maxCostMicros: 1_000,
            fetch: ({ credential, targetUrl, mode }) => {
              modes.set(`${targetUrl}:scrape-do`, mode);
              return Promise.resolve({
                ok: false,
                provider: 'scrape-do',
                error: { code: 'rate_limited', message: 'fixture', retryable: true, status: 429 },
              });
            },
          },
          {
            provider: 'scrapingant',
            maxCostMicros: 1_000,
            fetch: ({ credential, targetUrl, mode }) => {
              modes.set(`${targetUrl}:scrapingant`, mode);
              return Promise.resolve({
                ok: false,
                provider: 'scrapingant',
                error: { code: 'rate_limited', message: 'fixture', retryable: true, status: 429 },
              });
            },
          },
          {
            provider: 'zenrows',
            maxCostMicros: 1_000,
            fetch: ({ credential, targetUrl, mode }) => {
              modes.set(`${targetUrl}:zenrows`, mode);
              return Promise.resolve({
                ok: false,
                provider: 'zenrows',
                error: { code: 'rate_limited', message: 'fixture', retryable: true, status: 429 },
              });
            },
          },
          {
            provider: 'zyte',
            maxCostMicros: 1_000,
            fetch: ({ credential, targetUrl, mode }) => {
              modes.set(`${targetUrl}:zyte`, mode);
              return Promise.resolve({
                ok: false,
                provider: 'zyte',
                error: { code: 'rate_limited', message: 'fixture', retryable: true, status: 429 },
              });
            },
          },
        ],
        now: () => 1_000,
      });
    }

    await createModeGateway().fetch({ sourceKey: 'nobadnovel', kind: 'toc', url: nobadnovelUrl, jobId: 'job-mode-nbn', maxProviderCostMicros: 10_000 });
    await createModeGateway().fetch({ sourceKey: 'freewebnovel', kind: 'toc', url: freewebnovelUrl, jobId: 'job-mode-fwn', maxProviderCostMicros: 10_000 });

    expect(modes.get(`${nobadnovelUrl}:scrape-do`)).toBe('http');
    expect(modes.get(`${nobadnovelUrl}:scrapingant`)).toBe('http');
    expect(modes.get(`${nobadnovelUrl}:zenrows`)).toBe('http');
    expect(modes.get(`${nobadnovelUrl}:zyte`)).toBe('browser');

    expect(modes.get(`${freewebnovelUrl}:scrape-do`)).toBe('browser');
    expect(modes.get(`${freewebnovelUrl}:scrapingant`)).toBe('browser');
    expect(modes.get(`${freewebnovelUrl}:zenrows`)).toBe('browser');
    expect(modes.get(`${freewebnovelUrl}:zyte`)).toBe('browser');
  });
});

describe('provider drivers', () => {
  it('builds fixed rendered requests and normalizes mocked responses', async () => {
    const requests: ProviderHttpRequest[] = [];
    const responses: Record<string, ProviderHttpResponse> = {
      'api.scrape.do': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'scrape.do-resolved-url': 'https://freewebnovel.com/novel/fixture',
          'scrape.do-request-cost': '5',
        },
        body: Buffer.from('<html>scrape.do</html>'),
      },
      'api.scrapingant.com': {
        status: 200,
        headers: { 'ant-credits-cost': '10' },
        body: Buffer.from(
          JSON.stringify({ html: '<html>ant</html>', status_code: 200, headers: [] }),
        ),
      },
      'api.zenrows.com': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'zr-final-url': 'https://freewebnovel.com/novel/fixture',
        },
        body: Buffer.from('<html>zen</html>'),
      },
      'api.zyte.com': {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            url: 'https://freewebnovel.com/novel/fixture',
            statusCode: 200,
            browserHtml: '<html>zyte</html>',
          }),
        ),
      },
    };
    const drivers = createProviderDrivers((request) => {
      requests.push(request);
      const response = responses[new URL(request.url).hostname];
      if (!response) throw new Error('unexpected provider endpoint');
      return Promise.resolve(response);
    });
    const target = 'https://freewebnovel.com/novel/fixture';

    for (const current of drivers) {
      const result = await current.fetch({
        credential: {
          id: current.provider,
          provider: current.provider,
          label: 'fixture',
          secret: 'secret',
          enabled: true,
          maxConcurrency: 1,
          paidPlan: false,
          paidEnabled: false,
          monthlyCostLimitMicros: 0,
          monthlyCostMicrosUsed: 0,
          costPeriod: '2026-08',
        },
        targetUrl: target,
        mode: 'browser',
        timeoutMs: 20_000,
        maxBytes: 2 * 1024 * 1024,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.response.finalUrl).toBe(target);
    }

    expect(requests.map((request) => new URL(request.url).hostname)).toEqual([
      'api.scrape.do',
      'api.scrapingant.com',
      'api.zenrows.com',
      'api.zyte.com',
    ]);
    expect(requests[0]?.url).toContain('render=true');
    expect(requests[0]?.url).toContain('disableRetry=true');
    expect(requests[1]?.url).toContain('/v2/extended');
    expect(requests[2]?.url).toContain('js_render=true');
    expect(requests[3]?.body).toContain('"browserHtml":true');
  });
});
