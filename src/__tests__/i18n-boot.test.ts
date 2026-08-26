import { describe, expect, it, mock } from 'bun:test';

const use = mock();
let boot: (context: { app: { use: typeof use } }) => void;

mock.module('#q-app/wrappers', () => ({
  defineBoot: (callback: typeof boot) => {
    boot = callback;
    return callback;
  },
}));

mock.module('vue-i18n', () => ({
  createI18n: (options: { locale: string; fallbackLocale: string }) => options,
}));

await import('../boot/i18n');

describe('i18n boot', () => {
  it('defaults new installations to English', () => {
    boot({ app: { use } });
    expect(use).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'en-US',
      fallbackLocale: 'en-US',
    }));
  });
});
