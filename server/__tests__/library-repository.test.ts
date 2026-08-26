import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryRepository, RepositoryError } from '../library-repository';
import { openDatabase } from '../database';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-library-'));
  paths.push(directory);
  return new LibraryRepository(openDatabase(join(directory, 'app.sqlite3')));
}

const book = {
  id: 'book-1',
  title: 'Fixture book',
  volumes: [
    {
      id: 'volume-1',
      title: 'Volume 1',
      chapters: [
        {
          id: 'chapter-1',
          title: 'Chapter 1',
          createdAt: '2026-08-26T00:00:00.000Z',
          lastEdited: '2026-08-26T00:00:00.000Z',
        },
      ],
    },
  ],
  createdAt: '2026-08-26T00:00:00.000Z',
  lastEdited: '2026-08-26T00:00:00.000Z',
};

describe('LibraryRepository', () => {
  it('keeps chapter bodies separate from metadata and rejects stale writes', async () => {
    const repository = await createRepository();
    const created = repository.createBook(book);

    expect(created.revision).toBe(1);
    const createdBookId = created.book.id as string;
    const persisted = repository.getBook(createdBookId)?.book;
    const volumes = Array.isArray(persisted?.volumes) ? persisted.volumes : [];
    const firstVolume = volumes[0] as { chapters?: Array<Record<string, unknown>> } | undefined;
    expect(firstVolume?.chapters?.[0]).not.toHaveProperty('content');

    const content = repository.putChapterContent('book-1', 'chapter-1', [
      { id: 'paragraph-1', text: '正文', selectedTranslationId: '', translations: [] },
    ], 0);
    expect(content.revision).toBe(1);
    expect(repository.getChapterContent('book-1', 'chapter-1')?.paragraphs).toHaveLength(1);

    expect(() => repository.updateBook('book-1', book, 0)).toThrow(RepositoryError);
    expect(() => repository.getChapterContent('different-book', 'chapter-1')).toThrow(RepositoryError);
  });

  it('validates a complete backup before atomically replacing the library', async () => {
    const repository = await createRepository();
    repository.createBook(book);
    const backup = repository.createBackup();

    expect(() => repository.restoreBackup({ ...backup, books: [{ id: 'broken' }] }, 'REPLACE_LIBRARY')).toThrow(
      RepositoryError,
    );
    expect(repository.getBook('book-1')?.book.title).toBe('Fixture book');

    repository.restoreBackup(backup, 'REPLACE_LIBRARY');
    expect(repository.getBook('book-1')?.revision).toBe(1);
  });

  it('imports a safe desktop web-library backup with chapter bodies', async () => {
    const repository = await createRepository();
    repository.restoreBackup(
      {
        version: 2,
        kind: 'web-library-backup-v2',
        exportedAt: '2026-08-26T00:00:00.000Z',
        books: [book],
        chapterContents: [
          {
            chapterId: 'chapter-1',
            content: JSON.stringify([
              { id: 'paragraph-1', text: '正文', selectedTranslationId: '', translations: [] },
            ]),
            lastModified: '2026-08-26T00:00:00.000Z',
          },
        ],
        memories: [],
        coverHistory: [],
        jobs: [],
        jobItems: [],
      },
      'REPLACE_LIBRARY',
    );

    expect(repository.getChapterContent('book-1', 'chapter-1')?.paragraphs).toMatchObject([{ text: '正文' }]);
  });

  it('keeps book-owned memories revisioned and rejects cross-book access', async () => {
    const repository = await createRepository();
    repository.createBook(book);
    const created = repository.createMemory('book-1', {
      id: 'memory-1',
      bookId: 'book-1',
      content: 'Fixture memory',
      summary: 'Fixture summary',
      createdAt: 1,
      lastAccessedAt: 2,
    });

    expect(created).toMatchObject({ memory: { bookId: 'book-1', content: 'Fixture memory' }, revision: 1 });
    expect(repository.listMemories('book-1')).toHaveLength(1);
    const updated = repository.updateMemory(
      'book-1',
      'memory-1',
      { ...created.memory, content: 'Updated memory', lastAccessedAt: 3 },
      1,
    );
    expect(updated).toMatchObject({ memory: { content: 'Updated memory' }, revision: 2 });
    expect(() => repository.getMemory('different-book', 'memory-1')).toThrow(RepositoryError);
    expect(() => repository.deleteMemory('book-1', 'memory-1', 1)).toThrow(RepositoryError);
    repository.deleteMemory('book-1', 'memory-1', 2);
    expect(repository.listMemories('book-1')).toEqual([]);
  });

  it('retains source identities while redacting embedded credential fields', async () => {
    const repository = await createRepository();
    const created = repository.createBook({
      ...book,
      id: 'source-book',
      source: {
        sourceKey: 'kakuyomu',
        remoteWorkId: '822139842947212336',
        canonicalWorkUrl: 'https://kakuyomu.jp/works/822139842947212336',
        lastCheckedAt: '2026-08-26T00:00:00.000Z',
      },
      defaultAIModel: {
        translation: { apiKey: 'secret', id: 'model' },
      },
    });

    expect(created.book.source).toMatchObject({ sourceKey: 'kakuyomu', remoteWorkId: '822139842947212336' });
    expect(JSON.stringify(created.book)).not.toContain('secret');
  });
});
