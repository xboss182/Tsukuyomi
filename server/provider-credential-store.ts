import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  currentPeriod,
  isManagedProvider,
  isUsableCredential,
  providerCredentialFields,
  validateProviderCredentialInput,
  type ManagedProvider,
  type ProviderCredentialInput,
  type ProviderCredentialSummary,
  type UsableProviderCredential,
} from '../src/services/importer/provider-credentials';
import type { ProviderCredentialStore } from '../src/services/importer/provider-gateway';
import { EncryptedSecretStore } from './secret-store';
import type { DataKey } from './secret-store';
import { inTransaction, listStored } from './state-document-store';

const NAMESPACE = 'import-provider-credentials';

type StoredCredential = ProviderCredentialSummary & { authorizedForUse: true; secretId: string };

function parseStoredCredential(value: string): StoredCredential {
  let record: Partial<StoredCredential>;
  try {
    record = JSON.parse(value) as Partial<StoredCredential>;
  } catch {
    throw new Error('服务商凭据记录损坏');
  }
  if (
    typeof record.id !== 'string' ||
    !isManagedProvider(record.provider) ||
    typeof record.secretId !== 'string' ||
    record.authorizedForUse !== true
  ) {
    throw new Error('服务商凭据记录损坏');
  }
  return record as StoredCredential;
}

export class SQLiteProviderCredentialStore implements ProviderCredentialStore {
  private readonly secrets: EncryptedSecretStore;
  private readonly secretKind = 'import-provider';

  constructor(
    private readonly database: Database,
    dataKey: DataKey,
  ) {
    this.secrets = new EncryptedSecretStore(database, dataKey);
  }

  async upsert(input: ProviderCredentialInput): Promise<ProviderCredentialSummary> {
    await Promise.resolve();
    validateProviderCredentialInput(input);
    const records = this.records();
    const existing = input.id ? records.find((record) => record.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('服务商凭据不存在');
    const id = existing?.id ?? randomUUID();
    const record: StoredCredential = {
      id,
      ...providerCredentialFields(input, existing),
      authorizedForUse: true,
      secretId: existing?.secretId ?? `provider:${id}`,
    };
    const updated = existing ? records.map((item) => (item.id === record.id ? record : item)) : [...records, record];
    inTransaction(this.database, () => {
      this.secrets.put(record.secretId, this.secretKind, input.secret.trim());
      this.writeRecords(updated);
    });
    return this.summary(record);
  }

  async remove(id: string): Promise<void> {
    await Promise.resolve();
    const records = this.records();
    const removed = records.find((record) => record.id === id);
    inTransaction(this.database, () => {
      if (removed) this.secrets.delete(removed.secretId, this.secretKind);
      this.writeRecords(records.filter((record) => record.id !== id));
    });
  }

  async list(): Promise<ProviderCredentialSummary[]> {
    await Promise.resolve();
    this.resetPeriodIfNeeded();
    return this.records().map((record) => this.summary(record));
  }

  async usable(provider: ManagedProvider): Promise<UsableProviderCredential[]> {
    await Promise.resolve();
    this.resetPeriodIfNeeded();
    return this.records()
      .filter((record) => isUsableCredential(record, provider))
      .flatMap((record) => {
        const secret = this.secrets.get(record.secretId, this.secretKind);
        return secret ? [{ ...this.summary(record), secret }] : [];
      });
  }

  async recordCost(id: string, costMicros: number): Promise<void> {
    await Promise.resolve();
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new Error('服务商费用无效');
    this.resetPeriodIfNeeded();
    if (costMicros === 0) return;
    this.persist(
      this.records().map((record) =>
        record.id === id ? { ...record, monthlyCostMicrosUsed: record.monthlyCostMicrosUsed + costMicros } : record,
      ),
    );
  }

  async disable(id: string): Promise<void> {
    await Promise.resolve();
    this.persist(this.records().map((record) => (record.id === id ? { ...record, enabled: false } : record)));
  }

  private records(): StoredCredential[] {
    return listStored(this.database, NAMESPACE, parseStoredCredential);
  }

  private persist(records: StoredCredential[]): void {
    inTransaction(this.database, () => this.writeRecords(records));
  }

  private writeRecords(records: StoredCredential[]): void {
    this.database.query('DELETE FROM state_documents WHERE namespace = ?').run(NAMESPACE);
    const statement = this.database.query(
      'INSERT INTO state_documents (namespace, document_key, body_json, revision, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const timestamp = new Date().toISOString();
    for (const record of records) {
      statement.run(NAMESPACE, record.id, JSON.stringify(record), 1, timestamp);
    }
  }

  private resetPeriodIfNeeded(): void {
    const period = currentPeriod();
    const records = this.records();
    if (!records.some((record) => record.costPeriod !== period)) return;
    this.persist(records.map((record) => ({ ...record, costPeriod: period, monthlyCostMicrosUsed: 0 })));
  }

  private summary(record: StoredCredential): ProviderCredentialSummary {
    const { authorizedForUse: _authorizedForUse, secretId: _secretId, ...summary } = record;
    return summary;
  }
}
