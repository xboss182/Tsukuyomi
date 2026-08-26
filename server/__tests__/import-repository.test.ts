import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportJobRepository, ImportRepositoryError } from '../import-repository';
import { LibraryRepository } from '../library-repository';
import { openDatabase } from '../database';

const paths: string[] = [];
const workUrl = 'https://kakuyomu.jp/works/822139842947212336';

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-import-'));
  paths.push(directory);
  const database = openDatabase(join(directory, 'app.sqlite3'));
  return new ImportJobRepository(database, new LibraryRepository(database));
}

describe('ImportJobRepository', () => {
  it('enforces idempotency and one active canonical source job with durable events', async () => {
    const repository = await createRepository();
    const first = repository.create({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'first-import',
      privateUseAcknowledged: true,
    });
    const duplicate = repository.create({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'first-import',
      privateUseAcknowledged: true,
    });
    const active = repository.create({
      url: `${workUrl}?campaign=second`,
      mode: 'refresh',
      idempotencyKey: 'second-import',
      privateUseAcknowledged: true,
    });

    expect(duplicate.job.id).toBe(first.job.id);
    expect(active.job.id).toBe(first.job.id);
    expect(repository.list()).toHaveLength(1);
    expect(repository.eventsAfter(first.job.id, 0)).toMatchObject([{ name: 'job' }]);
  });

  it('rejects a Kakuyomu import without the private-use acknowledgement', async () => {
    const repository = await createRepository();

    expect(() =>
      repository.create({ url: workUrl, mode: 'import', idempotencyKey: 'missing-ack' }),
    ).toThrow(ImportRepositoryError);
  });

  it('requeues interrupted jobs and their nonterminal items during recovery', async () => {
    const repository = await createRepository();
    const created = repository.create({
      url: workUrl,
      mode: 'import',
      idempotencyKey: 'recover-import',
      privateUseAcknowledged: true,
    });
    repository.setJobStatus(created.job.id, { status: 'fetching' });

    repository.recoverInterruptedJobs();

    expect(repository.get(created.job.id)?.status).toBe('queued');
    expect(repository.eventsAfter(created.job.id, 0).at(-1)).toMatchObject({ name: 'job' });
  });
});
