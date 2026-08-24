import type {
  ImportedChapterContent,
  ImportJob,
  ImportJobItem,
  ImportLibraryBackup,
} from 'src/models/importer';
import { getDB } from 'src/utils/indexed-db';

const LIBRARY_STORE_NAMES = [
  'books',
  'chapter-contents',
  'import-jobs',
  'import-job-items',
] as const;

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

  static async restoreBackup(value: unknown): Promise<void> {
    const backup = validateBackup(value);
    const db = await getDB();
    const tx = db.transaction(LIBRARY_STORE_NAMES, 'readwrite');

    await Promise.all(LIBRARY_STORE_NAMES.map((storeName) => tx.objectStore(storeName).clear()));
    await Promise.all([
      ...backup.books.map((book) => tx.objectStore('books').put(book)),
      ...backup.chapterContents.map((content) => tx.objectStore('chapter-contents').put(content)),
      ...backup.jobs.map((job) => tx.objectStore('import-jobs').put(job)),
      ...backup.jobItems.map((item) => tx.objectStore('import-job-items').put(item)),
    ]);
    await tx.done;
  }
}
