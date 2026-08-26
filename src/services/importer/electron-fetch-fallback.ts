import type { ImportFetchRequest, ImportFetchResult } from 'src/models/importer';

/**
 * Electron IPC fetch fallback for the browser transport layer.
 *
 * When `window.electronAPI` is available, import jobs can ask the main process
 * to perform the network fetch. This keeps the browser build functional as a
 * regular web app while letting the Electron build retain any proxy / request
 * signing logic that lives in the main process.
 */
export function createElectronFetchFallback(): (
  request: ImportFetchRequest,
) => Promise<ImportFetchResult> {
  return async (request: ImportFetchRequest) => {
    const api = (window as unknown as { electronAPI?: { importFetch?: (request: ImportFetchRequest) => Promise<ImportFetchResult> } }).electronAPI;
    if (!api?.importFetch) {
      return {
        ok: false,
        error: {
          code: 'electron_unavailable',
          message: 'Electron IPC fetch not available',
          retryable: false,
        },
      };
    }
    return api.importFetch(request);
  };
}
