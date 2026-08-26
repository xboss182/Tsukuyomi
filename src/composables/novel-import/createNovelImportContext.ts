import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type {
  CreateImportJobRequest,
  ImportJob,
  ImportJobItem,
  RemoteWorkSnapshot,
  SourceKey,
} from 'src/models/importer';
import { SourceRegistry } from 'src/services/importer/source-registry';

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

export interface NovelImportContext {
  url: Ref<string>;
  step: Ref<NovelImportStep>;
  job: Ref<ImportJob | null>;
  snapshot: Ref<RemoteWorkSnapshot | null>;
  items: Ref<ImportJobItem[]>;
  error: Ref<{ code: string; message: string } | null>;
  privateUseAcknowledged: Ref<boolean>;
  progress: ComputedRef<{ completed: number; total: number; failed: number }>;
  selectedChapters: Ref<Set<string>>;
  canPreview: ComputedRef<boolean>;
  canImport: ComputedRef<boolean>;
  isBusy: ComputedRef<boolean>;
  detectedSource: ComputedRef<{ sourceKey: SourceKey; label: string } | null>;
  sourceLabel: ComputedRef<string>;
  needsPrivateUseAck: ComputedRef<boolean>;
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

interface NovelImportAdapter {
  isAvailable?: () => boolean;
  createJob: (request: CreateImportJobRequest) => Promise<ImportJob>;
  followJob: (jobId: string, state: NovelImportState) => Promise<void>;
  retryJob: (jobId: string) => Promise<ImportJob>;
  cancelJob: (jobId: string) => Promise<unknown>;
  stopFollowing: () => void;
  randomUUID: () => string;
}

export interface NovelImportState {
  job: Ref<ImportJob | null>;
  snapshot: Ref<RemoteWorkSnapshot | null>;
  items: Ref<ImportJobItem[]>;
  error: Ref<{ code: string; message: string } | null>;
  step: Ref<NovelImportStep>;
}

const sourceLabels: Record<SourceKey, string> = {
  kakuyomu: 'Kakuyomu',
  'narou-metadata': 'Narou (メタデータ)',
  nobadnovel: 'NoBadNovel',
  freewebnovel: 'FreeWebNovel',
  novellunar: 'NovelLunar',
};

export function isActiveImportStatus(status: ImportJob['status']): boolean {
  return ['queued', 'discovering', 'fetching', 'applying'].includes(status);
}

export function applyImportJob(state: NovelImportState, nextJob: ImportJob): void {
  state.job.value = nextJob;
  if (nextJob.snapshot) state.snapshot.value = nextJob.snapshot;
  state.step.value = nextJob.status as NovelImportStep;
  if (nextJob.status === 'failed' && nextJob.error) {
    state.error.value = { code: nextJob.error.code, message: nextJob.error.message };
  }
}

export function createNovelImportContext(adapter: NovelImportAdapter): NovelImportContext {
  const url = ref('');
  const step = ref<NovelImportStep>('idle');
  const job = ref<ImportJob | null>(null);
  const snapshot = ref<RemoteWorkSnapshot | null>(null);
  const items = ref<ImportJobItem[]>([]);
  const error = ref<{ code: string; message: string } | null>(null);
  const privateUseAcknowledged = ref(false);
  const selectedChapters = ref<Set<string>>(new Set());
  const state = { job, snapshot, items, error, step };

  const detectedSource = computed(() => {
    const identity = SourceRegistry.detect(url.value);
    return identity
      ? { sourceKey: identity.sourceKey, label: sourceLabels[identity.sourceKey] }
      : null;
  });
  const sourceLabel = computed(() => detectedSource.value?.label ?? '');
  const needsPrivateUseAck = computed(() => detectedSource.value?.sourceKey === 'kakuyomu');
  const isBusy = computed(() => {
    if (step.value === 'idle' || step.value === 'unsupported') return false;
    return isActiveImportStatus(job.value?.status ?? 'completed') || step.value === 'preview';
  });
  const canPreview = computed(() => {
    if (adapter.isAvailable && !adapter.isAvailable()) return false;
    const source = detectedSource.value;
    if (!source) return false;
    if (source.sourceKey === 'kakuyomu' && !privateUseAcknowledged.value) return false;
    return !isBusy.value;
  });
  const canImport = computed(() => {
    if (!snapshot.value || selectedChapters.value.size === 0) return false;
    return ['preview', 'completed', 'completed_with_errors'].includes(step.value);
  });
  const progress = computed(() =>
    job.value ? { ...job.value.counts } : { completed: 0, total: 0, failed: 0 },
  );

  function clear(): void {
    adapter.stopFollowing();
    url.value = '';
    step.value = 'idle';
    job.value = null;
    snapshot.value = null;
    items.value = [];
    error.value = null;
    privateUseAcknowledged.value = false;
    selectedChapters.value.clear();
  }

  function setUrl(value: string): void {
    if (step.value !== 'idle' && step.value !== 'unsupported') clear();
    url.value = value;
    error.value = null;
    step.value = detectedSource.value ? 'idle' : value ? 'unsupported' : 'idle';
  }

  async function start(mode: 'preview' | 'import'): Promise<void> {
    if (adapter.isAvailable && !adapter.isAvailable()) {
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
    try {
      const created = await adapter.createJob({
        url: url.value,
        mode,
        idempotencyKey: adapter.randomUUID(),
        privateUseAcknowledged: needsPrivateUseAck.value ? privateUseAcknowledged.value : undefined,
        selectedRemoteChapterIds: mode === 'import' ? existingSelection : undefined,
      });
      job.value = created;
      await adapter.followJob(created.id, state);
      if (mode === 'import' && job.value?.status === 'queued' && existingSnapshot) {
        snapshot.value = existingSnapshot;
        selectedChapters.value = new Set(existingSelection);
      }
    } catch (err) {
      error.value = { code: 'unknown', message: err instanceof Error ? err.message : '导入失败' };
      step.value = 'failed';
    }
  }

  async function retryFailed(): Promise<void> {
    if (!job.value) return;
    try {
      const retry = await adapter.retryJob(job.value.id);
      job.value = retry;
      selectedChapters.value = new Set();
      error.value = null;
      await adapter.followJob(retry.id, state);
    } catch (err) {
      error.value = { code: 'unknown', message: err instanceof Error ? err.message : '重试失败' };
    }
  }

  watch(
    () => snapshot.value?.chapters,
    (chapters) => {
      if (chapters)
        selectedChapters.value = new Set(chapters.map(({ remoteChapterId }) => remoteChapterId));
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
    acknowledgePrivateUse: () => {
      privateUseAcknowledged.value = true;
    },
    preview: () => start('preview'),
    confirmImport: () => start('import'),
    refresh: async () => {
      if (snapshot.value) await start('import');
    },
    retryFailed,
    cancel: async () => {
      if (job.value) {
        await adapter.cancelJob(job.value.id);
        await adapter.followJob(job.value.id, state);
      }
    },
    toggleChapter: (id) => {
      const next = new Set(selectedChapters.value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selectedChapters.value = next;
    },
    selectAllChapters: () => {
      selectedChapters.value = new Set(
        snapshot.value?.chapters.map(({ remoteChapterId }) => remoteChapterId) ?? [],
      );
    },
    clear,
  };
}
