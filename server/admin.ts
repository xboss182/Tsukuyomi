import { stdin as input, stderr as output } from 'node:process';
import packageJson from '../package.json';
import { createServerApplication } from './app';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

async function readPassword(prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error('管理员密码命令只能在交互终端运行');
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          reject(new Error('管理员密码输入已取消'));
          return;
        }
        if (character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'set-password' && command !== 'reset-password') {
    throw new Error('用法: bun server/admin.ts <set-password|reset-password>');
  }
  const application = createServerApplication({
    databasePath: requiredEnvironment('TSUKUYOMI_DATABASE_PATH'),
    version: packageJson.version,
    commit: process.env.TSUKUYOMI_COMMIT ?? 'unknown',
  });
  const password = await readPassword('管理员密码: ');
  try {
    if (command === 'set-password') await application.auth.setInitialPassword(password);
    else await application.auth.resetPassword(password);
  } finally {
    application.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '管理员命令失败');
  process.exitCode = 1;
});
