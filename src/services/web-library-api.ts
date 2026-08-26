import type { ImportJob, ImportJobItem, CreateImportJobRequest } from 'src/models/importer';
import type { Novel } from 'src/models/novel';
import type { ApiResult } from 'src/services/web-client';

export type Paginated<T> = {
  items: T[];
  nextCursor?: string;
};

export type BookRecord = {
  id: string;
  book: Novel;
  revision: number;
};

export type ChapterContentRecord = {
  chapterId: string;
  paragraphs: unknown[];
  lastModified: string;
  revision: number;
};

export type CreateBookRequest = {
  book: Novel;
  clientId?: string;
};

export type UpdateBookRequest = {
  book: Novel;
  expectedRevision: number;
};

export type UpdateChapterContentRequest = {
  paragraphs: unknown[];
  expectedRevision: number;
};

export type SessionResponse = {
  authenticated: boolean;
  expiresAt?: string;
};

export type LoginRequest = {
  password: string;
};

export type ChangePasswordRequest = {
  currentPassword: string;
  newPassword: string;
};

export type RestoreLibraryRequest = {
  backup: unknown;
  confirmation: 'REPLACE_LIBRARY';
};

/**
 * Same-origin HTTP API for the browser build.
 *
 * All paths are prefixed with `/api/v1`. The WebClient injects the CSRF header
 * and emits session-expiry events on 401/403.
 */
export const WebLibraryApi = {
  session(): Promise<SessionResponse> {
    return WebClient.get('/api/v1/auth/session');
  },

  login(request: LoginRequest): Promise<void> {
    return WebClient.post('/api/v1/auth/login', request);
  },

  logout(): Promise<void> {
    return WebClient.post('/api/v1/auth/logout');
  },

  changePassword(request: ChangePasswordRequest): Promise<void> {
    return WebClient.post('/api/v1/auth/password', request);
  },

  listBooks(cursor?: string): Promise<Paginated<BookRecord>> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return WebClient.get(`/api/v1/library/books${query}`);
  },

  createBook(request: CreateBookRequest): Promise<BookRecord> {
    return WebClient.post('/api/v1/library/books', request);
  },

  getBook(bookId: string): Promise<BookRecord> {
    return WebClient.get(`/api/v1/library/books/${encodeURIComponent(bookId)}`);
  },

  updateBook(bookId: string, request: UpdateBookRequest): Promise<BookRecord> {
    return WebClient.put(`/api/v1/library/books/${encodeURIComponent(bookId)}`, request);
  },

  deleteBook(bookId: string, expectedRevision: number): Promise<void> {
    return WebClient.delete(`/api/v1/library/books/${encodeURIComponent(bookId)}`, {
      expectedRevision,
    });
  },

  getChapterContent(bookId: string, chapterId: string): Promise<ChapterContentRecord> {
    return WebClient.get(
      `/api/v1/library/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}/content`,
    );
  },

  updateChapterContent(
    bookId: string,
    chapterId: string,
    request: UpdateChapterContentRequest,
  ): Promise<ChapterContentRecord> {
    return WebClient.put(
      `/api/v1/library/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}/content`,
      request,
    );
  },

  listImportJobs(cursor?: string): Promise<Paginated<ImportJob>> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return WebClient.get(`/api/v1/import-jobs${query}`);
  },

  createImportJob(request: CreateImportJobRequest): Promise<ImportJob> {
    return WebClient.post('/api/v1/import-jobs', request);
  },

  getImportJob(jobId: string): Promise<ImportJob> {
    return WebClient.get(`/api/v1/import-jobs/${encodeURIComponent(jobId)}`);
  },

  listImportJobItems(jobId: string): Promise<ImportJobItem[]> {
    return WebClient.get(`/api/v1/import-jobs/${encodeURIComponent(jobId)}/items`);
  },

  cancelImportJob(jobId: string): Promise<ImportJob> {
    return WebClient.post(`/api/v1/import-jobs/${encodeURIComponent(jobId)}/cancel`);
  },

  retryFailedImportJob(jobId: string): Promise<ImportJob> {
    return WebClient.post(`/api/v1/import-jobs/${encodeURIComponent(jobId)}/retry-failed`);
  },

  downloadLibraryBackup(): Promise<Blob> {
    return fetch('/api/v1/library/backup', { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) throw new Error('Backup download failed');
      return response.blob();
    });
  },

  restoreLibraryBackup(request: RestoreLibraryRequest): Promise<void> {
    return WebClient.post('/api/v1/library/restore', request);
  },
};

// Avoid a circular import: WebClient is imported lazily where needed, but for
// the typed API surface we reference it directly. This import must remain last
// so that the module exports above are defined before the import executes.
import { WebClient } from 'src/services/web-client';
