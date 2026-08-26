import type { Database } from 'bun:sqlite';
import { isIpLiteralHost } from '../src/services/importer/address-policy';
import { EncryptedSecretStore } from './secret-store';
import type { DataKey } from './secret-store';
import { getStored, inTransaction, isRecord, listStored, parseStored as parseStoredDocument, putStored, requireInteger, requireString } from './state-document-store';

const NAMESPACE = 'sync-configs';
const SECRET_PARAM_PARTS = ['authorization', 'cookie', 'credential', 'key', 'password', 'secret', 'token'];

export type ServerSyncConfigInput = {
  id: string;
  enabled: boolean;
  lastSyncTime: number;
  syncInterval: number;
  syncType: 'gist';
  syncParams: Record<string, string>;
  apiEndpoint: string;
  secret?: string;
  hasSecret?: boolean;
};

export type ServerSyncConfigSummary = Omit<ServerSyncConfigInput, 'secret'> & { hasSecret: boolean };
type StoredSyncConfig = Omit<ServerSyncConfigSummary, 'hasSecret'> & { secretId: string };

function validateEndpoint(value: unknown): string {
  const raw = requireString(value, '同步 API 地址');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('同步 API 地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    isIpLiteralHost(url.hostname)
  ) {
    throw new Error('同步 API 地址无效');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

function validateParams(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 20) throw new Error('同步参数无效');
  const result: Record<string, string> = {};
  for (const [key, content] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(key) ||
      SECRET_PARAM_PARTS.some((part) => normalized.includes(part)) ||
      typeof content !== 'string' ||
      content.length > 2_048
    ) {
      throw new Error('同步参数无效');
    }
    result[key] = content;
  }
  return result;
}

function parseStored(value: string): StoredSyncConfig {
  return parseStoredDocument<StoredSyncConfig>(value, '同步配置记录损坏');
}

export class ServerSyncConfigStore {
  private readonly secrets: EncryptedSecretStore;
  private readonly secretKind = 'sync-config';
  private readonly secretIdFor = (id: string): string => `sync-config:${id}`;
  private readonly summarize = (stored: StoredSyncConfig): ServerSyncConfigSummary => ({
    ...stored,
    hasSecret: this.secrets.get(stored.secretId, this.secretKind) !== undefined,
  });

  constructor(
    private readonly database: Database,
    dataKey: DataKey,
  ) {
    this.secrets = new EncryptedSecretStore(database, dataKey);
  }

  // Sync records expose a different secret and configuration schema from AI models.
  // fallow-ignore-next-line code-duplication
  list(): ServerSyncConfigSummary[] {
    return listStored(this.database, NAMESPACE, parseStored).map((stored) => this.summarize(stored));
  }

  // Sync records expose a different secret and configuration schema from AI models.
  // fallow-ignore-next-line code-duplication
  get(id: string): ServerSyncConfigSummary | undefined {
    const stored = getStored(this.database, NAMESPACE, id, parseStored);
    return stored ? this.summarize(stored) : undefined;
  }

  getSecret(id: string): string | undefined {
    const stored = getStored(this.database, NAMESPACE, id, parseStored);
    return stored ? this.secrets.get(stored.secretId, this.secretKind) : undefined;
  }

  // Sync validation is intentionally local because endpoints and parameters have distinct trust boundaries.
  // fallow-ignore-next-line code-duplication
  upsert(value: unknown): ServerSyncConfigSummary {
    if (!isRecord(value)) throw new Error('同步配置无效');
    const id = requireString(value.id, '同步配置 ID', 128);
    if (id.includes('\0') || id.includes('/') || id.includes('\\')) throw new Error('同步配置 ID 无效');
    const existing = getStored(this.database, NAMESPACE, id, parseStored);
    const secret = value.secret === undefined ? undefined : requireString(value.secret, '同步密钥', 4_096);
    if (!existing && !secret) throw new Error('同步密钥不能为空');
    if (value.syncType !== 'gist') throw new Error('同步类型无效');
    const stored: StoredSyncConfig = {
      id,
      enabled: value.enabled === true,
      lastSyncTime: requireInteger(value.lastSyncTime, '最后同步时间', 0, Number.MAX_SAFE_INTEGER),
      syncInterval: requireInteger(value.syncInterval, '同步间隔', 1_000, 31 * 24 * 60 * 60 * 1000),
      syncType: 'gist',
      syncParams: validateParams(value.syncParams),
      apiEndpoint: validateEndpoint(value.apiEndpoint),
      secretId: existing?.secretId ?? this.secretIdFor(id),
    };
    inTransaction(this.database, () => {
      if (secret !== undefined) this.secrets.put(stored.secretId, this.secretKind, secret);
      putStored(this.database, NAMESPACE, id, stored, new Date().toISOString());
    });
    // fallow-ignore-next-line code-duplication
    return this.summarize(stored);
  }

  delete(id: string): void {
    const stored = getStored(this.database, NAMESPACE, id, parseStored);
    if (!stored) return;
    inTransaction(this.database, () => {
      this.secrets.delete(stored.secretId, this.secretKind);
      this.database.query('DELETE FROM state_documents WHERE namespace = ? AND document_key = ?').run(NAMESPACE, id);
    });
  }
}
