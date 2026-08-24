import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ImportFetchProvider } from '../src/models/importer';

export type ManagedProvider = Exclude<ImportFetchProvider, 'direct'>;

export interface CredentialCrypto {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface ProviderCredentialInput {
  id?: string | undefined;
  provider: ManagedProvider;
  label: string;
  secret: string;
  authorizedForUse: boolean;
  enabled?: boolean | undefined;
  maxConcurrency: number;
  paidPlan?: boolean | undefined;
  paidEnabled?: boolean | undefined;
  monthlyCostLimitMicros?: number | undefined;
}

export interface ProviderCredentialSummary {
  id: string;
  provider: ManagedProvider;
  label: string;
  enabled: boolean;
  maxConcurrency: number;
  paidPlan: boolean;
  paidEnabled: boolean;
  monthlyCostLimitMicros: number;
  monthlyCostMicrosUsed: number;
  costPeriod: string;
}

export interface UsableProviderCredential extends ProviderCredentialSummary {
  secret: string;
}

interface StoredCredential extends ProviderCredentialSummary {
  authorizedForUse: true;
  encryptedSecret: string;
}

interface CredentialFile {
  version: 1;
  credentials: StoredCredential[];
}

const PROVIDERS: ReadonlySet<ManagedProvider> = new Set([
  'scrape-do',
  'scrapingant',
  'zenrows',
  'zyte',
]);

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

function validateInput(input: ProviderCredentialInput): void {
  if (!PROVIDERS.has(input.provider)) throw new Error('不支持的抓取服务商');
  if (!input.label.trim() || !input.secret.trim()) throw new Error('服务商凭据不能为空');
  if (!input.authorizedForUse) throw new Error('必须确认该凭据已获授权使用');
  if (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1) {
    throw new Error('凭据并发限制无效');
  }
  if (input.paidEnabled && !input.paidPlan) throw new Error('免费凭据不能启用付费调用');
}

export class ProviderCredentialVault {
  private loaded = false;
  private credentials: StoredCredential[] = [];

  constructor(
    readonly filePath: string,
    private readonly crypto: CredentialCrypto,
  ) {}

  private ensureEncryption(): void {
    if (!this.crypto.isAvailable()) throw new Error('系统安全存储不可用，服务商凭据功能已禁用');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.ensureEncryption();
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<CredentialFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.credentials)) throw new Error('invalid');
      this.credentials = parsed.credentials.filter(
        (item): item is StoredCredential =>
          Boolean(item) &&
          typeof item.id === 'string' &&
          PROVIDERS.has(item.provider) &&
          typeof item.encryptedSecret === 'string' &&
          item.authorizedForUse === true,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('服务商凭据文件损坏或无法读取');
      }
      this.credentials = [];
    }
    this.loaded = true;
    await this.resetPeriodIfNeeded();
  }

  private async resetPeriodIfNeeded(): Promise<void> {
    const period = currentPeriod();
    let changed = false;
    this.credentials = this.credentials.map((item) => {
      if (item.costPeriod === period) return item;
      changed = true;
      return { ...item, costPeriod: period, monthlyCostMicrosUsed: 0 };
    });
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      temporaryPath,
      JSON.stringify({ version: 1, credentials: this.credentials } satisfies CredentialFile),
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async upsert(input: ProviderCredentialInput): Promise<ProviderCredentialSummary> {
    validateInput(input);
    await this.load();
    const existing = input.id
      ? this.credentials.find((credential) => credential.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error('服务商凭据不存在');
    const credential: StoredCredential = {
      id: existing?.id ?? randomUUID(),
      provider: input.provider,
      label: input.label.trim(),
      enabled: input.enabled !== false,
      maxConcurrency: input.maxConcurrency,
      paidPlan: input.paidPlan === true,
      paidEnabled: input.paidPlan === true && input.paidEnabled === true,
      monthlyCostLimitMicros: nonNegativeInteger(input.monthlyCostLimitMicros, 0),
      monthlyCostMicrosUsed: existing?.monthlyCostMicrosUsed ?? 0,
      costPeriod: existing?.costPeriod ?? currentPeriod(),
      authorizedForUse: true,
      encryptedSecret: this.crypto.encrypt(input.secret.trim()).toString('base64'),
    };
    this.credentials = existing
      ? this.credentials.map((item) => (item.id === credential.id ? credential : item))
      : [...this.credentials, credential];
    await this.persist();
    return this.summary(credential);
  }

  async remove(id: string): Promise<void> {
    await this.load();
    this.credentials = this.credentials.filter((credential) => credential.id !== id);
    await this.persist();
  }

  list(): ProviderCredentialSummary[] {
    if (!this.loaded) return [];
    return this.credentials.map((credential) => this.summary(credential));
  }

  async listLoaded(): Promise<ProviderCredentialSummary[]> {
    await this.load();
    return this.list();
  }

  async usable(provider: ManagedProvider): Promise<UsableProviderCredential[]> {
    await this.load();
    return this.credentials
      .filter(
        (credential) =>
          credential.provider === provider &&
          credential.enabled &&
          (!credential.paidPlan || credential.paidEnabled) &&
          (!credential.paidPlan ||
            credential.monthlyCostMicrosUsed < credential.monthlyCostLimitMicros),
      )
      .map((credential) => ({
        ...this.summary(credential),
        secret: this.crypto.decrypt(Buffer.from(credential.encryptedSecret, 'base64')),
      }));
  }

  async recordCost(id: string, costMicros: number): Promise<void> {
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new Error('服务商费用无效');
    await this.load();
    const credential = this.credentials.find((item) => item.id === id);
    if (!credential || costMicros === 0) return;
    credential.monthlyCostMicrosUsed += costMicros;
    await this.persist();
  }

  async disable(id: string): Promise<void> {
    await this.load();
    const credential = this.credentials.find((item) => item.id === id);
    if (!credential) return;
    credential.enabled = false;
    await this.persist();
  }

  private summary(credential: StoredCredential): ProviderCredentialSummary {
    const { encryptedSecret: _secret, authorizedForUse: _authorized, ...summary } = credential;
    return summary;
  }
}
