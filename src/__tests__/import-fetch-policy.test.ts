import { describe, expect, it } from 'bun:test';
import {
  classifyImportHttpError,
  createPinnedLookup,
  ImportFetchPolicyError,
  isAllowedImportContentType,
  resolvePublicAddress,
  toImportFetchError,
  validateImportFetchRequest,
} from '../../src-electron/import-fetch';
import type { LookupAddress } from 'node:dns';
import type { ImportFetchRequest } from 'src/models/importer';

describe('import fetch policy', () => {
  it('permits only the exact adapter-owned request shapes', () => {
    expect(
      validateImportFetchRequest({
        sourceKey: 'kakuyomu',
        kind: 'chapter',
        url: 'https://kakuyomu.jp/works/822139842947212336/episodes/822139842947254251',
      }).url.href,
    ).toBe('https://kakuyomu.jp/works/822139842947212336/episodes/822139842947254251');
    expect(
      validateImportFetchRequest({
        sourceKey: 'narou-metadata',
        kind: 'metadata',
        url: 'https://api.syosetu.com/novelapi/api/?out=json&ncode=n2032iz',
      }).url.hostname,
    ).toBe('api.syosetu.com');
  });

  it('rejects generic proxying, cleartext, credentials, and IP literal inputs', () => {
    const requests: ImportFetchRequest[] = [
      { sourceKey: 'kakuyomu', kind: 'chapter', url: 'http://kakuyomu.jp/works/1' },
      { sourceKey: 'kakuyomu', kind: 'chapter', url: 'https://u:p@kakuyomu.jp/works/1' },
      { sourceKey: 'kakuyomu', kind: 'toc', url: 'https://@kakuyomu.jp/works/1' },
      { sourceKey: 'kakuyomu', kind: 'chapter', url: 'https://127.0.0.1/works/1' },
      { sourceKey: 'kakuyomu', kind: 'chapter', url: 'https://evil.test/works/1' },
      { sourceKey: 'narou-metadata', kind: 'chapter', url: 'https://api.syosetu.com/novelapi/api/?ncode=n2032iz' },
      { sourceKey: 'narou-metadata', kind: 'metadata', url: 'https://api.syosetu.com/anything' },
    ];
    for (const request of requests) {
      expect(() => validateImportFetchRequest(request)).toThrow(ImportFetchPolicyError);
    }
  });

  it('refuses DNS answers when every resolved address is private or special', async () => {
    await (expect(
      resolvePublicAddress('kakuyomu.jp', () =>
        Promise.resolve([
          { address: '127.0.0.1', family: 4 },
          { address: 'fc00::1', family: 6 },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'unsafe_address' }) as unknown as Promise<void>);
  });

  it('pins one validated address for both Node lookup callback shapes', async () => {
    const pinned: LookupAddress = { address: '203.0.113.9', family: 4 };
    const lookup = createPinnedLookup(pinned);
    const all = await new Promise<LookupAddress[]>((resolve, reject) => {
      lookup('kakuyomu.jp', { all: true }, (lookupError, addresses) => {
        if (lookupError) reject(lookupError);
        else if (Array.isArray(addresses)) resolve(addresses);
        else reject(new Error('pinned lookup did not return all addresses'));
      });
    });
    expect(all).toEqual([pinned]);
  });

  it('matches exact MIME types and classifies 429 as rate-limited', () => {
    expect(isAllowedImportContentType('text/html; charset=utf-8', 'html')).toBe(true);
    expect(isAllowedImportContentType('text/htmlx', 'html')).toBe(false);
    expect(isAllowedImportContentType('application/jsonp', 'json')).toBe(false);
    expect(classifyImportHttpError(429, '3')).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 3000,
    });
    expect(toImportFetchError(new ImportFetchPolicyError('timeout', 'fixture timeout'))).toEqual({
      code: 'timeout',
      message: 'fixture timeout',
      retryable: true,
    });
  });
});
