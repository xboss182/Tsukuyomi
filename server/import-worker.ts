import type { ImportError, ImportFetchRequest, ImportFetchResult, ImportJob } from '../src/models/importer';
import { asImportError, SourceRegistry, StructuredImportError } from '../src/services/importer/source-registry';
import { discoveryFetchRequest } from '../src/services/importer/import-job-service';
import { performImportFetch } from '../src/services/importer/import-fetch';
import type { ImportJobRepository } from './import-repository';

const MAX_FETCH_ATTEMPTS = 3;

type Clock = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export type ServerImportWorkerOptions = {
  fetch?: (request: ImportFetchRequest) => Promise<ImportFetchResult>;
  clock?: Clock;
};

const systemClock: Clock = {
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function importError(code: ImportError['code'], message: string, retryable = false): ImportError {
  return { code, message, retryable };
}

export class ServerImportWorker {
  private readonly fetchImportResource: (request: ImportFetchRequest) => Promise<ImportFetchResult>;
  private readonly clock: Clock;
  private readonly lastRequestStartedAt = new Map<string, number>();
  private running: Promise<void> | null = null;
  private stopping = false;
  private paused = false;

  constructor(
    private readonly jobs: ImportJobRepository,
    options: ServerImportWorkerOptions = {},
  ) {
    this.fetchImportResource = options.fetch ?? performImportFetch;
    this.clock = options.clock ?? systemClock;
  }

  start(): Promise<void> {
    this.jobs.cleanupExpiredEvents();
    this.jobs.recoverInterruptedJobs();
    this.wake();
    return Promise.resolve();
  }

  wake(): void {
    if (this.stopping || this.paused || this.running) return;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  async waitForIdle(): Promise<void> {
    await this.running;
  }

  async beginShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.running;
  }

  resume(): void {
    this.paused = false;
    this.wake();
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private async run(): Promise<void> {
    while (!this.stopping && !this.paused) {
      const job = this.jobs.nextQueued();
      if (!job) return;
      await this.runJob(job);
    }
  }

  private async runJob(initial: ImportJob): Promise<void> {
    if (initial.cancellationRequested) {
      this.jobs.finalize(initial.id, true);
      return;
    }

    try {
      const source = {
        sourceKey: initial.sourceKey,
        remoteWorkId: initial.remoteWorkId,
        canonicalWorkUrl: initial.canonicalWorkUrl,
      };
      this.jobs.setJobStatus(initial.id, { status: 'discovering' });
      const discovery = await this.fetchWithRetries(discoveryFetchRequest(initial, source));
      if (!discovery.ok) throw new StructuredImportError(discovery.error);

      const adapter = SourceRegistry.get(source.sourceKey);
      const snapshot = adapter.discover(source, discovery.response.body, this.now());
      const discovered = this.jobs.applySnapshot(initial.id, snapshot, discovery.response.byteLength, discovery.costMicros ?? 0);
      if (discovered.cancellationRequested) {
        this.jobs.finalize(initial.id, true);
        return;
      }
      // ponytail: preserve the durable active state for startup recovery rather
      // than adding another shutdown queue; upgrade for multi-process workers.
      if (this.stopping || this.paused) return;
      if (discovered.mode === 'preview' || snapshot.metadataOnly) {
        this.jobs.finalize(initial.id, false);
        return;
      }

      const items = this.jobs.createItems(initial.id, snapshot);
      if (this.stopping || this.paused) return;
      if (items.length === 0) {
        this.jobs.finalize(initial.id, false);
        return;
      }
      for (const item of items) {
        const latest = this.jobs.get(initial.id);
        if (!latest || latest.cancellationRequested || this.stopping || this.paused) break;
        await this.processItem(latest, item.id, snapshot);
      }
      const final = this.jobs.get(initial.id);
      if (this.stopping || this.paused) return;
      this.jobs.finalize(initial.id, final?.cancellationRequested === true);
    } catch (error) {
      this.failOrCancel(initial.id, error);
    }
  }

  /** Cancel if requested, otherwise mark failed — shared terminal handling for job errors. */
  private failOrCancel(jobId: string, error: unknown): void {
    const latest = this.jobs.get(jobId);
    if (latest?.cancellationRequested) {
      this.jobs.finalize(jobId, true);
      return;
    }
    if (this.stopping || this.paused) return;
    this.jobs.setJobStatus(jobId, {
      status: 'failed',
      error: asImportError(error),
      completedAt: this.now(),
    });
  }

  private async processItem(job: ImportJob, itemId: string, snapshot: NonNullable<ImportJob['snapshot']>): Promise<void> {
    const item = this.jobs.listItems(job.id).find((candidate) => candidate.id === itemId);
    if (!item) return;
    const remote = snapshot.chapters.find((chapter) => chapter.remoteChapterId === item.remoteChapterId);
    if (!remote) {
      this.jobs.markItemFailed(job.id, item.id, importError('parse_failed', '目录中缺少章节'));
      return;
    }
    const adapter = SourceRegistry.get(job.sourceKey);
    if (!adapter.parseChapter) {
      this.jobs.markItemFailed(job.id, item.id, importError('policy_disallowed', '该来源不允许导入章节正文'));
      return;
    }
    const response = await this.fetchWithRetries(
      {
        sourceKey: job.sourceKey,
        kind: 'chapter',
        url: SourceRegistry.chapterUrl(remote),
        jobId: job.id,
        maxProviderCostMicros: job.maxProviderCostMicros,
        providerCostMicrosUsed: job.providerCostMicrosUsed,
      },
      (attempt) => {
        this.jobs.setItemFetching(job.id, item.id, attempt);
      },
    );
    if (!response.ok) {
      this.jobs.markItemFailed(job.id, item.id, response.error);
      return;
    }
    const latest = this.jobs.get(job.id);
    if (!latest || latest.cancellationRequested || this.stopping || this.paused) return;
    try {
      const body = await adapter.parseChapter(remote, response.response.body);
      this.jobs.applyChapter(job.id, item.id, remote, body, response.response.byteLength, response.costMicros ?? 0);
    } catch (error) {
      this.jobs.markItemFailed(job.id, item.id, asImportError(error));
    }
  }

  private async fetchWithRetries(
    request: ImportFetchRequest,
    onAttempt?: (attempt: number) => void,
  ): Promise<ImportFetchResult> {
    const adapter = SourceRegistry.get(request.sourceKey);
    let latest: ImportError = importError('network_error', '导入请求失败', true);
    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
      onAttempt?.(attempt);
      await this.waitForSourceSlot(adapter.key, adapter.minimumSpacingMs);
      const result = await this.fetchImportResource(request);
      if (result.ok) return result;
      latest = result.error;
      if (!latest.retryable || attempt === MAX_FETCH_ATTEMPTS) break;
      const backoff = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      await this.clock.sleep(latest.retryAfterMs ?? backoff);
    }
    return { ok: false, error: latest };
  }

  private async waitForSourceSlot(sourceKey: string, minimumSpacingMs: number): Promise<void> {
    const previous = this.lastRequestStartedAt.get(sourceKey) ?? 0;
    const delay = Math.max(0, minimumSpacingMs - (this.clock.now() - previous));
    if (delay > 0) await this.clock.sleep(delay);
    this.lastRequestStartedAt.set(sourceKey, this.clock.now());
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
