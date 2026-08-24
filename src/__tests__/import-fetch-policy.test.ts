import { describe, expect, it } from 'bun:test';
import {
  ImportFetchPolicyError,
  resolvePublicAddress,
  validateImportFetchRequest,
} from '../../src-electron/import-fetch';
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
    await expect(
      resolvePublicAddress('kakuyomu.jp', async () => [
        { address: '127.0.0.1', family: 4 },
        { address: 'fc00::1', family: 6 },
      ]),
    ).rejects.toMatchObject({ code: 'unsafe_address' });
  });
});
