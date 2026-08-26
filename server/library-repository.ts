import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type {
  ImportJob,
  ImportJobItem,
  ImportLibraryBackup,
  RemoteChapterBody,
  RemoteChapterStub,
  RemoteWorkSnapshot,
} from '../src/models/importer';
import { sourceWorkMetadata } from '../src/services/importer/import-job-service';

const MAX_ID_LENGTH = 128;
const MAX_BOOKS_PAGE_SIZE = 100;
const SECRET_FIELD_NAMES = new Set([
  'apikey',
  'xapikey',
  'tavilyapikey',
  'secret',
  'syncsecret',
  'password',
  'cookie',
  'cookies',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'proxyauthorization',
  'credential',
  'credentials',
  'encryptedsecret',
]);
const MEMORY_FIELDS = new Set([
  'id',
  'bookId',
  'content',
  'summary',
  'createdAt',
  'lastAccessedAt',
  'embeddings',
  'embeddingModel',
]);
const BOOK_FIELDS = new Set([
  'id',
  'title',
  'alternateTitles',
  'author',
  'description',
  'cover',
  'tags',
  'volumes',
  'webUrl',
  'source',
  'starred',
  'lastEdited',
  'createdAt',
  'defaultAIModel',
  'characterSettings',
  'terminologies',
  'notes',
  'translationInstructions',
  'polishInstructions',
  'proofreadingInstructions',
  'preserveIndents',
  'normalizeSymbolsOnDisplay',
  'normalizeTitleOnDisplay',
  'translationChunkSize',
  'skipAskUser',
  'enableOriginalTextValidation',
  'taskModelOverrides',
]);

export class RepositoryError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'not_found' | 'conflict',
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type BookDto = Record<string, unknown>;
export type BookRecord = { book: BookDto; revision: number };
export type ChapterContentRecord = {
  chapterId: string;
  paragraphs: Array<Record<string, unknown>>;
  lastModified: string;
  revision: number;
};
export type MemoryDto = {
  id: string;
  bookId: string;
  content: string;
  summary: string;
  createdAt: number;
  lastAccessedAt: number;
  embeddings?: number[][];
  embeddingModel?: string;
};
export type MemoryRecord = { memory: MemoryDto; revision: number };
export type LibraryPage = { items: BookRecord[]; nextCursor?: string };
export type WebLibraryBackup = {
  version: 2;
  exportedAt: string;
  books: BookDto[];
  chapterContents: Array<ChapterContentRecord & { bookId: string }>;
  memories: MemoryDto[];
  coverHistory: Array<Record<string, unknown>>;
  jobs: ImportJob[];
  jobItems: ImportJobItem[];
  publicSettings?: Record<string, unknown>;
};

type StoredBook = {
  id: string;
  body_json: string;
  revision: number;
  last_edited: string;
};
type StoredChapterContent = {
  chapter_id: string;
  book_id: string;
  paragraphs_json: string;
  last_modified: string;
  revision: number;
};
type StoredJob = {
  body_json: string;
};
type StoredJobItem = {
  body_json: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// Repository errors are API error envelopes; the desktop importer throws local import errors instead.
// fallow-ignore-next-line code-duplication
function requireString(value: unknown, field: string, maxLength = 50_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new RepositoryError('invalid_request', 400, `${field} 无效`);
  }
  return value;
}

function requireId(value: unknown, field = 'id'): string {
  const id = requireString(value, field, MAX_ID_LENGTH);
  if (id.includes('\0') || id.includes('/') || id.includes('\\')) {
    throw new RepositoryError('invalid_request', 400, `${field} 无效`);
  }
  return id;
}

function safeJson<T>(value: string, fallback?: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new RepositoryError('invalid_request', 400, '持久化数据无效');
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isSecretField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Array.from(SECRET_FIELD_NAMES).some((name) => normalized.includes(name));
}

function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretField(key)) continue;
    result[key] = redacted(child);
  }
  return result;
}

function chapters(book: BookDto): Array<Record<string, unknown>> {
  const volumes = book.volumes;
  if (!Array.isArray(volumes)) return [];
  return volumes.flatMap((volume) => {
    if (!isRecord(volume) || !Array.isArray(volume.chapters)) return [];
    return volume.chapters.filter(isRecord);
  });
}

function chapterIds(book: BookDto): Set<string> {
  return new Set(chapters(book).flatMap((chapter) => (typeof chapter.id === 'string' ? [chapter.id] : [])));
}

function stripChapterBodies(book: BookDto): BookDto {
  const result = cloneJson(redacted(book)) as BookDto;
  if (!Array.isArray(result.volumes)) return result;
  result.volumes = result.volumes.map((volume) => {
    if (!isRecord(volume) || !Array.isArray(volume.chapters)) return volume;
    return {
      ...volume,
      chapters: volume.chapters.map((chapter) => {
        if (!isRecord(chapter)) return chapter;
        const { content: _content, originalContent: _originalContent, ...metadata } = chapter;
        return { ...metadata, contentLoaded: chapter.content !== undefined || chapter.contentLoaded === true };
      }),
    };
  });
  return result;
}

function assertBook(value: unknown): BookDto {
  if (!isRecord(value)) throw new RepositoryError('invalid_request', 400, '书籍无效');
  for (const key of Object.keys(value)) {
    if (!BOOK_FIELDS.has(key)) throw new RepositoryError('invalid_request', 400, '书籍包含未知字段');
  }
  requireId(value.id, '书籍 ID');
  requireString(value.title, '书籍标题');
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.lastEdited)) {
    throw new RepositoryError('invalid_request', 400, '书籍时间无效');
  }
  if (value.volumes !== undefined && !Array.isArray(value.volumes)) {
    throw new RepositoryError('invalid_request', 400, '书籍卷无效');
  }
  const normalized = stripChapterBodies(value);
  const ids = new Set<string>();
  for (const chapter of chapters(normalized)) {
    const chapterId = requireId(chapter.id, '章节 ID');
    if (ids.has(chapterId)) throw new RepositoryError('invalid_request', 400, '章节 ID 重复');
    ids.add(chapterId);
    requireString(chapter.title, '章节标题');
    if (!isIsoDate(chapter.createdAt) || !isIsoDate(chapter.lastEdited)) {
      throw new RepositoryError('invalid_request', 400, '章节时间无效');
    }
  }
  return normalized;
}

function assertParagraphs(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new RepositoryError('invalid_request', 400, '章节正文无效');
  if (value.length > 100_000) throw new RepositoryError('invalid_request', 400, '章节正文过大');
  return value.map((paragraph) => {
    if (!isRecord(paragraph)) throw new RepositoryError('invalid_request', 400, '章节正文无效');
    requireId(paragraph.id, '段落 ID');
    requireString(paragraph.text, '段落正文');
    if (typeof paragraph.selectedTranslationId !== 'string' || !Array.isArray(paragraph.translations)) {
      throw new RepositoryError('invalid_request', 400, '段落结构无效');
    }
    return cloneJson(paragraph);
  });
}

function assertMemory(value: unknown, expectedBookId?: string): MemoryDto {
  if (!isRecord(value)) throw new RepositoryError('invalid_request', 400, '记忆无效');
  for (const key of Object.keys(value)) {
    if (!MEMORY_FIELDS.has(key)) throw new RepositoryError('invalid_request', 400, '记忆包含未知字段');
  }
  const id = requireId(value.id, '记忆 ID');
  const bookId = requireId(value.bookId, '记忆书籍 ID');
  if (expectedBookId && bookId !== expectedBookId) {
    throw new RepositoryError('invalid_request', 400, '记忆书籍 ID 不匹配');
  }
  const content = requireString(value.content, '记忆内容', 1_000_000);
  const summary = requireString(value.summary, '记忆摘要', 100_000);
  if (
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.lastAccessedAt) ||
    (value.lastAccessedAt as number) < 0
  ) {
    throw new RepositoryError('invalid_request', 400, '记忆时间无效');
  }
  const embeddings = value.embeddings;
  if (
    embeddings !== undefined &&
    (!Array.isArray(embeddings) ||
      embeddings.length > 10_000 ||
      embeddings.some(
        (embedding) =>
          !Array.isArray(embedding) ||
          embedding.length > 10_000 ||
          embedding.some((number) => typeof number !== 'number' || !Number.isFinite(number)),
      ))
  ) {
    throw new RepositoryError('invalid_request', 400, '记忆向量无效');
  }
  if (value.embeddingModel !== undefined && typeof value.embeddingModel !== 'string') {
    throw new RepositoryError('invalid_request', 400, '记忆向量模型无效');
  }
  return {
    id,
    bookId,
    content,
    summary,
    createdAt: value.createdAt as number,
    lastAccessedAt: value.lastAccessedAt as number,
    ...(embeddings ? { embeddings: cloneJson(embeddings) as number[][] } : {}),
    ...(typeof value.embeddingModel === 'string' ? { embeddingModel: value.embeddingModel } : {}),
  };
}

function sourceColumns(book: BookDto): { sourceKey: string | null; remoteWorkId: string | null; canonicalWorkUrl: string | null } {
  const source = isRecord(book.source) ? book.source : null;
  return {
    sourceKey: source && typeof source.sourceKey === 'string' ? source.sourceKey : null,
    remoteWorkId: source && typeof source.remoteWorkId === 'string' ? source.remoteWorkId : null,
    canonicalWorkUrl: source && typeof source.canonicalWorkUrl === 'string' ? source.canonicalWorkUrl : null,
  };
}

function sourceMatch(book: BookDto, source: { sourceKey: string; remoteWorkId: string }): boolean {
  const candidate = isRecord(book.source) ? book.source : undefined;
  return candidate?.sourceKey === source.sourceKey && candidate.remoteWorkId === source.remoteWorkId;
}

function newImportedBook(snapshot: RemoteWorkSnapshot, source: unknown, checkedAt: string): BookDto {
  const book: BookDto = {
    id: `source-${randomUUID()}`,
    title: snapshot.title,
    webUrl: [snapshot.source.canonicalWorkUrl],
    source,
    volumes: [],
    createdAt: checkedAt,
    lastEdited: checkedAt,
  };
  if (snapshot.author) book.author = snapshot.author;
  if (snapshot.description) book.description = snapshot.description;
  if (snapshot.tags) book.tags = snapshot.tags;
  return book;
}

function extractTranslations(paragraphs: Array<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> {
  const byText = new Map<string, Array<Record<string, unknown>>>();
  for (const paragraph of paragraphs) {
    if (typeof paragraph.text !== 'string') continue;
    const bucket = byText.get(paragraph.text) ?? [];
    bucket.push(paragraph);
    byText.set(paragraph.text, bucket);
  }
  return byText;
}

function mergedParagraphs(
  previous: Array<Record<string, unknown>>,
  text: string[],
): Array<Record<string, unknown>> {
  const byText = extractTranslations(previous);
  return text.map((value) => {
    const existing = byText.get(value)?.shift();
    if (existing) return { ...existing, text: value };
    return { id: randomUUID(), text: value, selectedTranslationId: '', translations: [] };
  });
}

function sourceChapterMatch(chapter: Record<string, unknown>, remote: RemoteChapterStub): boolean {
  const source = isRecord(chapter.source) ? chapter.source : undefined;
  return (
    source?.sourceKey === remote.sourceKey &&
    source.remoteWorkId === remote.remoteWorkId &&
    source.remoteChapterId === remote.remoteChapterId
  );
}

function asCursor(value: string | undefined): { lastEdited: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const cursor = JSON.parse(decoded) as unknown;
    if (!isRecord(cursor) || !isIsoDate(cursor.lastEdited) || typeof cursor.id !== 'string') throw new Error('invalid');
    return { lastEdited: cursor.lastEdited, id: requireId(cursor.id, 'cursor') };
  } catch {
    throw new RepositoryError('invalid_request', 400, '分页游标无效');
  }
}

function createCursor(lastEdited: string, id: string): string {
  return Buffer.from(JSON.stringify({ lastEdited, id })).toString('base64url');
}

/** Shared optimistic-concurrency guard for expectedRevision-checked writes. */
function requireExpectedRevision(value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RepositoryError('invalid_request', 400, '版本无效');
  }
  return value;
}

function legacyChapterContents(
  value: unknown,
  books: BookDto[],
): Array<ChapterContentRecord & { bookId: string }> {
  if (!Array.isArray(value)) throw new RepositoryError('invalid_request', 400, '备份章节正文无效');
  const owners = new Map<string, string>();
  for (const book of books) {
    for (const chapterId of chapterIds(book)) owners.set(chapterId, requireId(book.id));
  }
  const seen = new Set<string>();
  return value.map((content) => {
    if (!isRecord(content) || !isIsoDate(content.lastModified) || typeof content.content !== 'string') {
      throw new RepositoryError('invalid_request', 400, '备份章节正文无效');
    }
    const chapterId = requireId(content.chapterId, '章节 ID');
    if (seen.has(chapterId)) throw new RepositoryError('invalid_request', 400, '备份章节 ID 重复');
    seen.add(chapterId);
    const bookId = owners.get(chapterId);
    if (!bookId) throw new RepositoryError('invalid_request', 400, '备份章节不属于书籍');
    return {
      chapterId,
      bookId,
      paragraphs: assertParagraphs(safeJson<unknown>(content.content)),
      lastModified: content.lastModified,
      revision: 1,
    };
  });
}

// V1 migration has legacy chapter ownership rules absent from desktop v2 imports.
// fallow-ignore-next-line code-duplication
function restoreV1(value: Record<string, unknown>): WebLibraryBackup {
  if (
    value.version !== 1 ||
    !isIsoDate(value.exportedAt) ||
    !Array.isArray(value.books) ||
    // fallow-ignore-next-line code-duplication
    !Array.isArray(value.chapterContents) ||
    !Array.isArray(value.jobs) ||
    !Array.isArray(value.jobItems)
  ) {
    throw new RepositoryError('invalid_request', 400, '备份格式无效');
  }
  const books = value.books.map(assertBook);
  const chapterContents = legacyChapterContents(value.chapterContents, books);
  return {
    version: 2,
    exportedAt: value.exportedAt,
    books,
    chapterContents,
    memories: [],
    coverHistory: [],
    jobs: value.jobs as ImportJob[],
    jobItems: value.jobItems as ImportJobItem[],
  };
}

function restoreDesktopV2(value: Record<string, unknown>): Record<string, unknown> {
  if (
    // fallow-ignore-next-line code-duplication
    value.version !== 2 ||
    value.kind !== 'web-library-backup-v2' ||
    !isIsoDate(value.exportedAt) ||
    !Array.isArray(value.books)
  ) {
    throw new RepositoryError('invalid_request', 400, '备份格式无效');
  }
  const books = value.books.map(assertBook);
  return {
    version: 2,
    exportedAt: value.exportedAt,
    books,
    chapterContents: legacyChapterContents(value.chapterContents, books),
    memories: value.memories,
    coverHistory: value.coverHistory,
    jobs: value.jobs,
    jobItems: value.jobItems,
  };
}

function assertBackup(value: unknown): WebLibraryBackup {
  if (!isRecord(value)) throw new RepositoryError('invalid_request', 400, '备份格式无效');
  if (value.version === 1) return assertBackup(restoreV1(value));
  if (value.version === 2 && value.kind === 'web-library-backup-v2') return assertBackup(restoreDesktopV2(value));
  if (
    value.version !== 2 ||
    !isIsoDate(value.exportedAt) ||
    !Array.isArray(value.books) ||
    // fallow-ignore-next-line code-duplication
    !Array.isArray(value.chapterContents) ||
    !Array.isArray(value.memories) ||
    !Array.isArray(value.coverHistory) ||
    !Array.isArray(value.jobs) ||
    !Array.isArray(value.jobItems)
  ) {
    throw new RepositoryError('invalid_request', 400, '备份格式无效');
  }
  const books = value.books.map(assertBook);
  const bookIds = new Set(books.map((book) => requireId(book.id)));
  const chapterOwners = new Map<string, string>();
  for (const book of books) {
    for (const chapterId of chapterIds(book)) chapterOwners.set(chapterId, requireId(book.id));
  }
  const chapterContents = value.chapterContents.map((content) => {
    if (
      !isRecord(content) ||
      !isIsoDate(content.lastModified) ||
      typeof content.revision !== 'number' ||
      !Number.isSafeInteger(content.revision)
    ) {
      throw new RepositoryError('invalid_request', 400, '备份章节正文无效');
    }
    const chapterId = requireId(content.chapterId, '章节 ID');
    const bookId = requireId(content.bookId, '书籍 ID');
    if (chapterOwners.get(chapterId) !== bookId) {
      throw new RepositoryError('invalid_request', 400, '备份章节不属于书籍');
    }
    return {
      chapterId,
      bookId,
      paragraphs: assertParagraphs(content.paragraphs),
      lastModified: content.lastModified,
      revision: Math.max(1, content.revision),
    };
  });
  const memories = value.memories.map((memory) => {
    const validated = assertMemory(memory);
    if (!bookIds.has(validated.bookId)) {
      throw new RepositoryError('invalid_request', 400, '备份记忆无效');
    }
    return validated;
  });
  const jobs = value.jobs.map((job) => {
    if (!isRecord(job)) throw new RepositoryError('invalid_request', 400, '备份任务无效');
    requireId(job.id, '任务 ID');
    requireString(job.idempotencyKey, '幂等键', 256);
    requireString(job.sourceWorkKey, '来源作品键', 256);
    requireString(job.status, '任务状态');
    return cloneJson(job) as unknown as ImportJob;
  });
  const jobIds = new Set(jobs.map((job) => job.id));
  const jobItems = value.jobItems.map((item) => {
    if (!isRecord(item) || !jobIds.has(requireId(item.jobId, '任务 ID'))) {
      throw new RepositoryError('invalid_request', 400, '备份任务条目无效');
    }
    requireId(item.id, '任务条目 ID');
    requireString(item.remoteChapterId, '远程章节 ID');
    requireString(item.sourceChapterKey, '来源章节键');
    return cloneJson(item) as unknown as ImportJobItem;
  });
  return {
    version: 2,
    exportedAt: value.exportedAt,
    books,
    chapterContents,
    memories,
    coverHistory: value.coverHistory.filter(isRecord).map((item) => cloneJson(item)),
    jobs,
    jobItems,
    ...(isRecord(value.publicSettings) ? { publicSettings: cloneJson(redacted(value.publicSettings)) as Record<string, unknown> } : {}),
  };
}

export class LibraryRepository {
  constructor(readonly database: Database) {}

  runInTransaction<T>(operation: () => T): T {
    if (this.database.inTransaction) return operation();
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back a failed transaction.
      }
      throw error;
    }
  }

  listBooks(limit = 50, cursor?: string): LibraryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOOKS_PAGE_SIZE) {
      throw new RepositoryError('invalid_request', 400, '分页大小无效');
    }
    const decoded = asCursor(cursor);
    const rows = decoded
      ? (this.database
          .query(
            `SELECT id, body_json, revision, last_edited FROM books
             WHERE last_edited < ? OR (last_edited = ? AND id < ?)
             ORDER BY last_edited DESC, id DESC LIMIT ?`,
          )
          .all(decoded.lastEdited, decoded.lastEdited, decoded.id, limit + 1) as StoredBook[])
      : (this.database
          .query('SELECT id, body_json, revision, last_edited FROM books ORDER BY last_edited DESC, id DESC LIMIT ?')
          .all(limit + 1) as StoredBook[]);
    const page = rows.slice(0, limit).map((row) => this.toBookRecord(row));
    const last = page.at(-1);
    return {
      items: page,
      ...(rows.length > limit && last
        ? { nextCursor: createCursor(requireString(last.book.lastEdited, '书籍时间'), requireId(last.book.id)) }
        : {}),
    };
  }

  getBook(id: string): BookRecord | undefined {
    const row = this.database
      .query('SELECT id, body_json, revision, last_edited FROM books WHERE id = ?')
      .get(requireId(id, '书籍 ID')) as StoredBook | null;
    return row ? this.toBookRecord(row) : undefined;
  }

  createBook(value: unknown): BookRecord {
    const book = assertBook(value);
    return this.runInTransaction(() => {
      if (this.getBook(requireId(book.id))) throw new RepositoryError('conflict', 409, '书籍已存在');
      this.insertBook(book, 1);
      return { book, revision: 1 };
    });
  }

  updateBook(id: string, value: unknown, expectedRevision: number): BookRecord {
    const bookId = requireId(id, '书籍 ID');
    const book = assertBook(value);
    if (requireId(book.id) !== bookId) throw new RepositoryError('invalid_request', 400, '书籍 ID 不匹配');
    requireExpectedRevision(expectedRevision, 1);
    return this.runInTransaction(() => {
      const existing = this.getBook(bookId);
      if (!existing) throw new RepositoryError('not_found', 404, '书籍不存在');
      if (existing.revision !== expectedRevision) throw new RepositoryError('conflict', 409, '书籍已更新');
      const revision = existing.revision + 1;
      this.insertBook(book, revision, true);
      return { book, revision };
    });
  }

  deleteBook(id: string, expectedRevision: number): void {
    const bookId = requireId(id, '书籍 ID');
    requireExpectedRevision(expectedRevision, 1);
    this.runInTransaction(() => {
      const existing = this.getBook(bookId);
      if (!existing) throw new RepositoryError('not_found', 404, '书籍不存在');
      if (existing.revision !== expectedRevision) throw new RepositoryError('conflict', 409, '书籍已更新');
      this.database.query('DELETE FROM books WHERE id = ?').run(bookId);
    });
  }

  // Content lookup verifies chapter membership before querying its compound storage key.
  // fallow-ignore-next-line code-duplication
  getChapterContent(bookId: string, chapterId: string): ChapterContentRecord | undefined {
    const safeBookId = requireId(bookId, '书籍 ID');
    const safeChapterId = requireId(chapterId, '章节 ID');
    // fallow-ignore-next-line code-duplication
    const book = this.getBook(safeBookId);
    if (!book) throw new RepositoryError('not_found', 404, '书籍不存在');
    if (!chapterIds(book.book).has(safeChapterId)) throw new RepositoryError('not_found', 404, '章节不存在');
    const row = this.database
      .query(
        'SELECT chapter_id, book_id, paragraphs_json, last_modified, revision FROM chapter_contents WHERE chapter_id = ? AND book_id = ?',
      )
      .get(safeChapterId, safeBookId) as StoredChapterContent | null;
    return row ? this.toChapterRecord(row) : undefined;
  }

  // Content writes use revision zero for first creation and update content storage atomically.
  // fallow-ignore-next-line code-duplication
  putChapterContent(
    bookId: string,
    chapterId: string,
    value: unknown,
    expectedRevision: number,
  ): ChapterContentRecord {
    const safeBookId = requireId(bookId, '书籍 ID');
    const safeChapterId = requireId(chapterId, '章节 ID');
    const paragraphs = assertParagraphs(value);
    requireExpectedRevision(expectedRevision, 0);
    return this.runInTransaction(() => {
      // fallow-ignore-next-line code-duplication
      const book = this.getBook(safeBookId);
      if (!book) throw new RepositoryError('not_found', 404, '书籍不存在');
      if (!chapterIds(book.book).has(safeChapterId)) throw new RepositoryError('not_found', 404, '章节不存在');
      const existing = this.database
        .query(
          'SELECT chapter_id, book_id, paragraphs_json, last_modified, revision FROM chapter_contents WHERE chapter_id = ? AND book_id = ?',
        )
        .get(safeChapterId, safeBookId) as StoredChapterContent | null;
      const revision = existing ? existing.revision + 1 : 1;
      if ((existing?.revision ?? 0) !== expectedRevision) {
        throw new RepositoryError('conflict', 409, '章节正文已更新');
      }
      const lastModified = new Date().toISOString();
      this.database
        .query(
          `INSERT INTO chapter_contents (chapter_id, book_id, paragraphs_json, last_modified, revision)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chapter_id) DO UPDATE SET
             book_id = excluded.book_id,
             paragraphs_json = excluded.paragraphs_json,
             last_modified = excluded.last_modified,
             revision = excluded.revision`,
        )
        .run(safeChapterId, safeBookId, JSON.stringify(paragraphs), lastModified, revision);
      return { chapterId: safeChapterId, paragraphs, lastModified, revision };
    });
  }

  getMemory(bookId: string, memoryId: string): MemoryRecord | undefined {
    const safeBookId = requireId(bookId, '书籍 ID');
    const safeMemoryId = requireId(memoryId, '记忆 ID');
    if (!this.getBook(safeBookId)) throw new RepositoryError('not_found', 404, '书籍不存在');
    const row = this.database
      .query('SELECT body_json, revision FROM memories WHERE id = ? AND book_id = ?')
      .get(safeMemoryId, safeBookId) as { body_json: string; revision: number } | null;
    return row ? this.toMemoryRecord(row, safeBookId) : undefined;
  }

  listMemories(bookId: string): MemoryRecord[] {
    const safeBookId = requireId(bookId, '书籍 ID');
    if (!this.getBook(safeBookId)) throw new RepositoryError('not_found', 404, '书籍不存在');
    return (
      this.database
        .query('SELECT body_json, revision FROM memories WHERE book_id = ? ORDER BY last_accessed_at DESC, id DESC')
        .all(safeBookId) as Array<{ body_json: string; revision: number }>
    ).map((row) => this.toMemoryRecord(row, safeBookId));
  }

  createMemory(bookId: string, value: unknown): MemoryRecord {
    const safeBookId = requireId(bookId, '书籍 ID');
    const memory = assertMemory(value, safeBookId);
    return this.runInTransaction(() => {
      if (!this.getBook(safeBookId)) throw new RepositoryError('not_found', 404, '书籍不存在');
      const existing = this.database.query('SELECT 1 FROM memories WHERE id = ?').get(memory.id);
      if (existing) throw new RepositoryError('conflict', 409, '记忆已存在');
      this.database
        .query(
          'INSERT INTO memories (id, book_id, body_json, created_at, last_accessed_at, revision) VALUES (?, ?, ?, ?, ?, 1)',
        )
        .run(memory.id, safeBookId, JSON.stringify(memory), memory.createdAt, memory.lastAccessedAt);
      return { memory, revision: 1 };
    });
  }

  updateMemory(bookId: string, memoryId: string, value: unknown, expectedRevision: number): MemoryRecord {
    const safeBookId = requireId(bookId, '书籍 ID');
    const safeMemoryId = requireId(memoryId, '记忆 ID');
    const memory = assertMemory(value, safeBookId);
    if (memory.id !== safeMemoryId) throw new RepositoryError('invalid_request', 400, '记忆 ID 不匹配');
    requireExpectedRevision(expectedRevision, 1);
    return this.runInTransaction(() => {
      const existing = this.getMemory(safeBookId, safeMemoryId);
      if (!existing) throw new RepositoryError('not_found', 404, '记忆不存在');
      if (existing.revision !== expectedRevision) throw new RepositoryError('conflict', 409, '记忆已更新');
      const revision = existing.revision + 1;
      this.database
        .query(
          'UPDATE memories SET body_json = ?, created_at = ?, last_accessed_at = ?, revision = ? WHERE id = ? AND book_id = ?',
        )
        .run(JSON.stringify(memory), memory.createdAt, memory.lastAccessedAt, revision, safeMemoryId, safeBookId);
      return { memory, revision };
    });
  }

  deleteMemory(bookId: string, memoryId: string, expectedRevision: number): void {
    const safeBookId = requireId(bookId, '书籍 ID');
    const safeMemoryId = requireId(memoryId, '记忆 ID');
    requireExpectedRevision(expectedRevision, 1);
    this.runInTransaction(() => {
      const existing = this.getMemory(safeBookId, safeMemoryId);
      if (!existing) throw new RepositoryError('not_found', 404, '记忆不存在');
      if (existing.revision !== expectedRevision) throw new RepositoryError('conflict', 409, '记忆已更新');
      this.database.query('DELETE FROM memories WHERE id = ? AND book_id = ?').run(safeMemoryId, safeBookId);
    });
  }

  getPublicSettings(): { settings: Record<string, unknown>; revision: number } {
    const row = this.database
      .query(
        "SELECT body_json, revision FROM state_documents WHERE namespace = 'public-settings' AND document_key = 'default'",
      )
      .get() as { body_json: string; revision: number } | null;
    return row
      ? { settings: redacted(safeJson<unknown>(row.body_json)) as Record<string, unknown>, revision: row.revision }
      : { settings: {}, revision: 0 };
  }

  putPublicSettings(value: unknown, expectedRevision: number): { settings: Record<string, unknown>; revision: number } {
    if (!isRecord(value) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RepositoryError('invalid_request', 400, '设置无效');
    }
    return this.runInTransaction(() => {
      const current = this.getPublicSettings();
      if (current.revision !== expectedRevision) throw new RepositoryError('conflict', 409, '设置已更新');
      const settings = redacted(value) as Record<string, unknown>;
      const revision = current.revision + 1;
      this.database
        .query(
          `INSERT INTO state_documents (namespace, document_key, body_json, revision, updated_at)
           VALUES ('public-settings', 'default', ?, ?, ?)
           ON CONFLICT(namespace, document_key) DO UPDATE SET
             body_json = excluded.body_json,
             revision = excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify(settings), revision, new Date().toISOString());
      return { settings, revision };
    });
  }

  createBackup(): WebLibraryBackup {
    const books = (this.database.query('SELECT body_json FROM books ORDER BY id').all() as StoredBook[]).map((row) =>
      assertBook(safeJson<unknown>(row.body_json)),
    );
    const chapterContents = (
      this.database
        .query('SELECT chapter_id, book_id, paragraphs_json, last_modified, revision FROM chapter_contents ORDER BY chapter_id')
        .all() as StoredChapterContent[]
    ).map((row) => ({ ...this.toChapterRecord(row), bookId: row.book_id }));
    const memories = (this.database.query('SELECT body_json FROM memories ORDER BY id').all() as StoredJob[]).map((row) =>
      assertMemory(safeJson<unknown>(row.body_json)),
    );
    const coverHistory = (
      this.database
        .query("SELECT body_json FROM state_documents WHERE namespace = 'cover-history' ORDER BY document_key")
        .all() as StoredJob[]
    ).map((row) => redacted(safeJson<unknown>(row.body_json)) as Record<string, unknown>);
    const jobs = (this.database.query('SELECT body_json FROM import_jobs ORDER BY created_at, id').all() as StoredJob[]).map(
      (row) => safeJson<ImportJob>(row.body_json),
    );
    const jobItems = (
      this.database.query('SELECT body_json FROM import_job_items ORDER BY job_id, id').all() as StoredJobItem[]
    ).map((row) => safeJson<ImportJobItem>(row.body_json));
    const settings = this.database
      .query("SELECT body_json FROM state_documents WHERE namespace = 'public-settings' AND document_key = 'default'")
      .get() as StoredJob | null;
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      books,
      chapterContents,
      memories,
      coverHistory,
      jobs,
      jobItems,
      ...(settings ? { publicSettings: redacted(safeJson<unknown>(settings.body_json)) as Record<string, unknown> } : {}),
    };
  }

  restoreBackup(value: unknown, confirmation: string): void {
    if (confirmation !== 'REPLACE_LIBRARY') {
      throw new RepositoryError('invalid_request', 400, '需要确认替换书库');
    }
    const backup = assertBackup(value);
    this.runInTransaction(() => {
      this.database.exec(`
        DELETE FROM job_events;
        DELETE FROM import_job_items;
        DELETE FROM import_jobs;
        DELETE FROM memories;
        DELETE FROM chapter_contents;
        DELETE FROM books;
        DELETE FROM state_documents WHERE namespace IN ('cover-history', 'public-settings');
      `);
      for (const book of backup.books) this.insertBook(book, 1);
      for (const content of backup.chapterContents) {
        this.database
          .query(
            'INSERT INTO chapter_contents (chapter_id, book_id, paragraphs_json, last_modified, revision) VALUES (?, ?, ?, ?, ?)',
          )
          .run(content.chapterId, content.bookId, JSON.stringify(content.paragraphs), content.lastModified, content.revision);
      }
      for (const memory of backup.memories) {
        this.database
          .query(
            'INSERT INTO memories (id, book_id, body_json, created_at, last_accessed_at, revision) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            memory.id,
            memory.bookId,
            JSON.stringify(memory),
            memory.createdAt,
            memory.lastAccessedAt,
            1,
          );
      }
      for (const cover of backup.coverHistory) {
        this.database
          .query(
            'INSERT INTO state_documents (namespace, document_key, body_json, revision, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('cover-history', requireId(cover.id, '封面 ID'), JSON.stringify(cover), 1, new Date().toISOString());
      }
      for (const job of backup.jobs) this.insertJob(job);
      for (const item of backup.jobItems) this.insertJobItem(item);
      if (backup.publicSettings) {
        this.database
          .query(
            'INSERT INTO state_documents (namespace, document_key, body_json, revision, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('public-settings', 'default', JSON.stringify(backup.publicSettings), 1, new Date().toISOString());
      }
    });
  }

  // Server snapshots use UUID identifiers and SQLite revisions; desktop imports use IndexedDB models.
  // fallow-ignore-next-line code-duplication
  upsertImportedSnapshot(snapshot: RemoteWorkSnapshot): BookRecord {
    return this.runInTransaction(() => {
      const rows = this.database.query('SELECT id, body_json, revision, last_edited FROM books').all() as StoredBook[];
      const existing = rows
        .map((row) => this.toBookRecord(row))
        .find((record) => sourceMatch(record.book, snapshot.source));
      const checkedAt = new Date().toISOString();
      const source = sourceWorkMetadata(snapshot, checkedAt);
      const book: BookDto = existing
      // fallow-ignore-next-line code-duplication
        ? {
            ...existing.book,
            webUrl: Array.from(
              new Set([...(Array.isArray(existing.book.webUrl) ? existing.book.webUrl : []), snapshot.source.canonicalWorkUrl]),
            ),
            source,
            lastEdited: checkedAt,
          }
        : newImportedBook(snapshot, source, checkedAt);
      const normalized = assertBook(book);
      const revision = (existing?.revision ?? 0) + 1;
      this.insertBook(normalized, revision, Boolean(existing));
      return { book: normalized, revision };
    });
  }

  applyImportedChapter(bookId: string, remote: RemoteChapterStub, body: RemoteChapterBody): {
    book: BookRecord;
    chapterId: string;
    changed: boolean;
  } {
    return this.runInTransaction(() => {
      const existing = this.getBook(bookId);
      if (!existing) throw new RepositoryError('not_found', 404, '导入目标书籍不存在');
      const book = cloneJson(existing.book);
      const volumeList = Array.isArray(book.volumes) ? book.volumes.filter(isRecord) : [];
      let targetVolume = volumeList.find((volume) => {
        const source = isRecord(volume.source) ? volume.source : undefined;
        return (
          source?.sourceKey === remote.sourceKey &&
          source.remoteWorkId === remote.remoteWorkId &&
          source.remoteVolumeId === remote.volume.remoteVolumeId
        );
      });
      if (!targetVolume) {
        targetVolume = {
          id: `source-volume-${randomUUID()}`,
          title: remote.volume.title,
          chapters: [],
          source: {
            sourceKey: remote.sourceKey,
            remoteWorkId: remote.remoteWorkId,
            remoteVolumeId: remote.volume.remoteVolumeId,
          },
        };
        volumeList.push(targetVolume);
      }
      if (!Array.isArray(targetVolume.chapters)) targetVolume.chapters = [];
      const chapter = chapters(book).find((candidate) => sourceChapterMatch(candidate, remote));
      const fetchedAt = new Date().toISOString();
      const source = {
        sourceKey: remote.sourceKey,
        remoteWorkId: remote.remoteWorkId,
        canonicalWorkUrl: remote.canonicalWorkUrl,
        remoteChapterId: remote.remoteChapterId,
        canonicalChapterUrl: remote.canonicalChapterUrl,
        remoteTitle: remote.title,
        ...(remote.remoteUpdatedAt ? { remoteUpdatedAt: remote.remoteUpdatedAt } : {}),
        contentHash: body.contentHash,
        parserVersion: body.parserVersion,
        fetchedAt,
        sequence: remote.sequence,
      };
      const chapterId = chapter ? requireId(chapter.id, '章节 ID') : `source-chapter-${randomUUID()}`;
      const stored = this.database
        .query(
          'SELECT chapter_id, book_id, paragraphs_json, last_modified, revision FROM chapter_contents WHERE chapter_id = ? AND book_id = ?',
        )
        .get(chapterId, bookId) as StoredChapterContent | null;
      const previous = stored ? this.toChapterRecord(stored).paragraphs : [];
      const unchanged = isRecord(chapter?.source) && chapter.source.contentHash === body.contentHash;
      const nextParagraphs = unchanged ? previous : mergedParagraphs(previous, body.paragraphs);
      const nextChapter: Record<string, unknown> = chapter
        ? { ...chapter, webUrl: remote.canonicalChapterUrl, source, lastEdited: fetchedAt }
        : {
            id: chapterId,
            title: remote.title,
            webUrl: remote.canonicalChapterUrl,
            source,
            contentLoaded: true,
            createdAt: fetchedAt,
            lastEdited: fetchedAt,
          };
      delete nextChapter.originalContent;
      for (const volume of volumeList) {
        if (Array.isArray(volume.chapters)) {
          volume.chapters = volume.chapters.filter(
            (candidate) => !isRecord(candidate) || requireId(candidate.id, '章节 ID') !== chapterId,
          );
        }
      }
      const targetChapters = Array.isArray(targetVolume.chapters) ? targetVolume.chapters : [];
      targetVolume.chapters = [...targetChapters, nextChapter];
      book.volumes = volumeList;
      book.lastEdited = fetchedAt;
      const normalized = assertBook(book);
      const revision = existing.revision + 1;
      this.insertBook(normalized, revision, true);
      if (!unchanged) {
        const contentRevision = (stored?.revision ?? 0) + 1;
        this.database
          .query(
            `INSERT INTO chapter_contents (chapter_id, book_id, paragraphs_json, last_modified, revision)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(chapter_id) DO UPDATE SET
               book_id = excluded.book_id,
               paragraphs_json = excluded.paragraphs_json,
               last_modified = excluded.last_modified,
               revision = excluded.revision`,
          )
          .run(chapterId, bookId, JSON.stringify(nextParagraphs), fetchedAt, contentRevision);
      }
      return { book: { book: normalized, revision }, chapterId, changed: !unchanged };
    });
  }

  private toBookRecord(row: StoredBook): BookRecord {
    return { book: assertBook(safeJson<unknown>(row.body_json)), revision: row.revision };
  }

  private toChapterRecord(row: StoredChapterContent): ChapterContentRecord {
    return {
      chapterId: row.chapter_id,
      paragraphs: assertParagraphs(safeJson<unknown>(row.paragraphs_json)),
      lastModified: row.last_modified,
      revision: row.revision,
    };
  }

  private toMemoryRecord(
    row: { body_json: string; revision: number },
    expectedBookId: string,
  ): MemoryRecord {
    return { memory: assertMemory(safeJson<unknown>(row.body_json), expectedBookId), revision: row.revision };
  }

  private insertBook(book: BookDto, revision: number, update = false): void {
    const columns = sourceColumns(book);
    const id = requireId(book.id, '书籍 ID');
    const body = JSON.stringify(book);
    const createdAt = requireString(book.createdAt, '书籍创建时间');
    const lastEdited = requireString(book.lastEdited, '书籍修改时间');
    try {
      if (update) {
        this.database
          .query(
            `UPDATE books SET body_json = ?, source_key = ?, remote_work_id = ?, canonical_work_url = ?,
             created_at = ?, last_edited = ?, revision = ? WHERE id = ?`,
          )
          .run(
            body,
            columns.sourceKey,
            columns.remoteWorkId,
            columns.canonicalWorkUrl,
            createdAt,
            lastEdited,
            revision,
            id,
          );
      } else {
        this.database
          .query(
            `INSERT INTO books (id, body_json, source_key, remote_work_id, canonical_work_url, created_at, last_edited, revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            body,
            columns.sourceKey,
            columns.remoteWorkId,
            columns.canonicalWorkUrl,
            createdAt,
            lastEdited,
            revision,
          );
      }
    } catch {
      throw new RepositoryError('conflict', 409, '书籍来源已存在');
    }
  }

  private insertJob(job: ImportJob): void {
    this.database
      .query(
        `INSERT INTO import_jobs
          (id, body_json, idempotency_key, source_work_key, source_key, remote_work_id, status, created_at, updated_at, completed_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requireId(job.id, '任务 ID'),
        JSON.stringify(job),
        requireString(job.idempotencyKey, '幂等键', 256),
        requireString(job.sourceWorkKey, '来源作品键', 256),
        requireString(job.sourceKey, '来源键'),
        requireString(job.remoteWorkId, '远程作品 ID'),
        requireString(job.status, '任务状态'),
        requireString(job.createdAt, '创建时间'),
        requireString(job.updatedAt, '更新时间'),
        job.completedAt ?? null,
        1,
      );
  }

  private insertJobItem(item: ImportJobItem): void {
    this.database
      .query(
        `INSERT INTO import_job_items
          (id, job_id, body_json, remote_chapter_id, source_chapter_key, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requireId(item.id, '任务条目 ID'),
        requireId(item.jobId, '任务 ID'),
        JSON.stringify(item),
        requireString(item.remoteChapterId, '远程章节 ID'),
        requireString(item.sourceChapterKey, '来源章节键'),
        requireString(item.status, '任务条目状态'),
        item.attempts,
        requireString(item.createdAt, '创建时间'),
        requireString(item.updatedAt, '更新时间'),
      );
  }
}

export function parseLibraryBackup(value: unknown): WebLibraryBackup | ImportLibraryBackup {
  return assertBackup(value);
}
