import { describe, expect, it } from 'bun:test';
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceRegistry } from 'src/services/importer/source-registry';

const fixtures = join(__dirname, 'examplePages');
const kakuyomuWork = readFileSync(join(fixtures, 'kakuyumu-822139842947212336.html'), 'utf-8');
const kakuyomuChapter = readFileSync(
  join(fixtures, 'kakuyumu-822139842947212336-chapter-1.html'),
  'utf-8',
);

const privateSourceFixtures = [
  {
    url: 'https://www.nobadnovel.com/series/poor-talent-i-bought-a-year-of-cultivation-for-one-dollar',
    key: 'nobadnovel',
    title: 'Poor Talent? I Bought a Year of Cultivation for One Dollar!',
    work: 'nobadnovel-work.html',
    chapter: 'nobadnovel-chapter.html',
    expectedCount: 2,
    expectedText: 'Jiangcheng No. 3 High School',
  },
  {
    url: 'https://freewebnovel.com/novel/a-demon-lords-tale-dungeons-monster-girls-and-heartwarming-bliss',
    key: 'freewebnovel',
    title: "A Demon Lord's Tale: Dungeons, Monster Girls, and Heartwarming Bliss",
    work: 'freewebnovel-work.html',
    chapter: 'freewebnovel-chapter.html',
    expectedCount: 2,
    expectedText: 'unfamiliar wings',
  },
  {
    url: 'https://novellunar.com/novel/the-artist-who-paints-dungeon',
    key: 'novellunar',
    title: 'The Artist Who Paints Dungeon',
    work: 'novellunar-work.html',
    chapter: 'novellunar-chapter.html',
    expectedCount: 371,
    expectedText: 'haunted portrait',
  },
] as const;

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
    expect(snapshot.chapters).toHaveLength(54);
    const firstChapter = snapshot.chapters[0];
    if (!firstChapter || !adapter.parseChapter) throw new Error('fixture chapter was not parsed');
    const body = await adapter.parseChapter(firstChapter, kakuyomuChapter);

    expect(body.paragraphs.join('\n')).toContain('大切な妹を守りたかった。');
    expect(body.paragraphs.join('\n')).not.toContain('<p');
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when the Kakuyomu directory snapshot is incomplete', () => {
    const source = SourceRegistry.detect('https://kakuyomu.jp/works/822139842947212336');
    if (!source) throw new Error('fixture source was not detected');
    const adapter = SourceRegistry.get(source.sourceKey);
    const $ = cheerio.load(kakuyomuWork);
    const data = JSON.parse($('script#__NEXT_DATA__').html() || '{}') as {
      props: { pageProps: { __APOLLO_STATE__: Record<string, Record<string, unknown>> } };
    };
    data.props.pageProps.__APOLLO_STATE__['Work:822139842947212336']!.publicEpisodeCount = 55;
    $('script#__NEXT_DATA__').text(JSON.stringify(data));
    expect(() => adapter.discover(source, $.html(), '2026-08-24T00:00:00.000Z')).toThrow(
      'Kakuyomu 目录不完整',
    );
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
    expect('parseChapter' in adapter).toBe(false);
  });

  for (const fixture of privateSourceFixtures) {
    it(`detects and parses recorded ${fixture.key} fixtures`, async () => {
      const { url, key, title, work, chapter, expectedCount, expectedText } = fixture;
      const source = SourceRegistry.detect(url);
      expect(source?.sourceKey).toBe(key);
      if (!source) throw new Error(`${key} fixture source was not detected`);

      const adapter = SourceRegistry.get(source.sourceKey);
      const snapshot = adapter.discover(
        source,
        readFileSync(join(fixtures, work), 'utf-8'),
        '2026-08-24T00:00:00.000Z',
      );
      expect(snapshot.title).toBe(title);
      expect(snapshot.chapters).toHaveLength(expectedCount);
      expect(new Set(snapshot.chapters.map((item) => item.remoteChapterId)).size).toBe(
        expectedCount,
      );

      const firstChapter = snapshot.chapters[0];
      if (!firstChapter || !adapter.parseChapter) throw new Error(`${key} chapter was not parsed`);
      const body = await adapter.parseChapter(
        firstChapter,
        readFileSync(join(fixtures, chapter), 'utf-8'),
      );
      expect(body.paragraphs.join('\n')).toContain(expectedText);
      expect(body.paragraphs.join('\n')).not.toContain('<p');
      expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(SourceRegistry.matchesChapterUrl(firstChapter.canonicalChapterUrl, firstChapter)).toBe(
        true,
      );
    });
  }
});
