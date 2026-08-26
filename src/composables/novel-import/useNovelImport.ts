import { inject, provide, type InjectionKey } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import { ImportJobService } from 'src/services/importer/import-job-service';
import { isElectron } from 'src/utils/platform';
import {
  applyImportJob,
  createNovelImportContext,
  isActiveImportStatus,
  type NovelImportContext,
  type NovelImportState,
  type NovelImportStep,
} from './createNovelImportContext';

export type { NovelImportContext, NovelImportStep } from './createNovelImportContext';

const NOVEL_IMPORT_KEY: InjectionKey<NovelImportContext> = Symbol('novel-import');
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollJob(jobId: string, state: NovelImportState): Promise<void> {
  const latest = await ImportJobService.getImportJob(jobId);
  if (!latest) return;
  applyImportJob(state, latest);
  state.items.value = await ImportJobService.listImportJobItems(jobId);
}

async function followJob(jobId: string, state: NovelImportState): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await pollJob(jobId, state);
    const status = state.job.value?.status;
    if (status && !isActiveImportStatus(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const startedAt = Date.now();
  pollTimer = setInterval(() => {
    void pollJob(jobId, state);
    if (Date.now() - startedAt > 60_000) stopPolling();
  }, 500);
}

export function provideNovelImport(): NovelImportContext {
  const ctx = createNovelImportContext({
    isAvailable: isElectron,
    createJob: (request) => ImportJobService.createImportJob(request),
    followJob,
    retryJob: (jobId) => ImportJobService.retryFailedItems(jobId),
    cancelJob: (jobId) => ImportJobService.cancelImportJob(jobId),
    stopFollowing: stopPolling,
    randomUUID: uuidv4,
  });
  provide(NOVEL_IMPORT_KEY, ctx);
  return ctx;
}

export function injectNovelImport(): NovelImportContext {
  const ctx = inject(NOVEL_IMPORT_KEY);
  if (!ctx) throw new Error('injectNovelImport() called outside a provider');
  return ctx;
}
