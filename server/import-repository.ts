import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  ACTIVE_IMPORT_JOB_STATUSES,
  INTERRUPTED_IMPORT_JOB_STATUSES,
  type CreateImportJobRequest,
  type ImportError,
  type ImportJob,
  type ImportJobItem,
  type RemoteChapterBody,
  type RemoteChapterStub,
  type RemoteWorkSnapshot,
} from '../src/models/importer';
import { SourceRegistry } from '../src/services/importer/source-registry';
import { createQueuedImportItem, discoveryFetchRequest, sourceWorkMetadata } from '../src/services/importer/import-job-service';
import type { LibraryRepository } from './library-repository';

const MAX_SUCCESSFUL_BODY_BYTES = 64 * 1024 * 1024;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type StoredJob = {
  body_json: string;
};
type StoredJobItem = {
  body_json: string;
};
type StoredEvent = {
  event_id: number;
  event_name: 'job' | 'item' | 'terminal' | 'reset';
  data_json: string;
  created_at: string;
};

export type JobEvent = {
  id: number;
  name: 'job' | 'item' | 'terminal' | 'reset';
  data: Record<string, unknown>;
  createdAt: string;
};

export type CreatedImportJob = {
  job: ImportJob;
  created: boolean;
  deduplicated: boolean;
};

export class ImportRepositoryError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'unsupported_source'
      | 'policy_disallowed'
      | 'not_found'
      | 'conflict',
    readonly status: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error('导入存储数据无效');
  }
}

function requireId(value: string, label: string): string {
  if (!value || value.length > 128 || value.includes('\0') || value.includes('/') || value.includes('\\')) {
    throw new ImportRepositoryError('invalid_request', 400, `${label} 无效`);
  }
  return value;
}

function toCreateError(error: unknown): ImportRepositoryError {
  if (error instanceof ImportRepositoryError) return error;
  return new ImportRepositoryError('invalid_request', 400, '导入请求无效');
}

function statusKey(item: ImportJobItem, status: ImportJobItem['status']): string {
  return `${item.jobId}:${status}`;
}

function toJob(row: StoredJob | null): ImportJob | undefined {
  return row ? parseJson<ImportJob>(row.body_json) : undefined;
}

function toItem(row: StoredJobItem | null): ImportJobItem | undefined {
  return row ? parseJson<ImportJobItem>(row.body_json) : undefined;
}

function terminalStatus(status: ImportJob['status']): boolean {
  return !ACTIVE_IMPORT_JOB_STATUSES.has(status);
}

function safeEventData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}

export class ImportJobRepository {
  constructor(
    private readonly database: Database,
    private readonly library: LibraryRepository,
  ) {}

  create(request: CreateImportJobRequest): CreatedImportJob {
    try {
      if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 256) {
        throw new ImportRepositoryError('invalid_request', 400, '缺少幂等键');
      }
      if (!['preview', 'import', 'refresh'].includes(request.mode)) {
        throw new ImportRepositoryError('invalid_request', 400, '导入模式无效');
      }
      if (request.selectedRemoteChapterIds?.some((id) => !id || id.length > 128)) {
        throw new ImportRepositoryError('invalid_request', 400, '选择章节无效');
      }
      if (
        request.maxProviderCostMicros !== undefined &&
        (!Number.isSafeInteger(request.maxProviderCostMicros) || request.maxProviderCostMicros < 0)
      ) {
        throw new ImportRepositoryError('invalid_request', 400, '服务商预算无效');
      }
      const source = SourceRegistry.detect(request.url);
      if (!source) throw new ImportRepositoryError('unsupported_source', 422, '不支持的来源 URL');
      if (source.sourceKey === 'kakuyomu' && request.privateUseAcknowledged !== true) {
        throw new ImportRepositoryError('policy_disallowed', 422, 'Kakuyomu 导入仅限已确认的个人使用');
      }
      return this.library.runInTransaction(() => {
        const existing = this.byIdempotencyKey(request.idempotencyKey);
        if (existing) return { job: existing, created: false, deduplicated: false };
        const sourceWorkKey = SourceRegistry.sourceWorkKey(source);
        const active = this.activeBySourceWork(sourceWorkKey);
        if (active) return { job: active, created: false, deduplicated: true };

        const timestamp = now();
        const job: ImportJob = {
          id: `import-${randomUUID()}`,
          idempotencyKey: request.idempotencyKey.trim(),
          mode: request.mode,
          inputUrl: request.url,
          sourceKey: source.sourceKey,
          remoteWorkId: source.remoteWorkId,
          canonicalWorkUrl: source.canonicalWorkUrl,
          sourceWorkKey,
          status: 'queued',
          counts: { total: 0, completed: 0, failed: 0, cancelled: 0 },
          bodyBytes: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(request.selectedRemoteChapterIds ? { selectedRemoteChapterIds: [...request.selectedRemoteChapterIds] } : {}),
          ...(request.privateUseAcknowledged ? { privateUseAcknowledged: true } : {}),
          ...(request.maxProviderCostMicros !== undefined
            ? { maxProviderCostMicros: request.maxProviderCostMicros }
            : {}),
        };
        try {
          this.insertJob(job);
        } catch {
          const racedIdempotent = this.byIdempotencyKey(job.idempotencyKey);
          if (racedIdempotent) return { job: racedIdempotent, created: false, deduplicated: false };
          const racedActive = this.activeBySourceWork(job.sourceWorkKey);
          if (racedActive) return { job: racedActive, created: false, deduplicated: true };
          throw new ImportRepositoryError('conflict', 409, '导入任务冲突');
        }
        this.appendEvent(job.id, 'job', { job });
        return { job, created: true, deduplicated: false };
      });
    } catch (error) {
      throw toCreateError(error);
    }
  }

  get(id: string): ImportJob | undefined {
    return toJob(
      this.database.query('SELECT body_json FROM import_jobs WHERE id = ?').get(requireId(id, '导入任务 ID')) as StoredJob | null,
    );
  }

  list(limit = 100, cursor?: string): ImportJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ImportRepositoryError('invalid_request', 400, '分页大小无效');
    }
    if (cursor !== undefined && (!cursor || cursor.length > 128)) {
      throw new ImportRepositoryError('invalid_request', 400, '分页游标无效');
    }
    const rows = (cursor
      ? this.database
          .query('SELECT body_json FROM import_jobs WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(cursor, limit)
      : this.database.query('SELECT body_json FROM import_jobs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)) as StoredJob[];
    return rows.map((row) => parseJson<ImportJob>(row.body_json));
  }

  listItems(jobId: string): ImportJobItem[] {
    const safeJobId = requireId(jobId, '导入任务 ID');
    if (!this.get(safeJobId)) throw new ImportRepositoryError('not_found', 404, '导入任务不存在');
    return (
      this.database
        .query('SELECT body_json FROM import_job_items WHERE job_id = ? ORDER BY id')
        .all(safeJobId) as StoredJobItem[]
    )
      .map((row) => parseJson<ImportJobItem>(row.body_json))
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  }

  eventsAfter(jobId: string, after: number): JobEvent[] {
    const safeJobId = requireId(jobId, '导入任务 ID');
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new ImportRepositoryError('invalid_request', 400, '事件游标无效');
    }
    if (!this.get(safeJobId)) throw new ImportRepositoryError('not_found', 404, '导入任务不存在');
    const rows = this.database
      .query(
        'SELECT event_id, event_name, data_json, created_at FROM job_events WHERE job_id = ? AND event_id > ? ORDER BY event_id LIMIT 1000',
      )
      .all(safeJobId, after) as StoredEvent[];
    return rows.map((row) => ({
      id: row.event_id,
      name: row.event_name,
      data: safeEventData(parseJson<unknown>(row.data_json)),
      createdAt: row.created_at,
    }));
  }

  oldestEventId(jobId: string): number | undefined {
    const row = this.database
      .query('SELECT min(event_id) AS event_id FROM job_events WHERE job_id = ?')
      .get(requireId(jobId, '导入任务 ID')) as { event_id: number | null } | null;
    return row?.event_id ?? undefined;
  }

  cancel(id: string): ImportJob | undefined {
    const jobId = requireId(id, '导入任务 ID');
    return this.library.runInTransaction(() => {
      const job = this.get(jobId);
      if (!job || !ACTIVE_IMPORT_JOB_STATUSES.has(job.status)) return job;
      const timestamp = now();
      const cancelled: ImportJob = {
        ...job,
        cancellationRequested: true,
        ...(job.status === 'queued' ? { status: 'cancelled', completedAt: timestamp } : {}),
        updatedAt: timestamp,
      };
      if (job.status === 'queued') {
        for (const item of this.listItems(job.id)) {
          if (item.status === 'queued') this.storeItem({ ...item, status: 'cancelled', jobStatusKey: statusKey(item, 'cancelled'), updatedAt: timestamp });
        }
      }
      this.storeJob(cancelled);
      this.appendEvent(job.id, terminalStatus(cancelled.status) ? 'terminal' : 'job', { job: cancelled });
      return cancelled;
    });
  }

  retryFailedItems(id: string): ImportJob {
    const parent = this.get(requireId(id, '导入任务 ID'));
    if (!parent) throw new ImportRepositoryError('not_found', 404, '导入任务不存在');
    const chapters = this.listItems(parent.id)
      .filter((item) => item.status === 'failed' && item.lastError?.retryable === true)
      .map((item) => item.remoteChapterId);
    if (chapters.length === 0) throw new ImportRepositoryError('invalid_request', 400, '没有可重试的失败章节');
    return this.library.runInTransaction(() => {
      const timestamp = now();
      const job: ImportJob = {
        ...parent,
        id: `import-${randomUUID()}`,
        idempotencyKey: `retry:${parent.id}:${timestamp}`,
        mode: 'retry_failed',
        status: 'queued',
        counts: { total: 0, completed: 0, failed: 0, cancelled: 0 },
        bodyBytes: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        retryOf: parent.id,
        selectedRemoteChapterIds: chapters,
        cancellationRequested: false,
        completedAt: undefined,
        error: undefined,
      };
      this.insertJob(job);
      this.appendEvent(job.id, 'job', { job });
      return job;
    });
  }

  recoverInterruptedJobs(): number {
    return this.library.runInTransaction(() => {
      const jobs = (this.database
        .query("SELECT body_json FROM import_jobs WHERE status IN ('discovering', 'fetching', 'applying')")
        .all() as StoredJob[])
        .map((row) => parseJson<ImportJob>(row.body_json));
      const timestamp = now();
      for (const job of jobs) {
        const queued: ImportJob = {
          ...job,
          status: 'queued',
          cancellationRequested: false,
          updatedAt: timestamp,
        };
        this.storeJob(queued);
        for (const item of this.listItems(job.id)) {
          if (item.status === 'fetching' || item.status === 'applying') {
            this.storeItem({ ...item, status: 'queued', jobStatusKey: statusKey(item, 'queued'), updatedAt: timestamp });
          }
        }
        this.appendEvent(job.id, 'job', { job: queued, recovered: true });
      }
      return jobs.length;
    });
  }

  nextQueued(): ImportJob | undefined {
    const row = this.database
      .query("SELECT body_json FROM import_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1")
      .get() as StoredJob | null;
    return toJob(row);
  }

  applySnapshot(jobId: string, snapshot: RemoteWorkSnapshot, bodyBytes: number, costMicros = 0): ImportJob {
    return this.library.runInTransaction(() => {
      const job = this.requiredJob(jobId);
      const totalBytes = job.bodyBytes + bodyBytes;
      if (totalBytes > MAX_SUCCESSFUL_BODY_BYTES) {
        throw new ImportRepositoryError('invalid_request', 400, '导入任务正文总量超过 64 MiB');
      }
      const book = job.mode === 'preview' ? undefined : this.library.upsertImportedSnapshot(snapshot);
      const novelId = book && typeof book.book.id === 'string' ? book.book.id : undefined;
      const updated: ImportJob = {
        ...job,
        ...(novelId ? { novelId } : {}),
        snapshot,
        bodyBytes: totalBytes,
        providerCostMicrosUsed: (job.providerCostMicrosUsed ?? 0) + costMicros,
        status: snapshot.metadataOnly ? 'applying' : 'fetching',
        updatedAt: now(),
      };
      this.storeJob(updated);
      this.appendEvent(job.id, 'job', { job: updated });
      return updated;
    });
  }

  createItems(jobId: string, snapshot: RemoteWorkSnapshot): ImportJobItem[] {
    return this.library.runInTransaction(() => {
      const job = this.requiredJob(jobId);
      const selected = job.selectedRemoteChapterIds ? new Set(job.selectedRemoteChapterIds) : undefined;
      const timestamp = now();
      const items = snapshot.chapters
        .filter((chapter) => !selected || selected.has(chapter.remoteChapterId))
        .map<ImportJobItem>((chapter) => createQueuedImportItem(job, chapter, timestamp));
      for (const item of items) this.insertItem(item);
      const updated: ImportJob = {
        ...job,
        counts: { total: items.length, completed: 0, failed: 0, cancelled: 0 },
        status: items.length > 0 ? 'fetching' : 'applying',
        updatedAt: timestamp,
      };
      this.storeJob(updated);
      this.appendEvent(job.id, 'job', { job: updated });
      return items;
    });
  }

  setJobStatus(jobId: string, updates: Partial<ImportJob>): ImportJob {
    return this.library.runInTransaction(() => {
      const job = this.requiredJob(jobId);
      const updated: ImportJob = { ...job, ...updates, updatedAt: now() };
      this.storeJob(updated);
      this.appendEvent(job.id, terminalStatus(updated.status) ? 'terminal' : 'job', { job: updated });
      return updated;
    });
  }

  setItemFetching(jobId: string, itemId: string, attempts: number): ImportJobItem {
    return this.library.runInTransaction(() => {
      const item = this.requiredItem(jobId, itemId);
      const updated: ImportJobItem = {
        ...item,
        status: 'fetching',
        jobStatusKey: statusKey(item, 'fetching'),
        attempts,
        updatedAt: now(),
      };
      this.storeItem(updated);
      this.appendEvent(jobId, 'item', { item: updated });
      return updated;
    });
  }

  applyChapter(
    jobId: string,
    itemId: string,
    remote: RemoteChapterStub,
    body: RemoteChapterBody,
    bodyBytes: number,
    costMicros = 0,
  ): ImportJob {
    return this.library.runInTransaction(() => {
      const job = this.requiredJob(jobId);
      const item = this.requiredItem(jobId, itemId);
      if (!job.novelId) throw new ImportRepositoryError('conflict', 409, '导入任务缺少目标书籍');
      const totalBytes = job.bodyBytes + bodyBytes;
      if (totalBytes > MAX_SUCCESSFUL_BODY_BYTES) {
        throw new ImportRepositoryError('invalid_request', 400, '导入任务正文总量超过 64 MiB');
      }
      this.library.applyImportedChapter(job.novelId, remote, body);
      const timestamp = now();
      const completedItem: ImportJobItem = {
        ...item,
        status: 'completed',
        jobStatusKey: statusKey(item, 'completed'),
        contentHash: body.contentHash,
        lastError: undefined,
        updatedAt: timestamp,
      };
      const updatedJob: ImportJob = {
        ...job,
        status: 'applying',
        bodyBytes: totalBytes,
        providerCostMicrosUsed: (job.providerCostMicrosUsed ?? 0) + costMicros,
        counts: { ...job.counts, completed: job.counts.completed + 1 },
        updatedAt: timestamp,
      };
      this.storeItem(completedItem);
      this.storeJob(updatedJob);
      this.appendEvent(job.id, 'item', { item: completedItem });
      this.appendEvent(job.id, 'job', { job: updatedJob });
      return updatedJob;
    });
  }

  markItemFailed(jobId: string, itemId: string, error: ImportError): ImportJob {
    return this.library.runInTransaction(() => {
      const job = this.requiredJob(jobId);
      const item = this.requiredItem(jobId, itemId);
      if (item.status === 'failed') return job;
      const timestamp = now();
      const failedItem: ImportJobItem = {
        ...item,
        status: 'failed',
        jobStatusKey: statusKey(item, 'failed'),
        lastError: error,
        updatedAt: timestamp,
      };
      const updatedJob: ImportJob = {
        ...job,
        status: 'fetching',
        counts: { ...job.counts, failed: job.counts.failed + 1 },
        updatedAt: timestamp,
      };
      this.storeItem(failedItem);
      this.storeJob(updatedJob);
      this.appendEvent(job.id, 'item', { item: failedItem });
      this.appendEvent(job.id, 'job', { job: updatedJob });
      return updatedJob;
    });
  }

  finalize(jobId: string, cancelled: boolean): ImportJob {
    return this.library.runInTransaction(() => {
      const job = this.requiredJob(jobId);
      const timestamp = now();
      const items = this.listItems(job.id).map((item) => {
        if (!cancelled || item.status === 'completed' || item.status === 'failed') return item;
        const updated: ImportJobItem = {
          ...item,
          status: 'cancelled',
          jobStatusKey: statusKey(item, 'cancelled'),
          updatedAt: timestamp,
        };
        this.storeItem(updated);
        this.appendEvent(job.id, 'item', { item: updated });
        return updated;
      });
      const counts = {
        total: items.length,
        completed: items.filter((item) => item.status === 'completed').length,
        failed: items.filter((item) => item.status === 'failed').length,
        cancelled: items.filter((item) => item.status === 'cancelled').length,
      };
      const status: ImportJob['status'] = cancelled
        ? 'cancelled'
        : counts.failed > 0
          ? 'completed_with_errors'
          : 'completed';
      const updated: ImportJob = {
        ...job,
        status,
        counts,
        completedAt: timestamp,
        updatedAt: timestamp,
        cancellationRequested: false,
      };
      this.storeJob(updated);
      this.appendEvent(job.id, 'terminal', { job: updated });
      return updated;
    });
  }

  cleanupExpiredEvents(nowMs = Date.now()): void {
    this.database
      .query('DELETE FROM job_events WHERE created_at < ?')
      .run(new Date(nowMs - EVENT_RETENTION_MS).toISOString());
  }

  private byIdempotencyKey(idempotencyKey: string): ImportJob | undefined {
    return toJob(
      this.database
        .query('SELECT body_json FROM import_jobs WHERE idempotency_key = ?')
        .get(idempotencyKey) as StoredJob | null,
    );
  }

  private activeBySourceWork(sourceWorkKey: string): ImportJob | undefined {
    const row = this.database
      .query(
        "SELECT body_json FROM import_jobs WHERE source_work_key = ? AND status IN ('queued', 'discovering', 'fetching', 'applying') ORDER BY created_at LIMIT 1",
      )
      .get(sourceWorkKey) as StoredJob | null;
    return toJob(row);
  }

  private requiredJob(jobId: string): ImportJob {
    const job = this.get(requireId(jobId, '导入任务 ID'));
    if (!job) throw new ImportRepositoryError('not_found', 404, '导入任务不存在');
    return job;
  }

  private requiredItem(jobId: string, itemId: string): ImportJobItem {
    const item = toItem(
      this.database
        .query('SELECT body_json FROM import_job_items WHERE id = ? AND job_id = ?')
        .get(requireId(itemId, '导入任务条目 ID'), requireId(jobId, '导入任务 ID')) as StoredJobItem | null,
    );
    if (!item) throw new ImportRepositoryError('not_found', 404, '导入任务条目不存在');
    return item;
  }

  private insertJob(job: ImportJob): void {
    this.database
      .query(
        `INSERT INTO import_jobs
          (id, body_json, idempotency_key, source_work_key, source_key, remote_work_id, status, created_at, updated_at, completed_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        JSON.stringify(job),
        job.idempotencyKey,
        job.sourceWorkKey,
        job.sourceKey,
        job.remoteWorkId,
        job.status,
        job.createdAt,
        job.updatedAt,
        job.completedAt ?? null,
        1,
      );
  }

  private storeJob(job: ImportJob): void {
    const result = this.database
      .query(
        `UPDATE import_jobs SET body_json = ?, source_work_key = ?, source_key = ?, remote_work_id = ?,
         status = ?, created_at = ?, updated_at = ?, completed_at = ?, revision = revision + 1 WHERE id = ?`,
      )
      .run(
        JSON.stringify(job),
        job.sourceWorkKey,
        job.sourceKey,
        job.remoteWorkId,
        job.status,
        job.createdAt,
        job.updatedAt,
        job.completedAt ?? null,
        job.id,
      );
    if (result.changes !== 1) throw new ImportRepositoryError('not_found', 404, '导入任务不存在');
  }

  private insertItem(item: ImportJobItem): void {
    this.database
      .query(
        `INSERT INTO import_job_items
          (id, job_id, body_json, remote_chapter_id, source_chapter_key, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.jobId,
        JSON.stringify(item),
        item.remoteChapterId,
        item.sourceChapterKey,
        item.status,
        item.attempts,
        item.createdAt,
        item.updatedAt,
      );
  }

  private storeItem(item: ImportJobItem): void {
    const result = this.database
      .query(
        `UPDATE import_job_items SET body_json = ?, remote_chapter_id = ?, source_chapter_key = ?, status = ?,
         attempts = ?, created_at = ?, updated_at = ? WHERE id = ? AND job_id = ?`,
      )
      .run(
        JSON.stringify(item),
        item.remoteChapterId,
        item.sourceChapterKey,
        item.status,
        item.attempts,
        item.createdAt,
        item.updatedAt,
        item.id,
        item.jobId,
      );
    if (result.changes !== 1) throw new ImportRepositoryError('not_found', 404, '导入任务条目不存在');
  }

  private appendEvent(
    jobId: string,
    name: 'job' | 'item' | 'terminal' | 'reset',
    data: Record<string, unknown>,
  ): void {
    const row = this.database
      .query('SELECT coalesce(max(sequence), 0) AS sequence FROM job_events WHERE job_id = ?')
      .get(jobId) as { sequence: number } | null;
    this.database
      .query('INSERT INTO job_events (job_id, sequence, event_name, data_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, (row?.sequence ?? 0) + 1, name, JSON.stringify(data), now());
  }
}

export function isInterruptedJob(job: ImportJob): boolean {
  return INTERRUPTED_IMPORT_JOB_STATUSES.has(job.status);
}
