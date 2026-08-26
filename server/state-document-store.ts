import type { Database } from 'bun:sqlite';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${field} 无效`);
  }
  return value.trim();
}

export function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} 无效`);
  }
  return value as number;
}

export function parseStored<T extends { id: string; secretId: string }>(value: string, message: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(message);
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.secretId !== 'string') {
    throw new Error(message);
  }
  return parsed as T;
}

export function listStored<T>(database: Database, namespace: string, parse: (value: string) => T): T[] {
  return (database
    .query("SELECT body_json FROM state_documents WHERE namespace = ? ORDER BY document_key")
    .all(namespace) as Array<{ body_json: string }>)
    .map((row) => parse(row.body_json));
}

export function getStored<T>(database: Database, namespace: string, id: string, parse: (value: string) => T): T | undefined {
  const row = database
    .query("SELECT body_json FROM state_documents WHERE namespace = ? AND document_key = ?")
    .get(namespace, id) as { body_json: string } | null;
  return row ? parse(row.body_json) : undefined;
}

export function putStored(
  database: Database,
  namespace: string,
  id: string,
  value: unknown,
  updatedAt: string,
): void {
  database
    .query(
      `INSERT INTO state_documents (namespace, document_key, body_json, revision, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(namespace, document_key) DO UPDATE SET
         body_json = excluded.body_json,
         revision = state_documents.revision + 1,
         updated_at = excluded.updated_at`,
    )
    .run(namespace, id, JSON.stringify(value), updatedAt);
}

export function inTransaction(database: Database, operation: () => void): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    operation();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
