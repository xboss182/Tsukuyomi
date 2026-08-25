import type { Novel } from './novel';

export type SourceKey =
  | 'kakuyomu'
  | 'narou-metadata'
  | 'nobadnovel'
  | 'freewebnovel'
  | 'novellunar';

export type ImportMode = 'preview' | 'import' | 'refresh' | 'retry_failed';

export type ImportJobStatus =
  | 'queued'
  | 'discovering'
  | 'fetching'
  | 'applying'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type ImportJobItemStatus =
  | 'queued'
  | 'fetching'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ImportErrorCode =
  | 'invalid_url'
  | 'unsupported_source'
  | 'policy_disallowed'
  | 'unsafe_redirect'
  | 'unsafe_address'
  | 'timeout'
  | 'response_too_large'
  | 'unexpected_content_type'
  | 'rate_limited'
  | 'network_error'
  | 'http_error'
  | 'parse_failed'
  | 'cancelled'
  | 'electron_unavailable'
  | 'job_body_limit_exceeded'
  | 'challenge_detected'
  | 'provider_unavailable'
  | 'provider_error'
  | 'budget_exceeded'
  | 'unknown';

export interface ImportError {
  code: ImportErrorCode;
  message: string;
  retryable: boolean;
  status?: number | undefined;
  retryAfterMs?: number | undefined;
}

export interface SourceIdentity {
  sourceKey: SourceKey;
  remoteWorkId: string;
  canonicalWorkUrl: string;
}

export interface SourceWorkMetadata extends SourceIdentity {
  lastCheckedAt: string;
  remoteUpdatedAt?: string | undefined;
  remoteTitle?: string | undefined;
  remoteAuthor?: string | undefined;
  remoteDescription?: string | undefined;
  remoteTags?: string[] | undefined;
}

export interface SourceVolumeMetadata {
  sourceKey: SourceKey;
  remoteWorkId: string;
  remoteVolumeId: string;
}

export interface SourceChapterMetadata extends SourceIdentity {
  remoteChapterId: string;
  canonicalChapterUrl: string;
  remoteTitle: string;
  remoteUpdatedAt?: string | undefined;
  contentHash?: string | undefined;
  parserVersion: string;
  fetchedAt?: string | undefined;
  sequence: number;
}

export interface RemoteVolume {
  remoteVolumeId: string;
  title: string;
  sequence: number;
}

export interface RemoteChapterStub extends SourceIdentity {
  remoteChapterId: string;
  canonicalChapterUrl: string;
  title: string;
  volume: RemoteVolume;
  sequence: number;
  publishedAt?: string | undefined;
  remoteUpdatedAt?: string | undefined;
}

export interface RemoteWorkSnapshot {
  source: SourceIdentity;
  title: string;
  author?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  remoteUpdatedAt?: string | undefined;
  volumes: RemoteVolume[];
  chapters: RemoteChapterStub[];
  metadataOnly: boolean;
}

export interface RemoteChapterBody {
  paragraphs: string[];
  contentHash: string;
  parserVersion: string;
}

export interface ImportJobCounts {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface ImportJob {
  id: string;
  idempotencyKey: string;
  mode: ImportMode;
  inputUrl: string;
  sourceKey: SourceKey;
  remoteWorkId: string;
  canonicalWorkUrl: string;
  sourceWorkKey: string;
  novelId?: string | undefined;
  status: ImportJobStatus;
  counts: ImportJobCounts;
  bodyBytes: number;
  maxProviderCostMicros?: number | undefined;
  providerCostMicrosUsed?: number | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  retryOf?: string | undefined;
  selectedRemoteChapterIds?: string[] | undefined;
  privateUseAcknowledged?: boolean | undefined;
  snapshot?: RemoteWorkSnapshot | undefined;
  cancellationRequested?: boolean | undefined;
  error?: ImportError | undefined;
}

export interface ImportJobItem {
  id: string;
  jobId: string;
  sourceKey: SourceKey;
  remoteWorkId: string;
  remoteChapterId: string;
  jobStatusKey: string;
  sourceChapterKey: string;
  canonicalChapterUrl: string;
  title: string;
  remoteVolumeId: string;
  remoteVolumeTitle: string;
  sequence: number;
  remoteUpdatedAt?: string | undefined;
  status: ImportJobItemStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  contentHash?: string | undefined;
  lastError?: ImportError | undefined;
}

export interface ImportedChapterContent {
  chapterId: string;
  content: string;
  lastModified: string;
}

/** Local-only export format; it is deliberately separate from Gist synchronization. */
export interface ImportLibraryBackup {
  version: 1;
  exportedAt: string;
  books: Novel[];
  chapterContents: ImportedChapterContent[];
  jobs: ImportJob[];
  jobItems: ImportJobItem[];
}

export type ImportFetchKind = 'metadata' | 'toc' | 'chapter';

export interface ImportFetchRequest {
  sourceKey: SourceKey;
  kind: ImportFetchKind;
  url: string;
  jobId?: string | undefined;
  maxProviderCostMicros?: number | undefined;
  providerCostMicrosUsed?: number | undefined;
}

export type ImportFetchProvider =
  | 'direct'
  | 'scrape-do'
  | 'scrapingant'
  | 'zenrows'
  | 'zyte';

export interface ImportFetchResponse {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  byteLength: number;
}

export type ImportFetchResult =
  | {
      ok: true;
      response: ImportFetchResponse;
      provider?: ImportFetchProvider | undefined;
      attempts?: number | undefined;
      providerCreditsUsed?: number | undefined;
      costMicros?: number | undefined;
    }
  | {
      ok: false;
      error: ImportError;
      provider?: ImportFetchProvider | undefined;
      attempts?: number | undefined;
      providerCreditsUsed?: number | undefined;
      costMicros?: number | undefined;
    };

export interface CreateImportJobRequest {
  url: string;
  mode: 'preview' | 'import' | 'refresh';
  idempotencyKey: string;
  selectedRemoteChapterIds?: string[] | undefined;
  /** Kakuyomu is enabled only for an acknowledged private-use import. */
  privateUseAcknowledged?: boolean | undefined;
  /** Zero keeps managed provider calls disabled for this job. */
  maxProviderCostMicros?: number | undefined;
}

export const ACTIVE_IMPORT_JOB_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  'queued',
  'discovering',
  'fetching',
  'applying',
]);

export const INTERRUPTED_IMPORT_JOB_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  'discovering',
  'fetching',
  'applying',
]);

export function isTerminalImportJobStatus(status: ImportJobStatus): boolean {
  return !ACTIVE_IMPORT_JOB_STATUSES.has(status);
}
