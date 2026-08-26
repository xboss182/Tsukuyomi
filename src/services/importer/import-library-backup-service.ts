import type {
  ImportedChapterContent,
  ImportJob,
  ImportJobItem,
  ImportLibraryBackup,
  WebLibraryMigrationBackup,
} from 'src/models/importer';
import type { CoverHistoryItem, Novel } from 'src/models/novel';
import type { Memory } from 'src/models/memory';
import { getDB } from 'src/utils/indexed-db';
import { clearCache as clearChapterContentCache } from 'src/utils/chapter-content-loader';
import { deserializeDates, serializeDates } from 'src/utils/serialize-dates';

const LIBRARY_STORE_NAMES = [
  'books',
  'chapter-contents',
  'import-jobs',
  'import-job-items',
] as const;

const WEB_LIBRARY_STORE_NAMES = [
  'books',
  'chapter-contents',
  'memories',
  'cover-history',
  'import-jobs',
  'import-job-items',
] as const;

type LibraryStoreName = (typeof WEB_LIBRARY_STORE_NAMES)[number];

const SENSITIVE_FIELD_NAMES = new Set([
  'apikey',
  'xapikey',
  'tavilyapikey',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'password',
  'secret',
  'syncsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'proxyauthorization',
  'encryptedsecret',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key].trim().length > 0;
}

function hasValidBooks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((book) => isRecord(book) && hasString(book, 'id') && hasString(book, 'title'))
  );
}

function hasValidChapterContents(value: unknown): value is ImportedChapterContent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (content) =>
        isRecord(content) &&
        hasString(content, 'chapterId') &&
        typeof content.content === 'string' &&
        isIsoDate(content.lastModified),
    )
  );
}

function hasValidJobs(value: unknown): value is ImportJob[] {
  return (
    Array.isArray(value) &&
    value.every(
      (job) =>
        isRecord(job) &&
        hasString(job, 'id') &&
        hasString(job, 'idempotencyKey') &&
        hasString(job, 'sourceWorkKey') &&
        hasString(job, 'status'),
    )
  );
}

function hasValidJobItems(value: unknown): value is ImportJobItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        hasString(item, 'id') &&
        hasString(item, 'jobId') &&
        hasString(item, 'jobStatusKey') &&
        hasString(item, 'sourceChapterKey') &&
        hasString(item, 'status'),
    )
  );
}

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return Array.from(SENSITIVE_FIELD_NAMES).some((name) => normalized.includes(name)) || containsSensitiveField(child);
  });
}

function redactSensitiveFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSensitiveFields) as T;
  if (value instanceof Date) return new Date(value) as T;
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!Array.from(SENSITIVE_FIELD_NAMES).some((name) => normalized.includes(name))) {
      redacted[key] = redactSensitiveFields(child);
    }
  }
  return redacted as T;
}

function backupChapterIds(books: Novel[]): Set<string> {
  return new Set(
    books.flatMap((book) =>
      (book.volumes || []).flatMap((volume) => (volume.chapters || []).map((chapter) => chapter.id)),
    ),
  );
}

function isMemory(value: unknown): value is Memory {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'bookId') &&
    typeof value.content === 'string' &&
    typeof value.summary === 'string' &&
    Number.isSafeInteger(value.createdAt) &&
    Number.isSafeInteger(value.lastAccessedAt)
  );
}

function isCoverHistoryItem(value: unknown): value is CoverHistoryItem {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'url') &&
    ((value.addedAt instanceof Date && !Number.isNaN(value.addedAt.getTime())) || isIsoDate(value.addedAt))
  );
}

function validateWebMigrationBackup(value: unknown): WebLibraryMigrationBackup {
  if (!isRecord(value) || value.version !== 2 || value.kind !== 'web-library-backup-v2' || !isIsoDate(value.exportedAt)) {
    throw new Error('Web 迁移备份格式无效');
  }
  if (!hasValidBooks(value.books) || !hasValidChapterContents(value.chapterContents)) {
    throw new Error('Web 迁移备份格式无效');
  }
  const books = value.books as Novel[];
  const bookIds = new Set(books.map((book) => book.id));
  const chapterIds = backupChapterIds(books);
  if (value.chapterContents.some((content) => !chapterIds.has(content.chapterId))) {
    throw new Error('Web 迁移备份格式无效');
  }
  if (!Array.isArray(value.memories) || !value.memories.every((memory) => isMemory(memory) && bookIds.has(memory.bookId))) {
    throw new Error('Web 迁移备份格式无效');
  }
  if (!Array.isArray(value.coverHistory) || !value.coverHistory.every(isCoverHistoryItem)) {
    throw new Error('Web 迁移备份格式无效');
  }
  const jobIds = new Set(Array.isArray(value.jobs) ? value.jobs.map((job) => (job as ImportJob).id) : []);
  if (
    !hasValidJobs(value.jobs) ||
    !hasValidJobItems(value.jobItems) ||
    value.jobItems.some((item) => !jobIds.has(item.jobId)) ||
    containsSensitiveField(value)
  ) {
    throw new Error('Web 迁移备份格式无效');
  }
  return value as unknown as WebLibraryMigrationBackup;
}

function validateBackup(value: unknown): ImportLibraryBackup {
  if (!isRecord(value) || value.version !== 1 || !isIsoDate(value.exportedAt)) {
    throw new Error('导入备份格式无效');
  }
  if (!hasValidBooks(value.books)) throw new Error('导入备份格式无效');
  if (!hasValidChapterContents(value.chapterContents)) throw new Error('导入备份格式无效');
  if (!hasValidJobs(value.jobs)) throw new Error('导入备份格式无效');
  if (!hasValidJobItems(value.jobItems)) throw new Error('导入备份格式无效');

  return value as unknown as ImportLibraryBackup;
}

/**
 * 本地手工导入/导出的库快照。数据先完整校验，再用一个 IndexedDB 事务替换四个库，
 * 因此损坏备份不会先清空现有图书或导入任务。
 */
export class ImportLibraryBackupService {
  static async createBackup(): Promise<ImportLibraryBackup> {
    const db = await getDB();
    const tx = db.transaction(LIBRARY_STORE_NAMES, 'readonly');
    const [books, chapterContents, jobs, jobItems] = await Promise.all([
      tx.objectStore('books').getAll(),
      tx.objectStore('chapter-contents').getAll(),
      tx.objectStore('import-jobs').getAll(),
      tx.objectStore('import-job-items').getAll(),
    ]);
    await tx.done;

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      books,
      chapterContents,
      jobs,
      jobItems,
    };
  }

  /** Safe desktop-to-web export; settings and credentials never cross this boundary. */
  static async createWebMigrationBackup(): Promise<WebLibraryMigrationBackup> {
    const db = await getDB();
    const tx = db.transaction(WEB_LIBRARY_STORE_NAMES, 'readonly');
    const [books, chapterContents, memories, coverHistory, jobs, jobItems] = await Promise.all([
      tx.objectStore('books').getAll(),
      tx.objectStore('chapter-contents').getAll(),
      tx.objectStore('memories').getAll(),
      tx.objectStore('cover-history').getAll(),
      tx.objectStore('import-jobs').getAll(),
      tx.objectStore('import-job-items').getAll(),
    ]);
    await tx.done;
    const backup: WebLibraryMigrationBackup = {
      version: 2,
      kind: 'web-library-backup-v2',
      exportedAt: new Date().toISOString(),
      books: serializeDates(redactSensitiveFields(books)),
      chapterContents: serializeDates(redactSensitiveFields(chapterContents)),
      memories: serializeDates(redactSensitiveFields(memories)),
      coverHistory: serializeDates(redactSensitiveFields(coverHistory)),
      jobs: serializeDates(redactSensitiveFields(jobs)),
      jobItems: serializeDates(redactSensitiveFields(jobItems)),
    };
    if (containsSensitiveField(backup)) throw new Error('Web 迁移备份包含敏感字段');
    return backup;
  }

  static parseWebMigrationBackup(value: unknown): WebLibraryMigrationBackup {
    return validateWebMigrationBackup(value);
  }

  static parseBackup(value: unknown): ImportLibraryBackup {
    return validateBackup(value);
  }

  static parseJson(value: string): ImportLibraryBackup {
    try {
      return validateBackup(JSON.parse(value) as unknown);
    } catch (error) {
      if (error instanceof Error && error.message === '导入备份格式无效') throw error;
      throw new Error('导入备份格式无效');
    }
  }

  /** Replace the given IndexedDB stores with the backup's rows in one transaction. */
  private static async replaceStores(
    stores: readonly LibraryStoreName[],
    entries: Array<[storeName: LibraryStoreName, values: unknown[]]>,
  ): Promise<void> {
    const db = await getDB();
    const tx = db.transaction([...stores], 'readwrite');
    await Promise.all(stores.map((storeName) => tx.objectStore(storeName).clear()));
    await Promise.all(
      entries.flatMap(([storeName, values]) => values.map((value) => tx.objectStore(storeName).put(value as never))),
    );
    await tx.done;
    clearChapterContentCache();
  }

  static async restoreWebMigrationBackup(value: unknown): Promise<void> {
    const backup = validateWebMigrationBackup(deserializeDates(value));
    await this.replaceStores(WEB_LIBRARY_STORE_NAMES, [
      ['books', backup.books],
      ['chapter-contents', backup.chapterContents],
      ['memories', backup.memories],
      ['cover-history', backup.coverHistory],
      ['import-jobs', backup.jobs],
      ['import-job-items', backup.jobItems],
    ]);
  }

  static async restoreBackup(value: unknown): Promise<void> {
    const backup = validateBackup(value);
    await this.replaceStores(LIBRARY_STORE_NAMES, [
      ['books', backup.books],
      ['chapter-contents', backup.chapterContents],
      ['import-jobs', backup.jobs],
      ['import-job-items', backup.jobItems],
    ]);
  }
}
