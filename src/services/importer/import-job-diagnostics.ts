import type { ImportJob, ImportJobItem } from 'src/models/importer';
import { getDB } from 'src/utils/indexed-db';

/**
 * 本地导入/抓取运行状态的只读快照。用于区分「应用就绪」与「某个任务失败」：
 * 失败是任务级字段（status/lastError），不影响应用级 readiness。
 * 不包含响应体、凭据或任何机密。
 */
export interface ImportJobDiagnostics {
  /** 应用级就绪：导入子系统可处理新任务（worker 空闲或正串行执行）。 */
  ready: boolean;
  /** 队列中等待执行的任务数。 */
  queuedJobs: number;
  /** 正在执行的任务数。 */
  runningJobs: number;
  /** 最近一次恢复的中断任务数（本次进程启动时 requeue 的数量）。 */
  recoveredJobs: number;
  jobs: ImportJobSummary[];
}

export interface ImportJobSummary {
  id: string;
  status: ImportJob['status'];
  mode: ImportJob['mode'];
  sourceKey: ImportJob['sourceKey'];
  remoteWorkId: ImportJob['remoteWorkId'];
  counts: ImportJob['counts'];
  bodyBytes: ImportJob['bodyBytes'];
  createdAt: ImportJob['createdAt'];
  updatedAt: ImportJob['updatedAt'];
  completedAt?: ImportJob['completedAt'];
  error?: ImportJob['error'];
  /** 该任务当前失败（含已重试）的章节数，不含取消的章节。 */
  failedItems: number;
  /** 该任务当前仍排队等待抓取的章节数。 */
  queuedItems: number;
}

const ACTIVE_STATUSES: ReadonlySet<ImportJob['status']> = new Set([
  'queued',
  'discovering',
  'fetching',
  'applying',
]);

const RUNNING_STATUSES: ReadonlySet<ImportJob['status']> = new Set([
  'discovering',
  'fetching',
  'applying',
]);

function summarizeJob(job: ImportJob, items: ImportJobItem[]): ImportJobSummary {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    sourceKey: job.sourceKey,
    remoteWorkId: job.remoteWorkId,
    counts: { ...job.counts },
    bodyBytes: job.bodyBytes,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
    failedItems: items.filter((item) => item.status === 'failed').length,
    queuedItems: items.filter((item) => item.status === 'queued').length,
  };
}

/**
 * 从 IndexedDB 读取当前导入任务的只读诊断快照。只读事务，不改变任何状态。
 */
export async function collectImportJobDiagnostics(recoveredJobs = 0): Promise<ImportJobDiagnostics> {
  const db = await getDB();
  const tx = db.transaction(['import-jobs', 'import-job-items'], 'readonly');
  const [jobs, items] = await Promise.all([
    tx.objectStore('import-jobs').getAll(),
    tx.objectStore('import-job-items').getAll(),
  ]);
  await tx.done;

  const byJobId = new Map<string, ImportJobItem[]>();
  for (const item of items) {
    const bucket = byJobId.get(item.jobId) || [];
    bucket.push(item);
    byJobId.set(item.jobId, bucket);
  }

  const summaries = jobs
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((job) => summarizeJob(job, byJobId.get(job.id) || []));
  const runningJobs = summaries.filter((job) => RUNNING_STATUSES.has(job.status)).length;
  const queuedJobs = summaries.filter((job) => job.status === 'queued').length;

  return {
    // 就绪 = 没有任务正在执行且没有任务排队；失败是任务级字段，不影响应用就绪。
    ready: runningJobs === 0 && queuedJobs === 0,
    queuedJobs,
    runningJobs,
    recoveredJobs,
    jobs: summaries,
  };
}
