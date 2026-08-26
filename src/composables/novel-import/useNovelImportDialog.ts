import { isElectron } from 'src/utils/platform';
import { injectNovelImport, type NovelImportContext } from './useNovelImport';
import { injectWebNovelImport } from 'src/composables/web-app/useWebApp';

/**
 * Dialog-safe accessor for the runtime's novel import context.
 *
 * Electron builds use the local IndexedDB/import-job-service implementation;
 * browser builds use the HTTP/SSE web implementation. Both expose the same
 * public shape, so dialog components can stay runtime-agnostic.
 */
export function injectNovelImportDialog(): NovelImportContext {
  if (isElectron()) {
    return injectNovelImport();
  }
  const ctx = injectWebNovelImport();
  if (!ctx) throw new Error('injectNovelImportDialog() called outside a provider');
  return ctx as NovelImportContext;
}
