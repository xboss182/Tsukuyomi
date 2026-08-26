import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

export type DatabaseBackup = {
  path: string;
  sha256: string;
  integrityCheck: 'ok';
  createdAt: string;
};

function checksum(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function verifyIntegrity(database: Database): void {
  const result = database.query('PRAGMA integrity_check').get() as { integrity_check?: unknown } | null;
  if (result?.integrity_check !== 'ok') throw new Error('SQLite 完整性校验失败');
}

async function atomicWrite(path: string, contents: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Bun 1.4 has no online-backup API. `serialize()` produces a consistent SQLite
 * image from the open connection, which is atomically installed after integrity
 * verification. Upgrade to SQLite's backup API when Bun exposes it.
 */
export async function createDatabaseBackup(database: Database, path: string): Promise<DatabaseBackup> {
  database.exec('PRAGMA wal_checkpoint(FULL)');
  verifyIntegrity(database);
  const image = database.serialize();
  await atomicWrite(path, image);

  const verified = new Database(path, { readonly: true });
  try {
    verifyIntegrity(verified);
  } finally {
    verified.close();
  }
  return { path, sha256: checksum(image), integrityCheck: 'ok', createdAt: new Date().toISOString() };
}

/** Validates a SQLite backup before atomically placing an offline restore candidate. */
export async function restoreDatabaseBackup(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new Database(sourcePath, { readonly: true });
  try {
    verifyIntegrity(source);
    await atomicWrite(destinationPath, await readFile(sourcePath));
  } finally {
    source.close();
  }
  const verified = new Database(destinationPath, { readonly: true });
  try {
    verifyIntegrity(verified);
  } finally {
    verified.close();
  }
}

async function main(): Promise<void> {
  const databasePath = process.env.TSUKUYOMI_DATABASE_PATH;
  const backupPath = process.env.TSUKUYOMI_BACKUP_PATH;
  if (!databasePath || !backupPath) throw new Error('TSUKUYOMI_DATABASE_PATH 和 TSUKUYOMI_BACKUP_PATH 必须配置');
  const database = new Database(databasePath);
  try {
    const backup = await createDatabaseBackup(database, backupPath);
    console.log(JSON.stringify({ path: backup.path, sha256: backup.sha256, integrityCheck: backup.integrityCheck }));
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '备份失败');
    process.exitCode = 1;
  });
}
