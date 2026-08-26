import { isElectron } from 'src/utils/platform';
import type { Novel, Paragraph } from 'src/models/novel';
import { WebLibraryApi, type BookRecord } from 'src/services/web-library-api';
import { deserializeDates, serializeDates } from 'src/utils/serialize-dates';

/**
 * Browser-side book storage adapter.
 *
 * Delegates reads/writes to the same-origin backend so the Pinia book store
 * and services can operate without IndexedDB in the browser build. Dates are
 * serialized/deserialized at the boundary.
 */
const WebBookService = {
  async getAllBooks(): Promise<Novel[]> {
    const records = await WebLibraryApi.listBooks();
    return records.items.map((record) => deserializeDates(record.book));
  },

  async getBook(id: string): Promise<Novel | undefined> {
    const record = await WebLibraryApi.getBook(id);
    return deserializeDates(record.book);
  },

  async saveBook(book: Novel): Promise<BookRecord> {
    const serialized = serializeDates(book);
    const existing = await WebLibraryApi.getBook(book.id).catch(() => undefined);
    if (existing) {
      return WebLibraryApi.updateBook(book.id, {
        book: serialized,
        expectedRevision: existing.revision,
      });
    }
    return WebLibraryApi.createBook({ book: serialized });
  },

  async bulkSaveBooks(books: Novel[]): Promise<BookRecord[]> {
    const results: BookRecord[] = [];
    for (const book of books) {
      results.push(await this.saveBook(book));
    }
    return results;
  },

  async deleteBook(id: string): Promise<void> {
    const existing = await WebLibraryApi.getBook(id).catch(() => undefined);
    if (!existing) return;
    await WebLibraryApi.deleteBook(id, existing.revision);
  },

  async clearBooks(): Promise<void> {
    const records = await WebLibraryApi.listBooks();
    await Promise.all(records.items.map((record) => WebLibraryApi.deleteBook(record.id, record.revision)));
  },

  async loadChapterContent(chapterId: string): Promise<Paragraph[] | undefined> {
    // WebLibraryApi.getChapterContent requires bookId+chapterId; the local
    // ChapterContentService uses chapterId only. In browser mode we store a
    // tiny chapterId→bookId map in a side index maintained by saveChapterContent.
    const index = getWebChapterIndex();
    const bookId = index.get(chapterId);
    if (!bookId) return undefined;
    const record = await WebLibraryApi.getChapterContent(bookId, chapterId);
    return record.paragraphs as Paragraph[];
  },

  async saveChapterContent(chapterId: string, content: Paragraph[], bookId: string): Promise<void> {
    const existing = await WebLibraryApi.getChapterContent(bookId, chapterId).catch(() => undefined);
    await WebLibraryApi.updateChapterContent(bookId, chapterId, {
      paragraphs: content,
      expectedRevision: existing?.revision ?? 0,
    });
    updateWebChapterIndex(chapterId, bookId);
  },

  async deleteChapterContent(chapterId: string): Promise<void> {
    const index = getWebChapterIndex();
    const bookId = index.get(chapterId);
    if (!bookId) return;
    // Backend does not support delete; overwrite with empty content.
    await WebLibraryApi.updateChapterContent(bookId, chapterId, {
      paragraphs: [],
      expectedRevision: 0,
    });
    index.delete(chapterId);
    setWebChapterIndex(index);
  },

  async bulkDeleteChapterContent(chapterIds: string[]): Promise<void> {
    await Promise.all(chapterIds.map((id) => this.deleteChapterContent(id)));
  },
};

const WEB_CHAPTER_INDEX_KEY = 'tsukuyomi-web-chapter-index';

function getWebChapterIndex(): Map<string, string> {
  if (typeof localStorage === 'undefined') return new Map();
  const raw = localStorage.getItem(WEB_CHAPTER_INDEX_KEY);
  if (!raw) return new Map();
  try {
    const entries = JSON.parse(raw) as [string, string][];
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function updateWebChapterIndex(chapterId: string, bookId: string): void {
  const index = getWebChapterIndex();
  index.set(chapterId, bookId);
  localStorage.setItem(WEB_CHAPTER_INDEX_KEY, JSON.stringify([...index]));
}

function setWebChapterIndex(index: Map<string, string>): void {
  localStorage.setItem(WEB_CHAPTER_INDEX_KEY, JSON.stringify([...index]));
}

export { WebBookService };
