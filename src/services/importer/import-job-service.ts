import type { Chapter, Novel, Paragraph, Volume } from 'src/models/novel';
import type {
  CreateImportJobRequest,
  ImportError,
  ImportFetchRequest,
  ImportFetchResult,
  ImportJob,
  ImportJobItem,
  RemoteChapterBody,
  RemoteChapterStub,
  RemoteWorkSnapshot,
  SourceIdentity,
  SourceWorkMetadata,
} from './types';
import { ACTIVE_IMPORT_JOB_STATUSES, INTERRUPTED_IMPORT_JOB_STATUSES } from './types';
import type { ImportQueueRuntimeStatus } from './import-diagnostics';
import { getDB } from 'src/utils/indexed-db';
import { generateShortId, UniqueIdGenerator } from 'src/utils/id-generator';
import { serializeDates } from 'src/utils/serialize-dates';
import { SourceRegistry, StructuredImportError, asImportError } from './source-registry';
import { ChapterContentService } from 'src/services/chapter-content-service';

const MAX_SUCCESSFUL_BODY_BYTES = 64 * 1024 * 1024;
const MAX_FETCH_ATTEMPTS = 3;

type ImportFetch = (request: ImportFetchRequest) => Promise<ImportFetchResult>;
type ImportClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const systemClock: ImportClock = {
  now: Date.now,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

async function performRendererFetch(request: ImportFetchRequest): Promise<ImportFetchResult> {
  if (typeof window === 'undefined' || !window.electronAPI?.importFetch) {
    return {
      ok: false,
      error: {
        code: 'electron_unavailable',
        message: '导入仅在桌面版可用',
        retryable: false,
      },
    };
  }
  const needsProvider =
    request.sourceKey === 'freewebnovel' ||
    (request.maxProviderCostMicros !== undefined && request.maxProviderCostMicros > 0);
  const channel =
    needsProvider && window.electronAPI.providerImportFetch
      ? window.electronAPI.providerImportFetch
      : window.electronAPI.importFetch;
  try {
    return await channel(request);
  } catch {
    return {
      ok: false,
      error: { code: 'network_error', message: '导入请求失败', retryable: true },
    };
  }
}

let fetchImportResource: ImportFetch = (request) => performRendererFetch(request);

let importClock = systemClock;
const lastRequestStartedAt = new Map<string, number>();
let workerRunning = false;
let workerPromise: Promise<void> | null = null;
let createJobTail: Promise<void> = Promise.resolve();
/** Graceful-shutdown drain: once set, no new jobs start and the active fetch completes. */
let shuttingDown = false;

function now(): string {
  return new Date(importClock.now()).toISOString();
}

function makeError(
  code: ImportError['code'],
  message: string,
  retryable = false,
): StructuredImportError {
  return new StructuredImportError({ code, message, retryable });
}

function jobId(): string {
  return `import-${generateShortId()}`;
}

function itemId(job: ImportJob, chapter: RemoteChapterStub): string {
  return `${job.id}:${chapter.remoteChapterId}`;
}

/** Build the durable per-chapter work item shared by the desktop and web importers. */
export function createQueuedImportItem(job: ImportJob, chapter: RemoteChapterStub, timestamp: string): ImportJobItem {
  return {
    id: itemId(job, chapter),
    jobId: job.id,
    sourceKey: chapter.sourceKey,
    remoteWorkId: chapter.remoteWorkId,
    remoteChapterId: chapter.remoteChapterId,
    jobStatusKey: `${job.id}:queued`,
    sourceChapterKey: SourceRegistry.sourceChapterKey(chapter),
    canonicalChapterUrl: chapter.canonicalChapterUrl,
    title: chapter.title,
    remoteVolumeId: chapter.volume.remoteVolumeId,
    remoteVolumeTitle: chapter.volume.title,
    sequence: chapter.sequence,
    ...(chapter.remoteUpdatedAt ? { remoteUpdatedAt: chapter.remoteUpdatedAt } : {}),
    status: 'queued',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Build the TOC/metadata discovery request shared by the desktop and web importers. */
export function discoveryFetchRequest(job: ImportJob, source: SourceIdentity): ImportFetchRequest {
  const adapter = SourceRegistry.get(source.sourceKey);
  return {
    sourceKey: source.sourceKey,
    kind: adapter.key === 'narou-metadata' ? 'metadata' : 'toc',
    url: SourceRegistry.getFetchUrl(source),
    jobId: job.id,
    maxProviderCostMicros: job.maxProviderCostMicros,
    providerCostMicrosUsed: job.providerCostMicrosUsed,
  };
}

function getSourceWorkKey(source: SourceIdentity): string {
  return SourceRegistry.sourceWorkKey(source);
}

function matchesSourceWork(source: Novel['source'] | Chapter['source'] | undefined, identity: SourceIdentity): boolean {
  return source?.sourceKey === identity.sourceKey && source.remoteWorkId === identity.remoteWorkId;
}

function findBookBySource(books: Novel[], identity: SourceIdentity): Novel | undefined {
  return books.find(
    (book) =>
      matchesSourceWork(book.source, identity) ||
      book.webUrl?.some((url) => SourceRegistry.matchesWorkUrl(url, identity)),
  );
}

function getChapterBySource(book: Novel, chapter: RemoteChapterStub): Chapter | undefined {
  for (const volume of book.volumes || []) {
    const found = volume.chapters?.find(
      (candidate) =>
        (matchesSourceWork(candidate.source, chapter) &&
          candidate.source?.remoteChapterId === chapter.remoteChapterId) ||
        (typeof candidate.webUrl === 'string' &&
          SourceRegistry.matchesChapterUrl(candidate.webUrl, chapter)),
    );
    if (found) return found;
  }
  return undefined;
}

function getSourceVolume(book: Novel, chapter: RemoteChapterStub): Volume | undefined {
  return (book.volumes || []).find(
    (volume) =>
      volume.source?.sourceKey === chapter.sourceKey &&
      volume.source?.remoteWorkId === chapter.remoteWorkId &&
      volume.source?.remoteVolumeId === chapter.volume.remoteVolumeId,
  );
}

/** Merge remote work metadata onto the durable source record shared by both importers. */
export function sourceWorkMetadata(snapshot: RemoteWorkSnapshot, checkedAt: string): SourceWorkMetadata {
  return {
    ...snapshot.source,
    lastCheckedAt: checkedAt,
    ...(snapshot.remoteUpdatedAt ? { remoteUpdatedAt: snapshot.remoteUpdatedAt } : {}),
    remoteTitle: snapshot.title,
    ...(snapshot.author ? { remoteAuthor: snapshot.author } : {}),
    ...(snapshot.description ? { remoteDescription: snapshot.description } : {}),
    ...(snapshot.tags ? { remoteTags: snapshot.tags } : {}),
  };
}

function createBook(snapshot: RemoteWorkSnapshot, checkedAt: string): Novel {
  const createdAt = new Date(checkedAt);
  return {
    id: `source-${generateShortId()}`,
    title: snapshot.title,
    ...(snapshot.author ? { author: snapshot.author } : {}),
    ...(snapshot.description ? { description: snapshot.description } : {}),
    ...(snapshot.tags ? { tags: snapshot.tags } : {}),
    webUrl: [snapshot.source.canonicalWorkUrl],
    source: sourceWorkMetadata(snapshot, checkedAt),
    volumes: [],
    createdAt,
    lastEdited: createdAt,
  };
}

function upsertBookSource(existing: Novel | undefined, snapshot: RemoteWorkSnapshot, checkedAt: string): Novel {
  if (!existing) return createBook(snapshot, checkedAt);
  const urls = existing.webUrl || [];
  return {
    ...existing,
    webUrl: urls.includes(snapshot.source.canonicalWorkUrl)
      ? urls
      : [...urls, snapshot.source.canonicalWorkUrl],
    source: sourceWorkMetadata(snapshot, checkedAt),
    lastEdited: new Date(checkedAt),
  };
}

function ensureSourceVolume(book: Novel, chapter: RemoteChapterStub): Volume {
  const existing = getSourceVolume(book, chapter);
  if (existing) return existing;

  const volume: Volume = {
    id: `source-volume-${generateShortId()}`,
    title: chapter.volume.title,
    chapters: [],
    source: {
      sourceKey: chapter.sourceKey,
      remoteWorkId: chapter.remoteWorkId,
      remoteVolumeId: chapter.volume.remoteVolumeId,
    },
  };
  book.volumes = [...(book.volumes || []), volume];
  return volume;
}

function parseStoredParagraphs(content: string | undefined): Paragraph[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as Paragraph[]) : [];
  } catch {
    return [];
  }
}

function preserveParagraphTranslations(previous: Paragraph[], texts: string[]): Paragraph[] {
  const byText = new Map<string, Paragraph[]>();
  for (const paragraph of previous) {
    const bucket = byText.get(paragraph.text) || [];
    bucket.push(paragraph);
    byText.set(paragraph.text, bucket);
  }
  const usedIds = previous.map((paragraph) => paragraph.id);
  const idGenerator = new UniqueIdGenerator(usedIds);

  return texts.map((text) => {
    const preserved = byText.get(text)?.shift();
    if (preserved) return { ...preserved, text };
    return {
      id: idGenerator.generate(),
      text,
      selectedTranslationId: '',
      translations: [],
    };
  });
}

function sourceChapterMetadata(
  chapter: RemoteChapterStub,
  body: RemoteChapterBody,
  fetchedAt: string,
) {
  return {
    sourceKey: chapter.sourceKey,
    remoteWorkId: chapter.remoteWorkId,
    canonicalWorkUrl: chapter.canonicalWorkUrl,
    remoteChapterId: chapter.remoteChapterId,
    canonicalChapterUrl: chapter.canonicalChapterUrl,
    remoteTitle: chapter.title,
    ...(chapter.remoteUpdatedAt ? { remoteUpdatedAt: chapter.remoteUpdatedAt } : {}),
    contentHash: body.contentHash,
    parserVersion: body.parserVersion,
    fetchedAt,
    sequence: chapter.sequence,
  };
}

function createChapter(
  chapter: RemoteChapterStub,
  body: RemoteChapterBody,
  fetchedAt: string,
): Chapter {
  const timestamp = new Date(fetchedAt);
  return {
    id: `source-chapter-${generateShortId()}`,
    title: chapter.title,
    webUrl: chapter.canonicalChapterUrl,
    source: sourceChapterMetadata(chapter, body, fetchedAt),
    content: preserveParagraphTranslations([], body.paragraphs),
    contentLoaded: true,
    createdAt: timestamp,
    lastEdited: timestamp,
  };
}

function updateChapter(
  existing: Chapter,
  chapter: RemoteChapterStub,
  body: RemoteChapterBody,
  previous: Paragraph[],
  fetchedAt: string,
): Chapter {
  const { originalContent: _rawRemoteHtml, ...safeExisting } = existing;
  return {
    ...safeExisting,
    webUrl: chapter.canonicalChapterUrl,
    source: sourceChapterMetadata(chapter, body, fetchedAt),
    content: preserveParagraphTranslations(previous, body.paragraphs),
    contentLoaded: true,
    lastEdited: new Date(fetchedAt),
  };
}

/** Keep known source chapters ordered by adapter sequence without deleting vanished remote chapters. */
function reconcileSourceOrder(book: Novel, snapshot: RemoteWorkSnapshot): void {
  const chapterByRemoteId = new Map<string, Chapter>();
  const remoteById = new Map(snapshot.chapters.map((chapter) => [chapter.remoteChapterId, chapter]));
  for (const volume of book.volumes || []) {
    for (const chapter of volume.chapters || []) {
      if (
        matchesSourceWork(chapter.source, snapshot.source) &&
        chapter.source?.remoteChapterId &&
        remoteById.has(chapter.source.remoteChapterId)
      ) {
        chapterByRemoteId.set(chapter.source.remoteChapterId, chapter);
      }
    }
  }

  for (const remoteVolume of snapshot.volumes) {
    const representative = snapshot.chapters.find(
      (chapter) => chapter.volume.remoteVolumeId === remoteVolume.remoteVolumeId,
    );
    if (!representative) continue;
    const target = ensureSourceVolume(book, representative);
    const managed = snapshot.chapters
      .filter((chapter) => chapter.volume.remoteVolumeId === remoteVolume.remoteVolumeId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((chapter) => chapterByRemoteId.get(chapter.remoteChapterId))
      .filter((chapter): chapter is Chapter => Boolean(chapter));
    const managedIds = new Set(managed.map((chapter) => chapter.id));

    for (const volume of book.volumes || []) {
      if (!volume.chapters) continue;
      volume.chapters = volume.chapters.filter((chapter) => !managedIds.has(chapter.id));
    }
    target.chapters = [...(target.chapters || []), ...managed];
  }
}

function stripBookContent(book: Novel): Novel {
  return {
    ...book,
    volumes: book.volumes?.map((volume) => ({
      ...volume,
      chapters: volume.chapters?.map((chapter) => {
        const { content, summary: _summary, ...withoutContent } = chapter as Chapter & { summary?: unknown };
        return { ...withoutContent, contentLoaded: content !== undefined };
      }),
    })),
  };
}

function updateItemStatus(item: ImportJobItem, status: ImportJobItem['status']): ImportJobItem {
  return { ...item, status, jobStatusKey: `${item.jobId}:${status}`, updatedAt: now() };
}

function notifyLibraryChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('tsukuyomi-import-library-changed'));
  }
}

async function waitForSourceSlot(sourceKey: string, minimumSpacingMs: number): Promise<void> {
  const previous = lastRequestStartedAt.get(sourceKey) || 0;
  const delay = Math.max(0, minimumSpacingMs - (importClock.now() - previous));
  if (delay > 0) await importClock.sleep(delay);
  lastRequestStartedAt.set(sourceKey, importClock.now());
}

async function fetchWithRetries(
  request: ImportFetchRequest,
  onAttempt?: (attempt: number) => Promise<void>,
): Promise<ImportFetchResult> {
  const adapter = SourceRegistry.get(request.sourceKey);
  const budget = request.maxProviderCostMicros ?? 0;
  const used = request.providerCostMicrosUsed ?? 0;
  let lastError: ImportError = makeError('unknown', '导入请求失败');
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    await onAttempt?.(attempt);
    await waitForSourceSlot(adapter.key, adapter.minimumSpacingMs);
    const budgetedRequest: ImportFetchRequest = {
      ...request,
      maxProviderCostMicros: budget,
      providerCostMicrosUsed: used,
    };
    const result = await fetchImportResource(budgetedRequest);
    if (result.ok) return result;
    lastError = result.error;
    if (!lastError.retryable || attempt === MAX_FETCH_ATTEMPTS) break;
    const ceiling = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    const backoff = Math.floor(Math.random() * ceiling);
    await importClock.sleep(lastError.retryAfterMs ?? backoff);
  }
  return { ok: false, error: lastError };
}

function scheduleNextImportJob(): void {
  if (shuttingDown) return;
  if (workerPromise) return;
  workerPromise = ImportJobService.runNextImportJob().finally(() => {
    workerPromise = null;
  });
}

async function acquireCreateJobLock(): Promise<() => void> {
  const previous = createJobTail;
  let release!: () => void;
  createJobTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

async function getItemsForJob(jobId: string): Promise<ImportJobItem[]> {
  const db = await getDB();
  return db.getAllFromIndex('import-job-items', 'by-jobId', jobId);
}

export class ImportJobService {
  static setClockForTesting(clock: ImportClock | null): void {
    importClock = clock ?? systemClock;
    lastRequestStartedAt.clear();
  }

  static setFetchForTesting(fetcher: ImportFetch | null): void {
    fetchImportResource = fetcher ?? ((request) => performRendererFetch(request));
    lastRequestStartedAt.clear();
  }

  /**
   * Graceful-shutdown drain. Once set, `scheduleNextImportJob` stops starting
   * new jobs. The currently running fetch completes and its result is
   * persisted before the process exits; recovery handles the rest on restart.
   * Returns the active worker promise so a caller can await drain completion.
   */
  static beginShutdown(): Promise<void> {
    shuttingDown = true;
    return workerPromise ?? Promise.resolve();
  }

  /**
   * Runtime readiness snapshot distinguishing runtime readiness from job
   * failures. `ready` is true when the worker is idle and recovery has run
   * with no interrupted jobs pending — individual job failures surface in
   * `failedJobs`, not in `ready`.
   */
  static async runtimeStatus(): Promise<ImportQueueRuntimeStatus> {
    const db = await getDB();
    const jobs = await db.getAll('import-jobs');
    const count = (predicate: (job: ImportJob) => boolean): number =>
      jobs.filter(predicate).length;
    return {
      ready: !workerRunning && !shuttingDown && count((job) => INTERRUPTED_IMPORT_JOB_STATUSES.has(job.status)) === 0,
      workerRunning,
      shuttingDown,
      activeJobs: count((job) => ACTIVE_IMPORT_JOB_STATUSES.has(job.status)),
      interruptedJobs: count((job) => INTERRUPTED_IMPORT_JOB_STATUSES.has(job.status)),
      failedJobs: count((job) => job.status === 'failed'),
      completedJobs: count((job) => job.status === 'completed' || job.status === 'completed_with_errors'),
      totalJobs: jobs.length,
    };
  }

  static async createImportJob(request: CreateImportJobRequest): Promise<ImportJob> {
    if (!request.idempotencyKey.trim()) {
      throw makeError('invalid_url', '缺少幂等键');
    }
    const source = SourceRegistry.detect(request.url);
    if (!source) throw makeError('unsupported_source', '不支持的来源 URL');
    if (source.sourceKey === 'kakuyomu' && request.privateUseAcknowledged !== true) {
      throw makeError('policy_disallowed', 'Kakuyomu 导入仅限已确认的个人使用');
    }

    const release = await acquireCreateJobLock();
    try {
      const db = await getDB();
      const existing = await db.getFromIndex(
        'import-jobs',
        'by-idempotencyKey',
        request.idempotencyKey,
      );
      if (existing) return existing;

      const active = (await db.getAllFromIndex(
        'import-jobs',
        'by-sourceWorkKey',
        getSourceWorkKey(source),
      )).find((job) => ACTIVE_IMPORT_JOB_STATUSES.has(job.status));
      if (active) return active;

      const timestamp = now();
      const job: ImportJob = {
        id: jobId(),
        idempotencyKey: request.idempotencyKey,
        mode: request.mode,
        inputUrl: request.url,
        sourceKey: source.sourceKey,
        remoteWorkId: source.remoteWorkId,
        canonicalWorkUrl: source.canonicalWorkUrl,
        sourceWorkKey: getSourceWorkKey(source),
        status: 'queued',
        counts: { total: 0, completed: 0, failed: 0, cancelled: 0 },
        bodyBytes: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(request.selectedRemoteChapterIds
          ? { selectedRemoteChapterIds: request.selectedRemoteChapterIds }
          : {}),
        ...(request.privateUseAcknowledged ? { privateUseAcknowledged: true } : {}),
        ...(request.maxProviderCostMicros !== undefined
          ? { maxProviderCostMicros: request.maxProviderCostMicros }
          : {}),
      };
      await db.add('import-jobs', job);
      scheduleNextImportJob();
      return job;
    } finally {
      release();
    }
  }

  static async getImportJob(id: string): Promise<ImportJob | undefined> {
    const db = await getDB();
    return db.get('import-jobs', id);
  }

  static async listImportJobs(): Promise<ImportJob[]> {
    const db = await getDB();
    const jobs = await db.getAll('import-jobs');
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  static async listImportJobItems(jobIdValue: string): Promise<ImportJobItem[]> {
    return getItemsForJob(jobIdValue);
  }

  static async cancelImportJob(id: string): Promise<ImportJob | undefined> {
    const db = await getDB();
    const job = await db.get('import-jobs', id);
    if (!job || !ACTIVE_IMPORT_JOB_STATUSES.has(job.status)) return job;

    const tx = db.transaction(['import-jobs', 'import-job-items'], 'readwrite');
    const latest = await tx.objectStore('import-jobs').get(id);
    if (!latest || !ACTIVE_IMPORT_JOB_STATUSES.has(latest.status)) {
      await tx.done;
      return latest;
    }
    const cancelled = {
      ...latest,
      cancellationRequested: true,
      ...(latest.status === 'queued' ? { status: 'cancelled' as const, completedAt: now() } : {}),
      updatedAt: now(),
    };
    if (latest.status === 'queued') {
      const items = await tx.objectStore('import-job-items').index('by-jobId').getAll(id);
      for (const item of items.filter((candidate) => candidate.status === 'queued')) {
        await tx.objectStore('import-job-items').put(updateItemStatus(item, 'cancelled'));
      }
    }
    await tx.objectStore('import-jobs').put(cancelled);
    await tx.done;
    return cancelled;
  }

  static async retryFailedItems(id: string): Promise<ImportJob> {
    const db = await getDB();
    const parent = await db.get('import-jobs', id);
    if (!parent) throw makeError('invalid_url', '导入任务不存在');
    const failed = (await getItemsForJob(id))
      .filter((item) => item.status === 'failed' && item.lastError?.retryable === true)
      .map((item) => item.remoteChapterId);
    if (failed.length === 0) throw makeError('invalid_url', '没有可重试的失败章节');

    const timestamp = now();
    const job: ImportJob = {
      ...parent,
      id: jobId(),
      idempotencyKey: `retry:${parent.id}:${timestamp}`,
      mode: 'retry_failed',
      status: 'queued',
      counts: { total: 0, completed: 0, failed: 0, cancelled: 0 },
      bodyBytes: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      retryOf: parent.id,
      selectedRemoteChapterIds: failed,
      cancellationRequested: false,
      completedAt: undefined,
      error: undefined,
      maxProviderCostMicros: parent.maxProviderCostMicros,
      providerCostMicrosUsed: parent.providerCostMicrosUsed,
    };
    await db.add('import-jobs', job);
    scheduleNextImportJob();
    return job;
  }

  static async recoverInterruptedJobs(): Promise<void> {
    const db = await getDB();
    const jobs = await db.getAll('import-jobs');
    const interrupted = jobs.filter((job) => INTERRUPTED_IMPORT_JOB_STATUSES.has(job.status));
    if (interrupted.length === 0) return;

    const tx = db.transaction('import-jobs', 'readwrite');
    for (const job of interrupted) {
      await tx.store.put({
        ...job,
        status: 'queued',
        cancellationRequested: false,
        updatedAt: now(),
      });
    }
    await tx.done;
  }

  static async start(): Promise<void> {
    await this.recoverInterruptedJobs();
    scheduleNextImportJob();
  }

  /** @internal Tests await the same serial worker that production schedules in the background. */
  static async waitForIdleForTesting(): Promise<void> {
    await workerPromise;
  }

  static async runNextImportJob(): Promise<void> {
    if (workerRunning) return;
    workerRunning = true;
    try {
      while (true) {
        const db = await getDB();
        const queued = (await db.getAllFromIndex('import-jobs', 'by-status', 'queued'))
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
        if (!queued) return;
        await this.runJob(queued.id);
      }
    } finally {
      workerRunning = false;
    }
  }

  private static async runJob(id: string): Promise<void> {
    const db = await getDB();
    const initial = await db.get('import-jobs', id);
    if (!initial || initial.status !== 'queued') return;

    if (initial.cancellationRequested) {
      await this.finalizeJob(initial.id, true);
      return;
    }

    try {
      const source: SourceIdentity = {
        sourceKey: initial.sourceKey,
        remoteWorkId: initial.remoteWorkId,
        canonicalWorkUrl: initial.canonicalWorkUrl,
      };
      await this.updateJob(initial.id, { status: 'discovering' });
      const adapter = SourceRegistry.get(source.sourceKey);
      const discovery = await fetchWithRetries(discoveryFetchRequest(initial, source));
      if (!discovery.ok) throw new StructuredImportError(discovery.error);

      const snapshot = adapter.discover(source, discovery.response.body, now());
      const discovered = await this.applySnapshot(initial.id, snapshot, discovery.response.byteLength, discovery as ImportFetchResult & { ok: true });
      if (discovered.cancellationRequested) {
        await this.finalizeJob(initial.id, true);
        return;
      }
      if (discovered.mode === 'preview' || snapshot.metadataOnly) {
        await this.finalizeJob(initial.id, false);
        return;
      }

      const items = await this.createItems(discovered, snapshot);
      if (items.length === 0) {
        await this.finalizeJob(initial.id, false);
        return;
      }

      for (const item of items) {
        const latest = await this.getImportJob(initial.id);
        if (!latest || latest.cancellationRequested) break;
        await this.processItem(latest, item, snapshot);
      }
      const latest = await this.getImportJob(initial.id);
      await this.finalizeJob(initial.id, latest?.cancellationRequested === true);
    } catch (error) {
      const importError = asImportError(error);
      const latest = await this.getImportJob(id);
      if (latest?.cancellationRequested) {
        await this.finalizeJob(id, true);
      } else {
        await this.updateJob(id, { status: 'failed', error: importError, completedAt: now() });
      }
    }
  }

  private static async applySnapshot(
    jobIdValue: string,
    snapshot: RemoteWorkSnapshot,
    bodyBytes: number,
    discovery: ImportFetchResult & { ok: true },
  ): Promise<ImportJob> {
    const db = await getDB();
    const tx = db.transaction(['books', 'chapter-contents', 'import-jobs', 'import-job-items'], 'readwrite');
    const job = await tx.objectStore('import-jobs').get(jobIdValue);
    if (!job) throw makeError('invalid_url', '导入任务不存在');
    const checkedAt = now();
    const books = job.mode === 'preview' ? [] : await tx.objectStore('books').getAll();
    const book =
      job.mode === 'preview'
        ? undefined
        : upsertBookSource(findBookBySource(books, snapshot.source), snapshot, checkedAt);
    const costUsed = (job.providerCostMicrosUsed ?? 0) + (discovery.costMicros ?? 0);
    const updatedJob: ImportJob = {
      ...job,
      ...(book ? { novelId: book.id } : {}),
      snapshot,
      bodyBytes: job.bodyBytes + bodyBytes,
      providerCostMicrosUsed: costUsed,
      status: snapshot.metadataOnly ? 'applying' : 'fetching',
      updatedAt: checkedAt,
    };
    if (updatedJob.bodyBytes > MAX_SUCCESSFUL_BODY_BYTES) {
      throw makeError('job_body_limit_exceeded', '导入任务正文总量超过 64 MiB');
    }
    if (book) {
      await tx.objectStore('books').put(serializeDates(stripBookContent(book)));
    }
    await tx.objectStore('import-jobs').put(updatedJob);
    await tx.done;
    if (book) notifyLibraryChanged();
    return updatedJob;
  }

  private static async createItems(
    job: ImportJob,
    snapshot: RemoteWorkSnapshot,
  ): Promise<ImportJobItem[]> {
    const selected = job.selectedRemoteChapterIds ? new Set(job.selectedRemoteChapterIds) : null;
    const chapters = selected
      ? snapshot.chapters.filter((chapter) => selected.has(chapter.remoteChapterId))
      : snapshot.chapters;
    const timestamp = now();
    const items = chapters.map<ImportJobItem>((chapter) => createQueuedImportItem(job, chapter, timestamp));

    const db = await getDB();
    const tx = db.transaction(['import-jobs', 'import-job-items'], 'readwrite');
    const latest = await tx.objectStore('import-jobs').get(job.id);
    if (!latest) throw makeError('invalid_url', '导入任务不存在');
    for (const item of items) await tx.objectStore('import-job-items').put(item);
    await tx.objectStore('import-jobs').put({
      ...latest,
      counts: { total: items.length, completed: 0, failed: 0, cancelled: 0 },
      status: 'fetching',
      updatedAt: now(),
    });
    await tx.done;
    return items;
  }

  private static async processItem(
    job: ImportJob,
    item: ImportJobItem,
    snapshot: RemoteWorkSnapshot,
  ): Promise<void> {
    const remote = snapshot.chapters.find((chapter) => chapter.remoteChapterId === item.remoteChapterId);
    if (!remote) {
      await this.markItemFailed(job.id, item.id, makeError('parse_failed', '目录中缺少章节'));
      return;
    }
    const adapter = SourceRegistry.get(job.sourceKey);
    if (!adapter.parseChapter) {
      await this.markItemFailed(job.id, item.id, makeError('policy_disallowed', '该来源不允许导入章节正文'));
      return;
    }

    const response = await fetchWithRetries(
      {
        sourceKey: job.sourceKey,
        kind: 'chapter',
        url: SourceRegistry.chapterUrl(remote),
        jobId: job.id,
        maxProviderCostMicros: job.maxProviderCostMicros,
        providerCostMicrosUsed: job.providerCostMicrosUsed,
      },
      async (attempt) => this.updateItem(job.id, item.id, 'fetching', attempt),
    );
    if (!response.ok) {
      await this.markItemFailed(job.id, item.id, response.error);
      return;
    }

    const latest = await this.getImportJob(job.id);
    if (!latest || latest.cancellationRequested) return;
    if (latest.bodyBytes + response.response.byteLength > MAX_SUCCESSFUL_BODY_BYTES) {
      await this.markItemFailed(
        job.id,
        item.id,
        makeError('job_body_limit_exceeded', '导入任务正文总量超过 64 MiB'),
      );
      return;
    }

    try {
      const body = await adapter.parseChapter(remote, response.response.body);
      await this.applyChapter(job.id, item.id, remote, body, response.response.byteLength, response.costMicros);
    } catch (error) {
      await this.markItemFailed(job.id, item.id, asImportError(error));
    }
  }

  private static async applyChapter(
    jobIdValue: string,
    itemIdValue: string,
    remote: RemoteChapterStub,
    body: RemoteChapterBody,
    bodyBytes: number,
    costMicros?: number,
  ): Promise<void> {
    const db = await getDB();
    const tx = db.transaction(['books', 'chapter-contents', 'import-jobs', 'import-job-items'], 'readwrite');
    const job = await tx.objectStore('import-jobs').get(jobIdValue);
    const item = await tx.objectStore('import-job-items').get(itemIdValue);
    if (!job || !item) throw makeError('invalid_url', '导入任务不存在');
    const snapshot = job.snapshot;
    if (!snapshot || !job.novelId) throw makeError('parse_failed', '导入任务缺少目录快照');

    const book = await tx.objectStore('books').get(job.novelId);
    if (!book) throw makeError('parse_failed', '导入目标书籍不存在');
    const fetchedAt = now();
    const existing = getChapterBySource(book, remote);
    const stored = existing ? await tx.objectStore('chapter-contents').get(existing.id) : undefined;
    const previousParagraphs = parseStoredParagraphs(stored?.content);
    const unchanged = existing?.source?.contentHash === body.contentHash;
    const paragraphs = unchanged
      ? previousParagraphs
      : preserveParagraphTranslations(previousParagraphs, body.paragraphs);
    const nextChapter = unchanged && existing
      ? {
          ...existing,
          webUrl: remote.canonicalChapterUrl,
          source: sourceChapterMetadata(remote, body, fetchedAt),
        }
      : existing
        ? updateChapter(existing, remote, body, previousParagraphs, fetchedAt)
        : createChapter(remote, body, fetchedAt);
    if (!unchanged) nextChapter.content = paragraphs;

    for (const volume of book.volumes || []) {
      if (!volume.chapters) continue;
      volume.chapters = volume.chapters.filter((chapter) => chapter.id !== nextChapter.id);
    }
    const target = ensureSourceVolume(book, remote);
    target.chapters = [...(target.chapters || []), nextChapter];
    reconcileSourceOrder(book, snapshot);
    book.lastEdited = new Date(fetchedAt);

    const completedItem = {
      ...updateItemStatus(item, 'completed' as const),
      attempts: item.attempts,
      contentHash: body.contentHash,
      lastError: undefined,
    };
    const updatedJob: ImportJob = {
      ...job,
      status: 'applying',
      bodyBytes: job.bodyBytes + bodyBytes,
      providerCostMicrosUsed: (job.providerCostMicrosUsed ?? 0) + (costMicros ?? 0),
      counts: { ...job.counts, completed: job.counts.completed + 1 },
      updatedAt: fetchedAt,
    };
    if (!unchanged) {
      await tx.objectStore('chapter-contents').put({
        chapterId: nextChapter.id,
        content: JSON.stringify(paragraphs),
        lastModified: fetchedAt,
      });
    }
    await tx.objectStore('books').put(serializeDates(stripBookContent(book)));
    await tx.objectStore('import-job-items').put(completedItem);
    await tx.objectStore('import-jobs').put(updatedJob);
    await tx.done;
    if (!unchanged) ChapterContentService.clearCache(nextChapter.id);
    notifyLibraryChanged();
  }

  private static async markItemFailed(
    jobIdValue: string,
    itemIdValue: string,
    error: ImportError,
  ): Promise<void> {
    const db = await getDB();
    const tx = db.transaction(['import-jobs', 'import-job-items'], 'readwrite');
    const job = await tx.objectStore('import-jobs').get(jobIdValue);
    const item = await tx.objectStore('import-job-items').get(itemIdValue);
    if (!job || !item || item.status === 'failed') {
      await tx.done;
      return;
    }
    await tx.objectStore('import-job-items').put({
      ...updateItemStatus(item, 'failed'),
      lastError: error,
    });
    await tx.objectStore('import-jobs').put({
      ...job,
      status: 'fetching',
      counts: { ...job.counts, failed: job.counts.failed + 1 },
      updatedAt: now(),
    });
    await tx.done;
  }

  private static async updateItem(
    jobIdValue: string,
    itemIdValue: string,
    status: ImportJobItem['status'],
    attempts: number,
  ): Promise<void> {
    const db = await getDB();
    const tx = db.transaction('import-job-items', 'readwrite');
    const item = await tx.store.get(itemIdValue);
    if (item && item.jobId === jobIdValue) {
      await tx.store.put({ ...updateItemStatus(item, status), attempts });
    }
    await tx.done;
  }

  private static async updateJob(
    id: string,
    updates: Partial<ImportJob>,
  ): Promise<ImportJob | undefined> {
    const db = await getDB();
    const tx = db.transaction('import-jobs', 'readwrite');
    const job = await tx.store.get(id);
    if (!job) {
      await tx.done;
      return undefined;
    }
    const updated = { ...job, ...updates, updatedAt: now() };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  }

  private static async finalizeJob(id: string, cancelled: boolean): Promise<void> {
    const db = await getDB();
    const tx = db.transaction(['import-jobs', 'import-job-items'], 'readwrite');
    const job = await tx.objectStore('import-jobs').get(id);
    if (!job) {
      await tx.done;
      return;
    }
    const items = await tx.objectStore('import-job-items').index('by-jobId').getAll(id);
    const finalizedItems = cancelled
      ? items.map((item) =>
          item.status === 'completed' || item.status === 'failed'
            ? item
            : updateItemStatus(item, 'cancelled'),
        )
      : items;
    for (const item of finalizedItems) {
      if (item !== items.find((candidate) => candidate.id === item.id)) {
        await tx.objectStore('import-job-items').put(item);
      }
    }
    const counts = {
      total: finalizedItems.length,
      completed: finalizedItems.filter((item) => item.status === 'completed').length,
      failed: finalizedItems.filter((item) => item.status === 'failed').length,
      cancelled: finalizedItems.filter((item) => item.status === 'cancelled').length,
    };
    const status = cancelled
      ? 'cancelled'
      : counts.failed > 0
        ? 'completed_with_errors'
        : 'completed';
    await tx.objectStore('import-jobs').put({
      ...job,
      status,
      counts,
      completedAt: now(),
      updatedAt: now(),
      cancellationRequested: false,
    });
    await tx.done;
  }
}

export function __resetImportJobServiceForTesting(): void {
  fetchImportResource = (request) => performRendererFetch(request);
  importClock = systemClock;
  lastRequestStartedAt.clear();
  workerRunning = false;
  workerPromise = null;
  shuttingDown = false;
}
