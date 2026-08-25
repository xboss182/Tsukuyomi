/**
 * Bounded structured diagnostics for the local single-user Electron deployment.
 *
 * Holds an in-memory ring buffer of sanitized diagnostic entries (no response
 * bodies, credentials, or other secrets) and defines the readiness snapshot
 * surfaced through typed IPC. Shared between the Electron main process
 * (provider gateway / fetch / credential events) and the renderer import queue.
 */

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export type DiagnosticCategory =
  | 'startup'
  | 'recovery'
  | 'fetch'
  | 'provider'
  | 'credentials'
  | 'cooldown'
  | 'budget'
  | 'shutdown';

export interface DiagnosticEntry {
  ts: string;
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  message: string;
}

/** Maximum retained entries; older entries are evicted once the cap is reached. */
const MAX_ENTRIES = 200;

/**
 * Bounded ring buffer of sanitized diagnostic entries.
 *
 * `ponytail:` a fixed-capacity array with a write cursor — simplest structure
 * that bounds memory for a single-user local app. Upgrade to a rolling file
 * appender when retention across restarts is needed.
 */
export class DiagnosticLog {
  private readonly entries: DiagnosticEntry[] = [];
  private readonly capacity: number;

  constructor(capacity = MAX_ENTRIES) {
    this.capacity = Math.max(1, capacity);
  }

  record(level: DiagnosticLevel, category: DiagnosticCategory, message: string): void {
    const entry: DiagnosticEntry = { ts: new Date().toISOString(), level, category, message };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  info(category: DiagnosticCategory, message: string): void {
    this.record('info', category, message);
  }

  warn(category: DiagnosticCategory, message: string): void {
    this.record('warn', category, message);
  }

  error(category: DiagnosticCategory, message: string): void {
    this.record('error', category, message);
  }

  recent(limit = MAX_ENTRIES): DiagnosticEntry[] {
    return this.entries.slice(-Math.max(1, limit));
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}

/** Shared singleton consumed by the Electron main-process IPC surface. */
export const mainProcessDiagnostics = new DiagnosticLog();

/**
 * Main-process readiness snapshot. Each field is a boolean so a consumer can
 * distinguish "runtime ready" (all true) from individual job failures (which
 * live in the renderer's IndexedDB job store and are not visible here).
 */
export interface MainProcessReadiness {
  appReady: boolean;
  safeStorageAvailable: boolean;
  gatewayReady: boolean;
  puppeteerReady: boolean;
  version: string;
  timestamp: string;
  recentEvents: DiagnosticEntry[];
}

/**
 * Renderer-side runtime snapshot for the import queue. `ready` distinguishes
 * queue readiness (worker idle and no interrupted jobs pending recovery) from
 * individual job failures (`failedJobs`), so a caller can tell "the runtime is
 * healthy" apart from "some jobs failed".
 */
export interface ImportQueueRuntimeStatus {
  ready: boolean;
  workerRunning: boolean;
  shuttingDown: boolean;
  activeJobs: number;
  interruptedJobs: number;
  failedJobs: number;
  completedJobs: number;
  totalJobs: number;
}
