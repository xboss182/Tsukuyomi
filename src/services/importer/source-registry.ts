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

function sourceError(code: ImportError['code'], message: string, retryable = false): ImportError {
  return { code, message, retryable };
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

const adapters: SourceAdapter[] = [kakuyomuAdapter, narouAdapter];

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
