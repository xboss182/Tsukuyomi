import type { Database } from 'bun:sqlite';
import { isIpLiteralHost } from '../src/services/importer/address-policy';
import { EncryptedSecretStore } from './secret-store';
import type { DataKey } from './secret-store';
import {
  getStored,
  inTransaction,
  isRecord,
  listStored,
  parseStored as parseStoredDocument,
  putStored,
  requireInteger,
  requireString,
} from './state-document-store';

const NAMESPACE = 'ai-models';
const TASK_NAMES = ['translation', 'proofreading', 'termsTranslation', 'assistant'] as const;
const RESERVED_HEADER_PARTS = ['authorization', 'cookie', 'token', 'key', 'secret', 'credential'];
const RESERVED_HEADER_NAMES = new Set(['accept', 'connection', 'content-length', 'content-type', 'host', 'transfer-encoding']);

type AiProvider = 'openai' | 'gemini';
type TaskDefaults = Record<(typeof TASK_NAMES)[number], { enabled: boolean; temperature: number }>;

export type ServerModelInput = {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  temperature: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  rateLimit?: number;
  apiKey?: string;
  baseUrl: string;
  isDefault: TaskDefaults;
  customHeaders?: Record<string, string>;
  enabled: boolean;
  lastEdited: string;
  hasApiKey?: boolean;
  useCorsProxy?: boolean;
};

export type ServerModelSummary = Omit<ServerModelInput, 'apiKey' | 'useCorsProxy'> & { hasApiKey: boolean };
type StoredServerModel = Omit<ServerModelSummary, 'hasApiKey'> & { secretId: string };

function requireTemperature(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error(`${field} 无效`);
  }
  return value;
}

function validateBaseUrl(provider: AiProvider, value: unknown): string {
  if (provider === 'gemini') return '';
  const raw = requireString(value, '模型基础地址');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('模型基础地址无效');
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
    throw new Error('模型基础地址无效');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

function validateDefaults(value: unknown): TaskDefaults {
  if (!isRecord(value)) throw new Error('默认任务配置无效');
  const result = {} as TaskDefaults;
  for (const name of TASK_NAMES) {
    const task = value[name];
    if (!isRecord(task) || typeof task.enabled !== 'boolean') {
      throw new Error('默认任务配置无效');
    }
    result[name] = { enabled: task.enabled, temperature: requireTemperature(task.temperature, '任务温度') };
  }
  return result;
}

function validateHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 20) throw new Error('自定义请求头无效');
  const result: Record<string, string> = {};
  for (const [name, content] of Object.entries(value)) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
      RESERVED_HEADER_NAMES.has(name.toLowerCase()) ||
      RESERVED_HEADER_PARTS.some((part) => normalized.includes(part)) ||
      typeof content !== 'string' ||
      content.length > 2_048 ||
      /[\r\n]/.test(content)
    ) {
      throw new Error('自定义请求头无效');
    }
    result[name] = content;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseStored(value: string): StoredServerModel {
  return parseStoredDocument<StoredServerModel>(value, 'AI 模型记录损坏');
}

export class ServerModelStore {
  private readonly secrets: EncryptedSecretStore;
  private readonly secretKind = 'ai-model';
  private readonly secretIdFor = (id: string): string => `ai-model:${id}`;
  private readonly summarize = (stored: StoredServerModel): ServerModelSummary => ({
    ...stored,
    hasApiKey: this.secrets.get(stored.secretId, this.secretKind) !== undefined,
  });

  constructor(
    private readonly database: Database,
    dataKey: DataKey,
  ) {
    this.secrets = new EncryptedSecretStore(database, dataKey);
  }

  // Model records expose API-key presence and preserve model-specific validation and gateway access.
  // fallow-ignore-next-line code-duplication
  list(): ServerModelSummary[] {
    return listStored(this.database, NAMESPACE, parseStored).map((stored) => this.summarize(stored));
  }

  // Model records expose API-key presence and preserve model-specific validation and gateway access.
  // fallow-ignore-next-line code-duplication
  get(id: string): ServerModelSummary | undefined {
    const stored = getStored(this.database, NAMESPACE, id, parseStored);
    return stored ? this.summarize(stored) : undefined;
  }

  getSecret(id: string): string | undefined {
    const stored = getStored(this.database, NAMESPACE, id, parseStored);
    return stored ? this.secrets.get(stored.secretId, this.secretKind) : undefined;
  }

  getForGateway(id: string): { model: ServerModelSummary; apiKey: string } | undefined {
    const stored = getStored(this.database, NAMESPACE, id, parseStored);
    if (!stored) return undefined;
    const apiKey = this.secrets.get(stored.secretId, this.secretKind);
    return apiKey ? { model: this.summarize(stored), apiKey } : undefined;
  }

  // Model validation includes provider-specific defaults and headers, unlike sync configurations.
  // fallow-ignore-next-line code-duplication
  upsert(value: unknown): ServerModelSummary {
    if (!isRecord(value)) throw new Error('AI 模型无效');
    const existing = typeof value.id === 'string' ? getStored(this.database, NAMESPACE, value.id, parseStored) : undefined;
    const model = this.normalize(value, existing);
    inTransaction(this.database, () => {
      if (model.apiKey !== undefined) this.secrets.put(model.stored.secretId, this.secretKind, model.apiKey);
      putStored(this.database, NAMESPACE, model.stored.id, model.stored, model.stored.lastEdited);
    });
    // fallow-ignore-next-line code-duplication
    return this.summarize(model.stored);
  }

  delete(id: string): void {
    const stored = getStored(this.database, NAMESPACE, id, parseStored);
    if (!stored) return;
    inTransaction(this.database, () => {
      this.secrets.delete(stored.secretId, this.secretKind);
      this.database.query('DELETE FROM state_documents WHERE namespace = ? AND document_key = ?').run(NAMESPACE, id);
    });
  }

  private normalize(value: Record<string, unknown>, existing: StoredServerModel | undefined): { stored: StoredServerModel; apiKey?: string } {
    const provider = value.provider;
    if (provider !== 'openai' && provider !== 'gemini') throw new Error('模型提供商无效');
    const id = requireString(value.id, '模型 ID', 128);
    if (id.includes('\0') || id.includes('/') || id.includes('\\')) throw new Error('模型 ID 无效');
    const apiKey = value.apiKey === undefined ? undefined : requireString(value.apiKey, 'API Key', 4_096);
    if (!existing && !apiKey) throw new Error('API Key 不能为空');
    if (existing && existing.provider !== provider) throw new Error('不能更改模型提供商');
    const rateLimit =
      value.rateLimit === undefined ? undefined : requireInteger(value.rateLimit, '速率限制', 0, 1_000_000);
    const customHeaders = validateHeaders(value.customHeaders);
    const stored: StoredServerModel = {
      id,
      name: requireString(value.name, '模型名称', 256),
      provider,
      model: requireString(value.model, '模型标识', 256),
      temperature: requireTemperature(value.temperature, '模型温度'),
      maxInputTokens: requireInteger(value.maxInputTokens, '最大输入 token', 0, 10_000_000),
      maxOutputTokens: requireInteger(value.maxOutputTokens, '最大输出 token', 0, 10_000_000),
      ...(rateLimit !== undefined ? { rateLimit } : {}),
      baseUrl: validateBaseUrl(provider, value.baseUrl),
      isDefault: validateDefaults(value.isDefault),
      ...(customHeaders !== undefined ? { customHeaders } : {}),
      enabled: value.enabled === true,
      lastEdited: requireString(value.lastEdited, '模型更新时间', 64),
      secretId: existing?.secretId ?? this.secretIdFor(id),
    };
    if (Number.isNaN(Date.parse(stored.lastEdited))) throw new Error('模型更新时间无效');
    return { stored, ...(apiKey ? { apiKey } : {}) };
  }
}

export { validateBaseUrl };
