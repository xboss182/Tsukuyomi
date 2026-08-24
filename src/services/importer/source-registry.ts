import * as cheerio from 'cheerio';
import type {
  ImportError,
  RemoteChapterBody,
  RemoteChapterStub,
  RemoteVolume,
  RemoteWorkSnapshot,
  SourceIdentity,
  SourceKey,
} from './types';
import { hashString } from 'src/utils/content-hash';

export interface SourceAdapter {
  readonly key: SourceKey;
  readonly capabilities: ReadonlySet<'metadata' | 'chapter-content'>;
  readonly allowedHosts: ReadonlySet<string>;
  readonly minimumSpacingMs: number;
  readonly parserVersion: string;
  detect(input: URL): SourceIdentity | null;
  discover(source: SourceIdentity, html: string, checkedAt: string): RemoteWorkSnapshot;
  parseChapter?(source: RemoteChapterStub, html: string): Promise<RemoteChapterBody>;
}

export class StructuredImportError extends Error implements ImportError {
  readonly code: ImportError['code'];
  readonly retryable: boolean;
  readonly status?: number | undefined;
  readonly retryAfterMs?: number | undefined;

  constructor(value: ImportError) {
    super(value.message);
    this.name = 'StructuredImportError';
    this.code = value.code;
    this.retryable = value.retryable;
    this.status = value.status;
    this.retryAfterMs = value.retryAfterMs;
  }
}

function sourceError(
  code: ImportError['code'],
  message: string,
  retryable = false,
): StructuredImportError {
  return new StructuredImportError({ code, message, retryable });
}

function titleText(title: unknown): string {
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object' && 'original' in title) {
    const original = (title as { original?: unknown }).original;
    if (typeof original === 'string') return original;
  }
  return '';
}

function parseOptionalDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function normalizedText(value: string): string {
  return value.replace(/\uFEFF/g, '').replace(/\s+/g, ' ').trim();
}

function canonicalHtmlUrl($: cheerio.CheerioAPI): string | undefined {
  return $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content');
}

function assertWorkIdentity($: cheerio.CheerioAPI, source: SourceIdentity): void {
  const canonical = canonicalHtmlUrl($);
  if (canonical && !SourceRegistry.matchesWorkUrl(canonical, source)) {
    throw sourceError('parse_failed', '来源作品身份不匹配');
  }
}

function textMeta($: cheerio.CheerioAPI, selector: string): string | undefined {
  const value = normalizedText($(selector).attr('content') || '');
  return value || undefined;
}

async function chapterBody(
  html: string,
  selector: string,
  parserVersion: string,
  sourceName: string,
): Promise<RemoteChapterBody> {
  const $ = cheerio.load(html);
  const root = $(selector).first();
  if (root.length === 0) throw sourceError('parse_failed', `无法解析 ${sourceName} 章节正文`);
  root.find('script,style,noscript,iframe,form,nav,header,footer,button').remove();
  const paragraphs = root.find('p').length
    ? root
        .find('p')
        .map((_, element) => normalizedText($(element).text()))
        .get()
        .filter(Boolean)
    : root
        .text()
        .split(/\n\s*\n/)
        .map(normalizedText)
        .filter(Boolean);
  if (paragraphs.length === 0) throw sourceError('parse_failed', `${sourceName} 章节正文为空`);
  return {
    paragraphs,
    contentHash: await hashString(paragraphs.join('\n\n')),
    parserVersion,
  };
}

function isCanonicalInput(input: URL, hosts: ReadonlySet<string>): boolean {
  return (
    input.protocol === 'https:' &&
    hosts.has(input.hostname) &&
    !input.username &&
    !input.password &&
    !input.port
  );
}

function readJsonScript($: cheerio.CheerioAPI): Record<string, unknown> {
  const raw = $('script#__NEXT_DATA__').html();
  if (!raw) throw sourceError('parse_failed', '无法解析 Kakuyomu 目录');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw sourceError('parse_failed', '无法解析 Kakuyomu 目录');
  }
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const item = (value as Record<string, unknown>)[key];
  return item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
}

function parseKakuyomuSnapshot(
  source: SourceIdentity,
  html: string,
  checkedAt: string,
): RemoteWorkSnapshot {
  const $ = cheerio.load(html);
  const nextData = readJsonScript($);
  const query = nextData.query as Record<string, unknown> | undefined;
  const workId = typeof query?.workId === 'string' ? query.workId : source.remoteWorkId;
  if (workId !== source.remoteWorkId) throw sourceError('parse_failed', 'Kakuyomu 作品身份不匹配');

  const props = nextData.props as Record<string, unknown> | undefined;
  const pageProps = props?.pageProps as Record<string, unknown> | undefined;
  const apollo = pageProps?.__APOLLO_STATE__ as Record<string, unknown> | undefined;
  const work = apollo ? recordAt(apollo, `Work:${workId}`) : null;
  if (!apollo || !work) throw sourceError('parse_failed', '无法解析 Kakuyomu 作品数据');

  const title = typeof work.title === 'string' ? work.title.trim() : '';
  if (!title) throw sourceError('parse_failed', 'Kakuyomu 作品缺少标题');

  const toc = Array.isArray(work.tableOfContentsV2)
    ? work.tableOfContentsV2
    : Array.isArray(work.tableOfContents)
      ? work.tableOfContents
      : [];
  const volumes: RemoteVolume[] = [];
  const chapters: RemoteChapterStub[] = [];
  let currentVolume: RemoteVolume = { remoteVolumeId: 'main', title: '正文', sequence: 0 };
  let sequence = 0;

  for (const tocRef of toc) {
    const ref = tocRef && typeof tocRef === 'object' ? (tocRef as { __ref?: unknown }).__ref : undefined;
    if (typeof ref !== 'string') continue;
    const tocItem = recordAt(apollo, ref);
    if (!tocItem) continue;

    const volumeRef = tocItem.chapter && typeof tocItem.chapter === 'object'
      ? (tocItem.chapter as { __ref?: unknown }).__ref
      : undefined;
    if (typeof volumeRef === 'string') {
      const remoteVolume = recordAt(apollo, volumeRef);
      const remoteVolumeTitle = typeof remoteVolume?.title === 'string' ? remoteVolume.title.trim() : '';
      if (remoteVolumeTitle) {
        currentVolume = {
          remoteVolumeId: volumeRef.replace(/^Chapter:/, '') || `volume-${volumes.length + 1}`,
          title: remoteVolumeTitle,
          sequence: volumes.length,
        };
        volumes.push(currentVolume);
      }
    }

    const episodes = Array.isArray(tocItem.episodeUnions) ? tocItem.episodeUnions : [];
    for (const episodeRef of episodes) {
      const refValue = episodeRef && typeof episodeRef === 'object'
        ? (episodeRef as { __ref?: unknown }).__ref
        : undefined;
      if (typeof refValue !== 'string') continue;
      const episode = recordAt(apollo, refValue);
      const remoteChapterId = typeof episode?.id === 'string' ? episode.id : '';
      const chapterTitle = typeof episode?.title === 'string' ? episode.title.trim() : '';
      if (!remoteChapterId || !chapterTitle) continue;
      const canonicalChapterUrl = `${source.canonicalWorkUrl}/episodes/${remoteChapterId}`;
      chapters.push({
        ...source,
        remoteChapterId,
        canonicalChapterUrl,
        title: chapterTitle,
        volume: currentVolume,
        sequence,
        publishedAt: parseOptionalDate(episode?.publishedAt),
        remoteUpdatedAt: parseOptionalDate(episode?.publishedAt),
      });
      sequence += 1;
    }
  }

  if (volumes.length === 0 && chapters.length > 0) volumes.push(currentVolume);
  const expectedChapterCount =
    typeof work.publicEpisodeCount === 'number' ? work.publicEpisodeCount : undefined;
  if (expectedChapterCount !== undefined && expectedChapterCount !== chapters.length) {
    throw sourceError('parse_failed', 'Kakuyomu 目录不完整');
  }
  const authorRef = work.author && typeof work.author === 'object'
    ? (work.author as { __ref?: unknown }).__ref
    : undefined;
  const authorData = typeof authorRef === 'string' ? recordAt(apollo, authorRef) : null;
  const tags = [
    ...(Array.isArray(work.tagLabels) ? work.tagLabels.filter((tag): tag is string => typeof tag === 'string') : []),
    ...(typeof work.genre === 'string' ? [work.genre] : []),
  ];

  return {
    source,
    title,
    author:
      (typeof authorData?.activityName === 'string' && authorData.activityName) ||
      (typeof authorData?.name === 'string' && authorData.name) ||
      undefined,
    description: typeof work.introduction === 'string' ? work.introduction : undefined,
    tags: tags.length > 0 ? [...new Set(tags)] : undefined,
    remoteUpdatedAt: parseOptionalDate(work.lastEpisodePublishedAt),
    volumes,
    chapters,
    metadataOnly: false,
  };
}

function normalizeKakuyomuParagraphs(html: string): string[] {
  const $ = cheerio.load(html);
  const root = $('.widget-episodeBody, [class*="widget-episodeBody"], .episodeBody, [class*="episodeBody"]').first();
  if (root.length === 0) throw sourceError('parse_failed', '无法解析 Kakuyomu 章节正文');
  root.find('script,style,noscript,iframe,form,nav,header,footer').remove();

  const paragraphs: string[] = [];
  let current = '';
  root.find('p').each((_, element) => {
    const paragraph = $(element);
    if (paragraph.hasClass('blank')) {
      if (current) paragraphs.push(current);
      current = '';
      return;
    }
    const text = paragraph.text().replace(/\r\n?/g, '\n').trim();
    if (!text || /目\s*次|前\s*の\s*話|次\s*の\s*話|前へ|次へ/.test(text)) return;
    current = current ? `${current}\n${text}` : text;
  });
  if (current) paragraphs.push(current);
  if (paragraphs.length === 0) throw sourceError('parse_failed', 'Kakuyomu 章节正文为空');
  return paragraphs;
}

const kakuyomuAdapter: SourceAdapter = {
  key: 'kakuyomu',
  capabilities: new Set(['metadata', 'chapter-content']),
  allowedHosts: new Set(['kakuyomu.jp']),
  minimumSpacingMs: 2000,
  parserVersion: 'kakuyomu-v1',
  detect(input) {
    if (input.protocol !== 'https:' || input.hostname !== 'kakuyomu.jp' || input.username || input.password) {
      return null;
    }
    const match = input.pathname.match(/^\/works\/(\d+)(?:\/|$)/);
    if (!match?.[1]) return null;
    const remoteWorkId = match[1];
    return {
      sourceKey: 'kakuyomu',
      remoteWorkId,
      canonicalWorkUrl: `https://kakuyomu.jp/works/${remoteWorkId}`,
    };
  },
  discover: parseKakuyomuSnapshot,
  async parseChapter(_source, html) {
    const paragraphs = normalizeKakuyomuParagraphs(html);
    return {
      paragraphs,
      contentHash: await hashString(paragraphs.join('\n\n')),
      parserVersion: 'kakuyomu-v1',
    };
  },
};

const DEFAULT_VOLUME: RemoteVolume = { remoteVolumeId: 'main', title: '正文', sequence: 0 };
const NOBADNOVEL_HOSTS = new Set(['nobadnovel.com', 'www.nobadnovel.com']);

const nobadnovelAdapter: SourceAdapter = {
  key: 'nobadnovel',
  capabilities: new Set(['metadata', 'chapter-content']),
  allowedHosts: NOBADNOVEL_HOSTS,
  minimumSpacingMs: 2000,
  parserVersion: 'nobadnovel-v1',
  detect(input) {
    if (!isCanonicalInput(input, NOBADNOVEL_HOSTS)) return null;
    const match = input.pathname.match(/^\/series\/([a-z0-9-]+)(?:\/chapter-[a-z0-9-]+)?\/?$/i);
    if (!match?.[1]) return null;
    const remoteWorkId = match[1].toLowerCase();
    return {
      sourceKey: 'nobadnovel',
      remoteWorkId,
      canonicalWorkUrl: `https://www.nobadnovel.com/series/${remoteWorkId}`,
    };
  },
  discover(source, html) {
    const $ = cheerio.load(html);
    assertWorkIdentity($, source);
    const title = normalizedText($('main h1').first().text());
    if (!title) throw sourceError('parse_failed', 'NoBadNovel 作品缺少标题');
    const chapters: RemoteChapterStub[] = [];
    const seen = new Set<string>();
    $('#chapter-list a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      let input: URL;
      try {
        input = new URL(href, source.canonicalWorkUrl);
      } catch {
        return;
      }
      const match = input.pathname.match(/^\/series\/([a-z0-9-]+)\/(chapter-[a-z0-9-]+)\/?$/i);
      if (match?.[1]?.toLowerCase() !== source.remoteWorkId || !match[2] || seen.has(match[2])) {
        return;
      }
      seen.add(match[2]);
      chapters.push({
        ...source,
        remoteChapterId: match[2],
        canonicalChapterUrl: `${source.canonicalWorkUrl}/${match[2]}`,
        title: normalizedText($(element).text()),
        volume: DEFAULT_VOLUME,
        sequence: chapters.length,
      });
    });
    if (chapters.length === 0) throw sourceError('parse_failed', '无法解析 NoBadNovel 目录');
    const authorLabel = $('span')
      .filter((_, element) => normalizedText($(element).text()) === 'Author:')
      .first();
    return {
      source,
      title,
      author: normalizedText(authorLabel.parent().children().last().text()) || undefined,
      description: textMeta($, 'meta[name="description"]'),
      volumes: [DEFAULT_VOLUME],
      chapters,
      metadataOnly: false,
    };
  },
  parseChapter(_source, html) {
    return chapterBody(html, 'h1 + div', 'nobadnovel-v1', 'NoBadNovel');
  },
};

const FREEWEBNOVEL_HOSTS = new Set(['freewebnovel.com', 'www.freewebnovel.com']);

const freewebnovelAdapter: SourceAdapter = {
  key: 'freewebnovel',
  capabilities: new Set(['metadata', 'chapter-content']),
  allowedHosts: FREEWEBNOVEL_HOSTS,
  minimumSpacingMs: 2000,
  parserVersion: 'freewebnovel-v1',
  detect(input) {
    if (!isCanonicalInput(input, FREEWEBNOVEL_HOSTS)) return null;
    const match = input.pathname.match(/^\/novel\/([a-z0-9-]+)(?:\/chapter-[a-z0-9.-]+)?\/?$/i);
    if (!match?.[1]) return null;
    const remoteWorkId = match[1].toLowerCase();
    return {
      sourceKey: 'freewebnovel',
      remoteWorkId,
      canonicalWorkUrl: `https://freewebnovel.com/novel/${remoteWorkId}`,
    };
  },
  discover(source, html) {
    const $ = cheerio.load(html);
    assertWorkIdentity($, source);
    const title = textMeta($, 'meta[property="og:title"]') || normalizedText($('h1').first().text());
    if (!title) throw sourceError('parse_failed', 'FreeWebNovel 作品缺少标题');
    const chapters: RemoteChapterStub[] = [];
    const seen = new Set<string>();
    $('#idData a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      let input: URL;
      try {
        input = new URL(href, source.canonicalWorkUrl);
      } catch {
        return;
      }
      const match = input.pathname.match(/^\/novel\/([a-z0-9-]+)\/(chapter-[a-z0-9.-]+)\/?$/i);
      if (match?.[1]?.toLowerCase() !== source.remoteWorkId || !match[2] || seen.has(match[2])) {
        return;
      }
      seen.add(match[2]);
      chapters.push({
        ...source,
        remoteChapterId: match[2],
        canonicalChapterUrl: `${source.canonicalWorkUrl}/${match[2]}`,
        title: normalizedText($(element).text()),
        volume: DEFAULT_VOLUME,
        sequence: chapters.length,
      });
    });
    if (chapters.length === 0) throw sourceError('parse_failed', '无法解析 FreeWebNovel 目录');
    return {
      source,
      title,
      author: normalizedText($('.m-book1 a[href^="/author/"]').first().text()) || undefined,
      description: textMeta($, 'meta[property="og:description"]'),
      volumes: [DEFAULT_VOLUME],
      chapters,
      metadataOnly: false,
    };
  },
  parseChapter(_source, html) {
    return chapterBody(html, '#article', 'freewebnovel-v1', 'FreeWebNovel');
  },
};

const NOVELLUNAR_HOSTS = new Set(['novellunar.com', 'www.novellunar.com']);

const novellunarAdapter: SourceAdapter = {
  key: 'novellunar',
  capabilities: new Set(['metadata', 'chapter-content']),
  allowedHosts: NOVELLUNAR_HOSTS,
  minimumSpacingMs: 2000,
  parserVersion: 'novellunar-v1',
  detect(input) {
    if (!isCanonicalInput(input, NOVELLUNAR_HOSTS)) return null;
    const match = input.pathname.match(/^\/novel\/([a-z0-9-]+)(?:\/chapter\/(\d+))?\/?$/i);
    if (!match?.[1]) return null;
    const remoteWorkId = match[1].toLowerCase();
    return {
      sourceKey: 'novellunar',
      remoteWorkId,
      canonicalWorkUrl: `https://novellunar.com/novel/${remoteWorkId}`,
    };
  },
  discover(source, html) {
    const $ = cheerio.load(html);
    assertWorkIdentity($, source);
    const title = normalizedText($('h1').filter((_, element) => {
      const value = normalizedText($(element).text());
      return value !== 'Novellunar';
    }).first().text());
    if (!title) throw sourceError('parse_failed', 'NovelLunar 作品缺少标题');
    const chapterCountMatch = $('body').text().match(/\b([\d,]+)\s+chapters\b/i);
    const chapterCount = Number(chapterCountMatch?.[1]?.replace(/,/g, ''));
    if (!Number.isSafeInteger(chapterCount) || chapterCount < 1 || chapterCount > 10_000) {
      throw sourceError('parse_failed', '无法解析 NovelLunar 目录');
    }
    const chapters = Array.from({ length: chapterCount }, (_, index): RemoteChapterStub => {
      const chapterNumber = index + 1;
      return {
        ...source,
        remoteChapterId: String(chapterNumber),
        canonicalChapterUrl: `${source.canonicalWorkUrl}/chapter/${chapterNumber}`,
        title: `Chapter ${chapterNumber}`,
        volume: DEFAULT_VOLUME,
        sequence: index,
      };
    });
    return {
      source,
      title,
      author: normalizedText($('a[href^="/author/"]').first().text()) || undefined,
      description: textMeta($, 'meta[name="description"]'),
      tags: $('a[href$="-online-novel"]')
        .map((_, element) => normalizedText($(element).text()))
        .get()
        .filter(Boolean),
      volumes: [DEFAULT_VOLUME],
      chapters,
      metadataOnly: false,
    };
  },
  parseChapter(_source, html) {
    return chapterBody(html, 'article > div', 'novellunar-v1', 'NovelLunar');
  },
};

interface NarouApiRecord {
  ncode?: unknown;
  title?: unknown;
  writer?: unknown;
  story?: unknown;
  keyword?: unknown;
  general_lastup?: unknown;
}

function parseNarouSnapshot(source: SourceIdentity, body: string): RemoteWorkSnapshot {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw sourceError('parse_failed', '无法解析 Narou 官方 API 响应');
  }
  if (!Array.isArray(payload) || !payload[1] || typeof payload[1] !== 'object') {
    throw sourceError('parse_failed', 'Narou 官方 API 未返回作品');
  }
  const record = payload[1] as NarouApiRecord;
  const ncode = typeof record.ncode === 'string' ? record.ncode.toLowerCase() : '';
  if (ncode !== source.remoteWorkId) throw sourceError('parse_failed', 'Narou 作品身份不匹配');
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) throw sourceError('parse_failed', 'Narou 作品缺少标题');

  return {
    source,
    title,
    author: typeof record.writer === 'string' && record.writer.trim() ? record.writer.trim() : undefined,
    description: typeof record.story === 'string' && record.story.trim() ? record.story.trim() : undefined,
    tags: typeof record.keyword === 'string' ? record.keyword.split(/\s+/).filter(Boolean) : undefined,
    remoteUpdatedAt: parseOptionalDate(record.general_lastup),
    volumes: [],
    chapters: [],
    metadataOnly: true,
  };
}

const narouAdapter: SourceAdapter = {
  key: 'narou-metadata',
  capabilities: new Set(['metadata']),
  allowedHosts: new Set(['api.syosetu.com']),
  minimumSpacingMs: 1000,
  parserVersion: 'narou-api-v1',
  detect(input) {
    if (input.protocol !== 'https:' || input.hostname !== 'ncode.syosetu.com' || input.username || input.password) {
      return null;
    }
    const match = input.pathname.match(/^\/(n[a-z0-9]{5,6})(?:\/|$)/i);
    if (!match?.[1]) return null;
    const remoteWorkId = match[1].toLowerCase();
    return {
      sourceKey: 'narou-metadata',
      remoteWorkId,
      canonicalWorkUrl: `https://ncode.syosetu.com/${remoteWorkId}/`,
    };
  },
  discover(source, body) {
    return parseNarouSnapshot(source, body);
  },
};

const adapters: SourceAdapter[] = [
  kakuyomuAdapter,
  narouAdapter,
  nobadnovelAdapter,
  freewebnovelAdapter,
  novellunarAdapter,
];

export class SourceRegistry {
  static detect(url: string): SourceIdentity | null {
    let input: URL;
    try {
      input = new URL(url);
    } catch {
      return null;
    }
    for (const adapter of adapters) {
      const source = adapter.detect(input);
      if (source) return source;
    }
    return null;
  }

  static get(sourceKey: SourceKey): SourceAdapter {
    const adapter = adapters.find((candidate) => candidate.key === sourceKey);
    if (!adapter) throw sourceError('unsupported_source', '不支持的来源');
    return adapter;
  }

  static getFetchUrl(source: SourceIdentity): string {
    if (source.sourceKey === 'narou-metadata') {
      return `https://api.syosetu.com/novelapi/api/?out=json&ncode=${encodeURIComponent(source.remoteWorkId)}`;
    }
    return source.canonicalWorkUrl;
  }

  static sourceWorkKey(source: SourceIdentity): string {
    return `${source.sourceKey}:${source.remoteWorkId}`;
  }

  static sourceChapterKey(source: RemoteChapterStub): string {
    return `${source.sourceKey}:${source.remoteWorkId}:${source.remoteChapterId}`;
  }

  static matchesWorkUrl(url: string, source: SourceIdentity): boolean {
    const detected = this.detect(url);
    return (
      detected?.sourceKey === source.sourceKey && detected.remoteWorkId === source.remoteWorkId
    );
  }

  static matchesChapterUrl(url: string, source: RemoteChapterStub): boolean {
    try {
      const input = new URL(url);
      const identity = this.detect(input.href);
      if (
        identity?.sourceKey !== source.sourceKey ||
        identity.remoteWorkId !== source.remoteWorkId
      ) {
        return false;
      }
      const patterns: Partial<Record<SourceKey, RegExp>> = {
        kakuyomu: /^\/works\/([^/]+)\/episodes\/([^/]+)\/?$/,
        nobadnovel: /^\/series\/([^/]+)\/(chapter-[^/]+)\/?$/,
        freewebnovel: /^\/novel\/([^/]+)\/(chapter-[^/]+)\/?$/,
        novellunar: /^\/novel\/([^/]+)\/chapter\/(\d+)\/?$/,
      };
      const match = patterns[source.sourceKey]?.exec(input.pathname);
      return match?.[1]?.toLowerCase() === source.remoteWorkId && match[2] === source.remoteChapterId;
    } catch {
      return false;
    }
  }

  static chapterUrl(source: RemoteChapterStub): string {
    return source.canonicalChapterUrl;
  }
}

export function asImportError(error: unknown): ImportError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as Partial<ImportError>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return {
        code: candidate.code as ImportError['code'],
        message: candidate.message,
        retryable: candidate.retryable === true,
        ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
        ...(typeof candidate.retryAfterMs === 'number' ? { retryAfterMs: candidate.retryAfterMs } : {}),
      };
    }
  }
  return sourceError('unknown', '导入失败');
}

export function getSourceChapterTitle(chapter: RemoteChapterStub): string {
  return titleText(chapter.title);
}
