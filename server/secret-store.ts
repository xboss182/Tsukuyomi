import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class DataKey {
  private constructor(readonly bytes: Buffer) {}

  static parse(value: string): DataKey {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(value, 'base64');
    } catch {
      throw new Error('TSUKUYOMI_DATA_KEY 无效');
    }
    if (bytes.length !== KEY_BYTES || bytes.toString('base64') !== value) {
      throw new Error('TSUKUYOMI_DATA_KEY 必须是 32 字节 base64 值');
    }
    return new DataKey(bytes);
  }
}

export class EncryptedSecretStore {
  constructor(
    private readonly database: Database,
    private readonly dataKey: DataKey,
  ) {}

  put(id: string, kind: string, value: string): void {
    if (!id || !kind || !value) throw new Error('加密密钥记录无效');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey.bytes, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const timestamp = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO encrypted_secrets (id, kind, ciphertext, nonce, auth_tag, key_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           auth_tag = excluded.auth_tag,
           key_version = excluded.key_version,
           updated_at = excluded.updated_at`,
      )
      .run(id, kind, ciphertext, nonce, authTag, timestamp, timestamp);
  }

  get(id: string, kind: string): string | undefined {
    const row = this.database
      .query('SELECT ciphertext, nonce, auth_tag, key_version FROM encrypted_secrets WHERE id = ? AND kind = ?')
      .get(id, kind) as
      | { ciphertext: Uint8Array; nonce: Uint8Array; auth_tag: Uint8Array; key_version: number }
      | null;
    if (!row) return undefined;
    if (row.key_version !== 1 || row.nonce.length !== NONCE_BYTES || row.auth_tag.length !== TAG_BYTES) {
      throw new Error('加密密钥记录无效');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.dataKey.bytes, row.nonce);
      decipher.setAuthTag(Buffer.from(row.auth_tag));
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('加密密钥无法解密');
    }
  }

  delete(id: string, kind: string): void {
    this.database.query('DELETE FROM encrypted_secrets WHERE id = ? AND kind = ?').run(id, kind);
  }
}
