import { ref, computed, watch, inject, provide, type InjectionKey, type Ref } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import { ImportJobService } from 'src/services/importer/import-job-service';
import type {
  CreateImportJobRequest,
  ImportJob,
  ImportJobItem,
  ImportJobStatus,
  RemoteChapterStub,
  RemoteWorkSnapshot,
  SourceKey,
} from 'src/models/importer';
import { SourceRegistry } from 'src/services/importer/source-registry';
import { isElectron } from 'src/utils/platform';

export type NovelImportStep =
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

export interface ChapterSelection {
  remoteChapterId: string;
  selected: boolean;
}

export interface NovelImportContext {
  url: Ref<string>;
  step: Ref<NovelImportStep>;
  job: Ref<ImportJob | null>;
  snapshot: Ref<RemoteWorkSnapshot | null>;
  items: Ref<ImportJobItem[]>;
  error: Ref<{ code: string; message: string } | null>;
  privateUseAcknowledged: Ref<boolean>;
  progress: Ref<{ completed: number; total: number; failed: number }>;
  selectedChapters: Ref<Set<string>>;
  canPreview: Ref<boolean>;
  canImport: Ref<boolean>;
  isBusy: Ref<boolean>;
  detectedSource: Ref<{ sourceKey: SourceKey; label: string } | null>;
  sourceLabel: Ref<string>;
  needsPrivateUseAck: Ref<boolean>;

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

const NOVEL_IMPORT_KEY: InjectionKey<NovelImportContext> = Symbol('novel-import');

const sourceLabels: Record<SourceKey, string> = {
  kakuyomu: 'Kakuyomu',
  'narou-metadata': 'Narou (メタデータ)',
  nobadnovel: 'NoBadNovel',
  freewebnovel: 'FreeWebNovel',
  novellunar: 'NovelLunar',
};

function isActiveStatus(status: ImportJobStatus): boolean {
  return ['queued', 'discovering', 'fetching', 'applying'].includes(status);
}

function stepFromJob(job: ImportJob | null): NovelImportStep {
  if (!job) return 'idle';
  return isActiveStatus(job.status)
    ? (job.status as NovelImportStep)
    : (job.status as NovelImportStep);
}

function detectSource(url: string): { sourceKey: SourceKey; label: string } | null {
  const identity = SourceRegistry.detect(url);
  return identity ? { sourceKey: identity.sourceKey, label: sourceLabels[identity.sourceKey] } : null;
}

export function provideNovelImport(): NovelImportContext {
  const ctx = createNovelImportContext();
  provide(NOVEL_IMPORT_KEY, ctx);
  return ctx;
}

export function injectNovelImport(): NovelImportContext {
  const ctx = inject(NOVEL_IMPORT_KEY);
  if (!ctx) throw new Error('injectNovelImport() called outside a provider');
  return ctx;
}

function createNovelImportContext(): NovelImportContext {
  const url = ref('');
  const step = ref<NovelImportStep>('idle');
  const job = ref<ImportJob | null>(null);
  const snapshot = ref<RemoteWorkSnapshot | null>(null);
  const items = ref<ImportJobItem[]>([]);
  const error = ref<{ code: string; message: string } | null>(null);
  const privateUseAcknowledged = ref(false);
  const selectedChapters = ref<Set<string>>(new Set());
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollStartAt = 0;

  const detectedSource = computed(() => detectSource(url.value));
  const sourceLabel = computed(() => detectedSource.value?.label ?? '');
  const needsPrivateUseAck = computed(() => detectedSource.value?.sourceKey === 'kakuyomu');

  const canPreview = computed(() => {
    if (!isElectron()) return false;
    const source = detectedSource.value;
    if (!source) return false;
    if (source.sourceKey === 'kakuyomu' && !privateUseAcknowledged.value) return false;
    return !isBusy.value;
  });

  const isBusy = computed(() => {
    if (step.value === 'idle' || step.value === 'unsupported') return false;
    return isActiveStatus(job.value?.status ?? 'completed') || step.value === 'preview';
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

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleSnapshot(jobId: string): void {
    stopPolling();
    pollStartAt = Date.now();
    pollTimer = setInterval(() => {
      void pollJob(jobId);
      if (Date.now() - pollStartAt > 60_000) {
        stopPolling();
      }
    }, 500);
  }

  async function pollJob(jobId: string): Promise<void> {
    const latest = await ImportJobService.getImportJob(jobId);
    if (!latest) return;
    job.value = latest;
    if (latest.snapshot) snapshot.value = latest.snapshot;
    items.value = await ImportJobService.listImportJobItems(jobId);
    step.value = stepFromJob(latest);
    if (latest.status === 'failed' && latest.error) {
      error.value = { code: latest.error.code, message: latest.error.message };
    }
    if (!isActiveStatus(latest.status)) {
      stopPolling();
    }
  }

  function setUrl(value: string): void {
    url.value = value;
    error.value = null;
    if (step.value !== 'idle' && step.value !== 'unsupported') {
      clear();
    }
    step.value = detectSource(value) ? 'idle' : value ? 'unsupported' : 'idle';
  }

  function acknowledgePrivateUse(): void {
    privateUseAcknowledged.value = true;
  }

  async function pollUntilIdle(jobId: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      await pollJob(jobId);
      const status = job.value?.status;
      if (status && !isActiveStatus(status)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function startPreviewOrImport(mode: 'preview' | 'import'): Promise<void> {
    if (!isElectron()) {
      error.value = { code: 'electron_unavailable', message: '导入仅在桌面版可用' };
      step.value = 'failed';
      return;
    }
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
        idempotencyKey: uuidv4(),
        privateUseAcknowledged: needsPrivateUseAck.value ? privateUseAcknowledged.value : undefined,
        selectedRemoteChapterIds:
          mode === 'import' ? Array.from(selectedChapters.value) : undefined,
      };
      const created = await ImportJobService.createImportJob(request);
      job.value = created;
      await pollUntilIdle(created.id);
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
      const retry = await ImportJobService.retryFailedItems(job.value.id);
      job.value = retry;
      selectedChapters.value = new Set();
      error.value = null;
      scheduleSnapshot(retry.id);
      await pollJob(retry.id);
    } catch (err) {
      const importError = err instanceof Error ? err : { code: 'unknown', message: '重试失败' };
      error.value = { code: 'unknown', message: importError.message };
    }
  }

  async function cancel(): Promise<void> {
    if (!job.value) return;
    await ImportJobService.cancelImportJob(job.value.id);
    await pollJob(job.value.id);
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
    stopPolling();
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
