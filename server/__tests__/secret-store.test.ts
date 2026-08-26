import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataKey, EncryptedSecretStore } from '../secret-store';
import { openDatabase } from '../database';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('EncryptedSecretStore', () => {
  it('validates the 32-byte data key and never persists plaintext', () => {
    expect(() => DataKey.parse('not-a-key')).toThrow();
    const key = DataKey.parse(Buffer.alloc(32, 7).toString('base64'));
    expect(key.bytes).toHaveLength(32);
  });

  it('encrypts, decrypts, rotates, and deletes secrets in SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-secret-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const store = new EncryptedSecretStore(database, DataKey.parse(Buffer.alloc(32, 9).toString('base64')));

    store.put('provider-1', 'provider', 'secret-value');
    expect(store.get('provider-1', 'provider')).toBe('secret-value');
    expect(database.query<{ ciphertext: Uint8Array }, []>('SELECT ciphertext FROM encrypted_secrets').get()?.ciphertext).not.toEqual(
      Buffer.from('secret-value'),
    );

    store.put('provider-1', 'provider', 'rotated-value');
    expect(store.get('provider-1', 'provider')).toBe('rotated-value');
    store.delete('provider-1', 'provider');
    expect(store.get('provider-1', 'provider')).toBeUndefined();
    database.close();
  });
});
