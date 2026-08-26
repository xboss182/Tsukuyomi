import {
  ref,
  computed,
  onMounted,
  onUnmounted,
  provide,
  inject,
  type InjectionKey,
  type Ref,
} from 'vue';
import { WebLibraryApi } from 'src/services/web-library-api';
import type { ImportJob, ImportJobItem } from 'src/models/importer';
import type { BookRecord, Paginated } from 'src/services/web-library-api';
import { connectImportJobSSE, type SseConnection } from 'src/services/web-sse-client';
import {
  applyImportJob,
  createNovelImportContext,
  type NovelImportContext,
  type NovelImportState,
} from 'src/composables/novel-import/createNovelImportContext';
import { setWebClientSessionExpiredHandler } from 'src/services/web-client';

export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';

export interface WebAuthContext {
  state: Ref<AuthState>;
  isAuthenticated: Ref<boolean>;
  isLoading: Ref<boolean>;
  error: Ref<string | null>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const WEB_AUTH_KEY: InjectionKey<WebAuthContext> = Symbol('web-auth');

export function provideWebAuth(): WebAuthContext {
  const ctx = createWebAuthContext();
  provide(WEB_AUTH_KEY, ctx);
  return ctx;
}

export function injectWebAuth(): WebAuthContext | null {
  return inject(WEB_AUTH_KEY, null);
}

function createWebAuthContext(): WebAuthContext {
  const state = ref<AuthState>('unknown');
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  async function checkSession(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const result = await WebLibraryApi.session();
      state.value = result.authenticated ? 'authenticated' : 'unauthenticated';
      if (!result.authenticated) {
        error.value = null;
      }
    } catch {
      state.value = 'unauthenticated';
      error.value = null;
    }
  }

  async function login(password: string): Promise<void> {
    if (!password) {
      error.value = '请输入密码';
      return;
    }
    isLoading.value = true;
    error.value = null;
    try {
      await WebLibraryApi.login({ password });
      await checkSession();
    } catch (err) {
      state.value = 'unauthenticated';
      error.value = err instanceof Error ? err.message : '登录失败';
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await WebLibraryApi.logout();
    } finally {
      state.value = 'unauthenticated';
      error.value = null;
    }
  }

  onMounted(() => {
    setWebClientSessionExpiredHandler(() => {
      state.value = 'unauthenticated';
      error.value = '会话已过期，请重新登录';
    });
    void checkSession();
  });

  onUnmounted(() => {
    setWebClientSessionExpiredHandler(null);
  });

  return {
    state,
    isAuthenticated: computed(() => state.value === 'authenticated'),
    isLoading,
    error,
    login,
    logout,
  };
}

export interface WebLibraryContext {
  books: Ref<BookRecord[]>;
  jobs: Ref<ImportJob[]>;
  isLoadingBooks: Ref<boolean>;
  isLoadingJobs: Ref<boolean>;
  loadBooks: () => Promise<void>;
  loadJobs: () => Promise<void>;
  refresh: () => Promise<void>;
}

const WEB_LIBRARY_KEY: InjectionKey<WebLibraryContext> = Symbol('web-library');

export function provideWebLibrary(): WebLibraryContext {
  const ctx = createWebLibraryContext();
  provide(WEB_LIBRARY_KEY, ctx);
  return ctx;
}

export function injectWebLibrary(): WebLibraryContext | null {
  return inject(WEB_LIBRARY_KEY, null);
}

function createWebLibraryContext(): WebLibraryContext {
  const books = ref<BookRecord[]>([]);
  const jobs = ref<ImportJob[]>([]);
  const isLoadingBooks = ref(false);
  const isLoadingJobs = ref(false);

  async function loadBooks(): Promise<void> {
    if (isLoadingBooks.value) return;
    isLoadingBooks.value = true;
    try {
      let cursor: string | undefined;
      const all: BookRecord[] = [];
      do {
        const page: Paginated<BookRecord> = await WebLibraryApi.listBooks(cursor);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      books.value = all;
    } finally {
      isLoadingBooks.value = false;
    }
  }

  async function loadJobs(): Promise<void> {
    if (isLoadingJobs.value) return;
    isLoadingJobs.value = true;
    try {
      let cursor: string | undefined;
      const all: ImportJob[] = [];
      do {
        const page: Paginated<ImportJob> = await WebLibraryApi.listImportJobs(cursor);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      jobs.value = all;
    } finally {
      isLoadingJobs.value = false;
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadBooks(), loadJobs()]);
  }

  return {
    books,
    jobs,
    isLoadingBooks,
    isLoadingJobs,
    loadBooks,
    loadJobs,
    refresh,
  };
}

export type WebNovelImportContext = NovelImportContext;

const WEB_NOVEL_IMPORT_KEY: InjectionKey<WebNovelImportContext> = Symbol('web-novel-import');
let sseConnection: SseConnection | null = null;

function disconnectSSE(): void {
  sseConnection?.close();
  sseConnection = null;
}

async function syncJobState(jobId: string, state: NovelImportState): Promise<void> {
  applyImportJob(state, await WebLibraryApi.getImportJob(jobId));
}

function subscribeToJob(jobId: string, state: NovelImportState): Promise<void> {
  disconnectSSE();
  sseConnection = connectImportJobSSE(
    jobId,
    (event) => {
      if (event.name === 'snapshot') {
        const payload = event.data as { job: ImportJob } | ImportJob;
        applyImportJob(state, 'job' in payload ? payload.job : payload);
      } else if (event.name === 'job' || event.name === 'terminal') {
        applyImportJob(state, event.data as ImportJob);
        if (event.name === 'terminal') disconnectSSE();
      } else if (event.name === 'item') {
        const item = event.data as ImportJobItem;
        const index = state.items.value.findIndex(({ id }) => id === item.id);
        if (index >= 0) state.items.value[index] = item;
        else state.items.value.push(item);
      } else if (event.name === 'reset') {
        applyImportJob(state, (event.data as { job: ImportJob }).job);
        state.items.value = [];
      } else if (event.name === 'session-expired') {
        disconnectSSE();
      }
    },
    { onError: (err) => console.error('[WebNovelImport] SSE error:', err) },
  );
  return Promise.resolve();
}

export function createWebNovelImportContext(): WebNovelImportContext {
  sseConnection = null;
  return createNovelImportContext({
    createJob: (request) => WebLibraryApi.createImportJob(request),
    followJob: subscribeToJob,
    retryJob: (jobId) => WebLibraryApi.retryFailedImportJob(jobId),
    cancelJob: (jobId) => WebLibraryApi.cancelImportJob(jobId),
    stopFollowing: disconnectSSE,
    randomUUID: () => crypto.randomUUID(),
  });
}

export function provideWebNovelImport(): WebNovelImportContext {
  const ctx = createWebNovelImportContext();
  provide(WEB_NOVEL_IMPORT_KEY, ctx);
  return ctx;
}

export function injectWebNovelImport(): WebNovelImportContext | null {
  return inject(WEB_NOVEL_IMPORT_KEY, null);
}
