import { isElectron } from 'src/utils/platform';
import { provideNovelImport, injectNovelImport } from 'src/composables/novel-import/useNovelImport';
import { provideWebNovelImport, injectWebNovelImport } from 'src/composables/web-app/useWebApp';
import type { NovelImportContext } from 'src/composables/novel-import/useNovelImport';
import type { WebNovelImportContext } from 'src/composables/web-app/useWebApp';

/**
 * Runtime-agnostic novel import context.
 *
 * Returns the existing Electron/local context when available, otherwise the
 * web-server context. Components can keep using `useNovelImport()`; only the
 * root browser entry needs to provide the web variant first.
 */
export function provideAdaptiveNovelImport():
  | NovelImportContext
  | WebNovelImportContext {
  if (isElectron()) {
    return provideNovelImport();
  }
  return provideWebNovelImport();
}

export function injectAdaptiveNovelImport():
  | NovelImportContext
  | WebNovelImportContext
  | null {
  return isElectron() ? injectNovelImport() : injectWebNovelImport();
}
