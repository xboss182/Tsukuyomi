import { isElectron } from 'src/utils/platform';
import { BookService as ElectronBookService } from 'src/services/book-service-indexeddb';
import { WebBookService } from 'src/services/web-book-service';
import type { Novel, Paragraph } from 'src/models/novel';

/**
 * Runtime-agnostic book storage.
 *
 * Electron builds persist books in IndexedDB via `book-service-indexeddb`;
 * browser builds delegate to the same-origin WebLibraryApi backend. Domain
 * code and tests import this module as before.
 */
export class BookService {
  static async getAllBooks(): Promise<Novel[]> {
    return isElectron() ? ElectronBookService.getAllBooks() : WebBookService.getAllBooks();
  }

  static async getBookById(id: string, loadContent = false): Promise<Novel | undefined> {
    if (isElectron()) {
      return ElectronBookService.getBookById(id, loadContent);
    }
    return WebBookService.getBook(id);
  }

  static async saveBook(
    book: Novel,
    options?: { saveChapterContent?: boolean },
  ): Promise<void> {
    if (isElectron()) {
      await ElectronBookService.saveBook(book, options);
      return;
    }
    await WebBookService.saveBook(book);
  }

  static async bulkSaveBooks(books: Novel[]): Promise<void> {
    if (isElectron()) {
      await ElectronBookService.bulkSaveBooks(books);
      return;
    }
    await WebBookService.bulkSaveBooks(books);
  }

  static async deleteBook(id: string): Promise<void> {
    if (isElectron()) {
      await ElectronBookService.deleteBook(id);
      return;
    }
    await WebBookService.deleteBook(id);
  }

  static async clearBooks(): Promise<void> {
    if (isElectron()) {
      await ElectronBookService.clearBooks();
      return;
    }
    await WebBookService.clearBooks();
  }

  static async loadChapterContent(chapterId: string): Promise<Paragraph[] | undefined> {
    return isElectron()
      ? (await import('src/services/chapter-content-service')).ChapterContentService.loadChapterContent(chapterId)
      : WebBookService.loadChapterContent(chapterId);
  }

  static async saveChapterContent(
    chapterId: string,
    content: Paragraph[],
    bookId: string,
  ): Promise<void> {
    if (isElectron()) {
      await (
        await import('src/services/chapter-content-service')
      ).ChapterContentService.saveChapterContent(chapterId, content, { bookId });
      return;
    }
    await WebBookService.saveChapterContent(chapterId, content, bookId);
  }
}
