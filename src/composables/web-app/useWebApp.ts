import { ref, computed, watch, onMounted, onUnmounted, provide, inject, type InjectionKey, type Ref } from 'vue';
import { WebLibraryApi } from 'src/services/web-library-api';
import type { ImportJob, ImportJobItem, CreateImportJobRequest, SourceKey } from 'src/models/importer';
import { SourceRegistry } from 'src/services/importer/source-registry';
import type { BookRecord, Paginated } from 'src/services/web-library-api';
import { connectImportJobSSE, type SseConnection } from 'src/services/web-sse-client';
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

export type WebNovelImportStep =
  | 'idle'
  | 'unsupported'
  | 'private_use_ack'
  | 'preview'
  | 'queued'
  | 'discovering'
  | 'fetching'
  | 'applying'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export interface WebNovelImportContext {
  url: Ref<string>;
  step: Ref<WebNovelImportStep>;
  job: Ref<ImportJob | null>;
  snapshot: Ref<import('src/models/importer').RemoteWorkSnapshot | null>;
  items: Ref<ImportJobItem[]>;
  error: Ref<{ code: string; message: string } | null>;
  privateUseAcknowledged: Ref<boolean>;
  progress: Ref<{ completed: number; total: number; failed: number }>;
  selectedChapters: Ref<Set<string>>;
  canPreview: import('vue').ComputedRef<boolean>;
  canImport: import('vue').ComputedRef<boolean>;
  isBusy: import('vue').ComputedRef<boolean>;
  detectedSource: import('vue').ComputedRef<{ sourceKey: string; label: string } | null>;
  sourceLabel: import('vue').ComputedRef<string>;
  needsPrivateUseAck: import('vue').ComputedRef<boolean>;
  setUrl: (value: string) => void;
  acknowledgePrivateUse: () => void;
  preview: () => Promise<void>;
  confirmImport: () => Promise<void>;
  refresh: () => Promise<void>;
  retryFailed: () => Promise<void>;
  cancel: () => Promise<void>;
  toggleChapter: (remoteChapterId: string) => void;
  selectAllChapters: () => void;
  clear: () => void;
}

const WEB_NOVEL_IMPORT_KEY: InjectionKey<WebNovelImportContext> = Symbol('web-novel-import');

export function provideWebNovelImport(): WebNovelImportContext {
  const ctx = createWebNovelImportContext();
  provide(WEB_NOVEL_IMPORT_KEY, ctx);
  return ctx;
}

export function injectWebNovelImport(): WebNovelImportContext | null {
  return inject(WEB_NOVEL_IMPORT_KEY, null);
}

const sourceLabels: Record<SourceKey, string> = {
  kakuyomu: 'Kakuyomu',
  'narou-metadata': 'Narou (メタデータ)',
  nobadnovel: 'NoBadNovel',
  freewebnovel: 'FreeWebNovel',
  novellunar: 'NovelLunar',
};

function isActiveStatus(status: ImportJob['status']): boolean {
  return ['queued', 'discovering', 'fetching', 'applying'].includes(status);
}

function stepFromJob(job: ImportJob | null): WebNovelImportStep {
  if (!job) return 'idle';
  return job.status as WebNovelImportStep;
}

function createWebNovelImportContext(): WebNovelImportContext {
  const url = ref('');
  const step = ref<WebNovelImportStep>('idle');
  const job = ref<ImportJob | null>(null);
  const snapshot = ref<ImportJob['snapshot'] | null>(null);
  const items = ref<ImportJobItem[]>([]);
  const error = ref<{ code: string; message: string } | null>(null);
  const privateUseAcknowledged = ref(false);
  const selectedChapters = ref<Set<string>>(new Set());
  let sseConnection: SseConnection | null = null;

  const detectedSource = computed(() => {
    const identity = SourceRegistry.detect(url.value);
    return identity ? { sourceKey: identity.sourceKey, label: sourceLabels[identity.sourceKey] } : null;
  });
  const sourceLabel = computed(() => detectedSource.value?.label ?? '');
  const needsPrivateUseAck = computed(() => detectedSource.value?.sourceKey === 'kakuyomu');

  const isBusy = computed(() => {
    if (step.value === 'idle' || step.value === 'unsupported') return false;
    return isActiveStatus(job.value?.status ?? 'completed') || step.value === 'preview';
  });

  const canPreview = computed(() => {
    const source = detectedSource.value;
    if (!source) return false;
    if (source.sourceKey === 'kakuyomu' && !privateUseAcknowledged.value) return false;
    return !isBusy.value;
  });

  const canImport = computed(() => {
    if (!snapshot.value || selectedChapters.value.size === 0) return false;
    return step.value === 'preview' || step.value === 'completed' || step.value === 'completed_with_errors';
  });

  const progress = computed(() => {
    if (!job.value) return { completed: 0, total: 0, failed: 0 };
    return {
      completed: job.value.counts.completed,
      total: job.value.counts.total,
      failed: job.value.counts.failed,
    };
  });

  function disconnectSSE(): void {
    if (sseConnection) {
      sseConnection.close();
      sseConnection = null;
    }
  }

  async function syncJobState(jobId: string): Promise<void> {
    const latest = await WebLibraryApi.getImportJob(jobId);
    job.value = latest;
    if (latest.snapshot) snapshot.value = latest.snapshot;
    step.value = stepFromJob(latest);
    if (latest.status === 'failed' && latest.error) {
      error.value = { code: latest.error.code, message: latest.error.message };
    }
  }

  function subscribeToJob(jobId: string): void {
    disconnectSSE();
    sseConnection = connectImportJobSSE(
      jobId,
      (event) => {
        if (event.name === 'snapshot') {
          const payload = event.data as { job: ImportJob } | ImportJob;
          const nextJob = 'job' in (payload as Record<string, unknown>) ? (payload as { job: ImportJob }).job : (payload as ImportJob);
          job.value = nextJob;
          if (nextJob.snapshot) snapshot.value = nextJob.snapshot;
          step.value = stepFromJob(nextJob);
        } else if (event.name === 'job') {
          const nextJob = event.data as ImportJob;
          job.value = nextJob;
          if (nextJob.snapshot) snapshot.value = nextJob.snapshot;
          step.value = stepFromJob(nextJob);
          if (nextJob.status === 'failed' && nextJob.error) {
            error.value = { code: nextJob.error.code, message: nextJob.error.message };
          }
        } else if (event.name === 'item') {
          const item = event.data as ImportJobItem;
          const index = items.value.findIndex((i) => i.id === item.id);
          if (index >= 0) {
            items.value[index] = item;
          } else {
            items.value.push(item);
          }
        } else if (event.name === 'terminal') {
          const nextJob = event.data as ImportJob;
          job.value = nextJob;
          if (nextJob.snapshot) snapshot.value = nextJob.snapshot;
          step.value = stepFromJob(nextJob);
          disconnectSSE();
        } else if (event.name === 'reset') {
          const payload = event.data as { job: ImportJob };
          job.value = payload.job;
          if (payload.job.snapshot) snapshot.value = payload.job.snapshot;
          items.value = [];
        } else if (event.name === 'session-expired') {
          disconnectSSE();
        }
      },
      {
        onError: (err) => {
          console.error('[WebNovelImport] SSE error:', err);
        },
      },
    );
  }

  function setUrl(value: string): void {
    url.value = value;
    error.value = null;
    if (step.value !== 'idle' && step.value !== 'unsupported') {
      clear();
    }
    step.value = detectedSource.value ? 'idle' : value ? 'unsupported' : 'idle';
  }

  function acknowledgePrivateUse(): void {
    privateUseAcknowledged.value = true;
  }

  async function startPreviewOrImport(mode: 'preview' | 'import'): Promise<void> {
    if (!url.value) return;
    const existingSnapshot = mode === 'import' ? snapshot.value : null;
    const existingSelection = mode === 'import' ? Array.from(selectedChapters.value) : [];
    step.value = mode === 'preview' ? 'preview' : 'queued';
    error.value = null;
    snapshot.value = null;
    items.value = [];
    selectedChapters.value.clear();

    try {
      const request: CreateImportJobRequest = {
        url: url.value,
        mode,
        idempotencyKey: crypto.randomUUID(),
        privateUseAcknowledged: needsPrivateUseAck.value ? privateUseAcknowledged.value : undefined,
        selectedRemoteChapterIds: Array.from(selectedChapters.value),
      };
      const created = await WebLibraryApi.createImportJob(request);
      job.value = created;
      subscribeToJob(created.id);
      if (mode === 'import' && job.value?.status === 'queued' && existingSnapshot) {
        snapshot.value = existingSnapshot;
        selectedChapters.value = new Set(existingSelection);
      }
    } catch (err) {
      const importError = err instanceof Error ? err : { code: 'unknown', message: '导入失败' };
      error.value = { code: 'unknown', message: importError.message };
      step.value = 'failed';
    }
  }

  async function preview(): Promise<void> {
    await startPreviewOrImport('preview');
  }

  async function confirmImport(): Promise<void> {
    await startPreviewOrImport('import');
  }

  async function refresh(): Promise<void> {
    if (!snapshot.value) return;
    await startPreviewOrImport('import');
  }

  async function retryFailed(): Promise<void> {
    if (!job.value) return;
    try {
      const retry = await WebLibraryApi.retryFailedImportJob(job.value.id);
      job.value = retry;
      selectedChapters.value = new Set();
      error.value = null;
      subscribeToJob(retry.id);
    } catch (err) {
      const importError = err instanceof Error ? err : { code: 'unknown', message: '重试失败' };
      error.value = { code: 'unknown', message: importError.message };
    }
  }

  async function cancel(): Promise<void> {
    if (!job.value) return;
    await WebLibraryApi.cancelImportJob(job.value.id);
    await syncJobState(job.value.id);
  }

  function toggleChapter(remoteChapterId: string): void {
    const next = new Set(selectedChapters.value);
    if (next.has(remoteChapterId)) next.delete(remoteChapterId);
    else next.add(remoteChapterId);
    selectedChapters.value = next;
  }

  function selectAllChapters(): void {
    const all = new Set(snapshot.value?.chapters.map((chapter) => chapter.remoteChapterId) ?? []);
    selectedChapters.value = all;
  }

  function clear(): void {
    disconnectSSE();
    url.value = '';
    step.value = 'idle';
    job.value = null;
    snapshot.value = null;
    items.value = [];
    error.value = null;
    privateUseAcknowledged.value = false;
    selectedChapters.value.clear();
  }

  watch(
    () => snapshot.value?.chapters,
    (chapters) => {
      if (!chapters) return;
      selectedChapters.value = new Set(chapters.map((chapter) => chapter.remoteChapterId));
    },
    { once: true },
  );

  return {
    url,
    step,
    job,
    snapshot,
    items,
    error,
    privateUseAcknowledged,
    progress,
    selectedChapters,
    canPreview,
    canImport,
    isBusy,
    detectedSource,
    sourceLabel,
    needsPrivateUseAck,
    setUrl,
    acknowledgePrivateUse,
    preview,
    confirmImport,
    refresh,
    retryFailed,
    cancel,
    toggleChapter,
    selectAllChapters,
    clear,
  };
}
