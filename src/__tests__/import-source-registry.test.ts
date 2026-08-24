import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceRegistry } from 'src/services/importer/source-registry';

const fixtures = join(__dirname, 'examplePages');
const kakuyomuWork = readFileSync(join(fixtures, 'kakuyumu-822139842947212336.html'), 'utf-8');
const kakuyomuChapter = readFileSync(
  join(fixtures, 'kakuyumu-822139842947212336-chapter-1.html'),
  'utf-8',
);

describe('SourceRegistry', () => {
  it('detects only canonical HTTPS Kakuyomu and Narou work URLs', () => {
    expect(
      SourceRegistry.detect('https://kakuyomu.jp/works/822139842947212336?tracking=1#chapter'),
    ).toEqual({
      sourceKey: 'kakuyomu',
      remoteWorkId: '822139842947212336',
      canonicalWorkUrl: 'https://kakuyomu.jp/works/822139842947212336',
    });
    expect(SourceRegistry.detect('https://ncode.syosetu.com/N2032IZ/')).toEqual({
      sourceKey: 'narou-metadata',
      remoteWorkId: 'n2032iz',
      canonicalWorkUrl: 'https://ncode.syosetu.com/n2032iz/',
    });
    expect(SourceRegistry.detect('http://kakuyomu.jp/works/822139842947212336')).toBeNull();
    expect(SourceRegistry.detect('https://user@kakuyomu.jp/works/822139842947212336')).toBeNull();
    expect(SourceRegistry.detect('https://kakuyomu.jp.attacker.test/works/822139842947212336')).toBeNull();
  });

  it('parses Kakuyomu fixture metadata and normalized chapter text without persisting HTML', async () => {
    const source = SourceRegistry.detect('https://kakuyomu.jp/works/822139842947212336');
    if (!source) throw new Error('fixture source was not detected');
    const adapter = SourceRegistry.get(source.sourceKey);
    const snapshot = adapter.discover(source, kakuyomuWork, '2026-08-24T00:00:00.000Z');

    expect(snapshot.title).toBe('守り抜いたヒロインたちが病んでいく件について');
    expect(snapshot.chapters.length).toBeGreaterThan(0);
    const firstChapter = snapshot.chapters[0];
    if (!firstChapter || !adapter.parseChapter) throw new Error('fixture chapter was not parsed');
    const body = await adapter.parseChapter(firstChapter, kakuyomuChapter);

    expect(body.paragraphs.join('\n')).toContain('大切な妹を守りたかった。');
    expect(body.paragraphs.join('\n')).not.toContain('<p');
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps Narou metadata-only and rejects chapter content capability', () => {
    const source = SourceRegistry.detect('https://ncode.syosetu.com/n2032iz/');
    if (!source) throw new Error('Narou source was not detected');
    const adapter = SourceRegistry.get(source.sourceKey);
    const snapshot = adapter.discover(
      source,
      JSON.stringify([
        { allcount: 1 },
        {
          ncode: 'n2032iz',
          title: 'Narou fixture',
          writer: '作者',
          story: '简介',
          keyword: '异世界 冒险',
          general_lastup: '2026-08-24 00:00:00',
        },
      ]),
      '2026-08-24T00:00:00.000Z',
    );

    expect(snapshot.metadataOnly).toBe(true);
    expect(snapshot.chapters).toEqual([]);
    expect(adapter.parseChapter).toBeUndefined();
  });
});
