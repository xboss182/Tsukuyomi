import './setup';
import { describe, expect, it } from 'bun:test';
import { getDB } from 'src/utils/indexed-db';
import { ImportLibraryBackupService } from 'src/services/importer/import-library-backup-service';
import { ChapterContentService } from 'src/services/chapter-content-service';
import type { ImportJob, ImportJobItem } from 'src/services/importer/types';
import type { Novel } from 'src/models/novel';

const book: Novel = {
  id: 'book-1',
  title: '测试书籍',
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
  lastEdited: new Date('2026-08-24T00:00:00.000Z'),
};

const job: ImportJob = {
  id: 'job-1',
  idempotencyKey: 'request-1',
  mode: 'import',
  inputUrl: 'https://kakuyomu.jp/works/1234567890123456789',
  sourceKey: 'kakuyomu',
  remoteWorkId: '1234567890123456789',
  canonicalWorkUrl: 'https://kakuyomu.jp/works/1234567890123456789',
  sourceWorkKey: 'kakuyomu:1234567890123456789',
  status: 'completed',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  completedAt: '2026-08-24T00:00:00.000Z',
  counts: { total: 1, completed: 1, failed: 0, cancelled: 0 },
  bodyBytes: 12,
};

const item: ImportJobItem = {
  id: 'job-1:episode-1',
  jobId: 'job-1',
  sourceKey: 'kakuyomu',
  remoteWorkId: '1234567890123456789',
  remoteChapterId: 'episode-1',
  jobStatusKey: 'job-1:completed',
  sourceChapterKey: 'kakuyomu:1234567890123456789:episode-1',
  canonicalChapterUrl: 'https://kakuyomu.jp/works/1234567890123456789/episodes/episode-1',
  title: '第一章',
  remoteVolumeId: 'main',
  remoteVolumeTitle: '正文',
  sequence: 0,
  status: 'completed',
  attempts: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  contentHash: 'sha256:fixture',
};

describe('ImportLibraryBackupService', () => {
  it('round-trips the library, chapter bodies, and both import job stores', async () => {
    const db = await getDB();
    await db.put('books', book);
    await db.put('chapter-contents', {
      chapterId: 'chapter-1',
      content: '[{"id":"p1","text":"正文","selectedTranslationId":"","translations":[]}]',
      lastModified: '2026-08-24T00:00:00.000Z',
    });
    await db.put('import-jobs', job);
    await db.put('import-job-items', item);

    const backup = await ImportLibraryBackupService.createBackup();
    expect(backup.version).toBe(1);
    expect(backup.books).toEqual([book]);
    expect(backup.chapterContents).toHaveLength(1);
    expect(backup.jobs).toEqual([job]);
    expect(backup.jobItems).toEqual([item]);

    await db.clear('books');
    await db.clear('chapter-contents');
    await db.clear('import-jobs');
    await db.clear('import-job-items');

    await ImportLibraryBackupService.restoreBackup(backup);

    expect(await db.get('books', book.id)).toEqual(book);
    expect(await db.get('chapter-contents', 'chapter-1')).toEqual(backup.chapterContents[0]);
    expect(await db.get('import-jobs', job.id)).toEqual(job);
    expect(await db.get('import-job-items', item.id)).toEqual(item);
  });

  it('rejects malformed input before clearing existing data', async () => {
    const db = await getDB();
    await db.put('import-jobs', job);

    await (expect(
      ImportLibraryBackupService.restoreBackup({
        version: 1,
        exportedAt: 'not-a-date',
        books: [],
        chapterContents: [],
        jobs: [],
        jobItems: [],
      }),
    ).rejects.toThrow('导入备份格式无效') as unknown as Promise<void>);

    expect(await db.get('import-jobs', job.id)).toEqual(job);
  });

  it('invalidates cached chapter bodies after restore', async () => {
    const db = await getDB();
    await db.put('chapter-contents', {
      chapterId: 'chapter-1',
      content: '[{"id":"old","text":"旧正文","selectedTranslationId":"","translations":[]}]',
      lastModified: '2026-08-24T00:00:00.000Z',
    });
    expect((await ChapterContentService.loadChapterContent('chapter-1'))?.[0]?.text).toBe('旧正文');

    await ImportLibraryBackupService.restoreBackup({
      version: 1,
      exportedAt: '2026-08-24T01:00:00.000Z',
      books: [],
      chapterContents: [
        {
          chapterId: 'chapter-1',
          content: '[{"id":"new","text":"新正文","selectedTranslationId":"","translations":[]}]',
          lastModified: '2026-08-24T01:00:00.000Z',
        },
      ],
      jobs: [],
      jobItems: [],
    });

    expect((await ChapterContentService.loadChapterContent('chapter-1'))?.[0]?.text).toBe('新正文');
  });

  it('round-trips the safe desktop web-migration backup without settings secrets', async () => {
    const db = await getDB();
    await db.put(
      'books',
      {
        ...book,
        volumes: [
          {
            id: 'volume-1',
            title: '正文',
            chapters: [
              {
                id: 'chapter-1',
                title: '第一章',
                createdAt: new Date('2026-08-24T00:00:00.000Z'),
                lastEdited: new Date('2026-08-24T00:00:00.000Z'),
              },
            ],
          },
        ],
        defaultAIModel: {
          translation: { authorizationHeader: 'fixture-authorization-header' },
        },
      } as unknown as Novel,
    );
    await db.put('chapter-contents', {
      chapterId: 'chapter-1',
      content: '[{"id":"p1","text":"正文","selectedTranslationId":"","translations":[]}]',
      lastModified: '2026-08-24T00:00:00.000Z',
    });
    await db.put('memories', {
      id: 'memory-1',
      bookId: book.id,
      content: 'Memory content',
      summary: 'Memory summary',
      createdAt: 1,
      lastAccessedAt: 2,
    });
    await db.put('cover-history', {
      id: 'cover-1',
      url: 'https://example.test/cover.jpg',
      addedAt: new Date('2026-08-24T00:00:00.000Z'),
    });

    const backup = await ImportLibraryBackupService.createWebMigrationBackup();
    const exported = JSON.parse(JSON.stringify(backup)) as {
      books: Array<{ createdAt?: unknown }>;
      coverHistory: Array<{ addedAt?: unknown }>;
    };
    expect(backup).toMatchObject({ version: 2, kind: 'web-library-backup-v2' });
    expect(JSON.stringify(backup)).not.toContain('apiKey');
    expect(JSON.stringify(backup)).not.toContain('fixture-authorization-header');
    expect(exported.books[0]?.createdAt).toBe('2026-08-24T00:00:00.000Z');
    expect(exported.coverHistory[0]?.addedAt).toBe('2026-08-24T00:00:00.000Z');
    expect(backup.memories).toHaveLength(1);
    expect(backup.coverHistory).toHaveLength(1);

    await db.clear('books');
    await db.clear('chapter-contents');
    await db.clear('memories');
    await db.clear('cover-history');
    await ImportLibraryBackupService.restoreWebMigrationBackup(exported);

    expect((await db.get('books', book.id))?.createdAt).toBeInstanceOf(Date);
    expect(await db.get('memories', 'memory-1')).toMatchObject({ content: 'Memory content' });
    expect(await db.get('cover-history', 'cover-1')).toMatchObject({ url: 'https://example.test/cover.jpg' });
  });
});
