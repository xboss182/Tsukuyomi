import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import packageJson from '../package.json';
import { createServerApplication } from './app';
import { DataKey } from './secret-store';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function port(): number {
  const value = Number(process.env.PORT ?? '3010');
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error('PORT 无效');
  return value;
}

async function main(): Promise<void> {
  const host = process.env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('HOST 只能绑定回环地址');
  const databasePath = requiredEnvironment('TSUKUYOMI_DATABASE_PATH');
  const publicOrigin = requiredEnvironment('TSUKUYOMI_ORIGIN');
  const dataKey = DataKey.parse(requiredEnvironment('TSUKUYOMI_DATA_KEY'));
  if (new URL(publicOrigin).protocol !== 'https:') throw new Error('TSUKUYOMI_ORIGIN 必须使用 HTTPS');
  const application = createServerApplication({
    databasePath,
    version: packageJson.version,
    commit: process.env.TSUKUYOMI_COMMIT ?? 'unknown',
    publicOrigin,
    dataKey,
  });
  await application.initialize();
  const server = Bun.serve({ hostname: host, port: port(), fetch: application.fetch });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.stop();
    await application.shutdown();
  };
  const signal = () => {
    void shutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '服务器启动失败');
    process.exitCode = 1;
  });
}

export { main };
export const serverDirectory = dirname(fileURLToPath(import.meta.url));
