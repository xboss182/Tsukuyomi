import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../auth';
import { openDatabase } from '../database';

const paths: string[] = [];

async function createAuth() {
  const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-auth-'));
  paths.push(directory);
  const database = openDatabase(join(directory, 'app.sqlite3'));
  let now = Date.parse('2026-08-26T00:00:00.000Z');
  const auth = new AuthService(database, { now: () => now });
  await auth.setInitialPassword('correct horse battery staple');
  return {
    auth,
    database,
    advance: (minutes: number) => {
      now += minutes * 60_000;
    },
  };
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('AuthService', () => {
  it('allows exactly one concurrent initial password bootstrap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tsukuyomi-auth-'));
    paths.push(directory);
    const database = openDatabase(join(directory, 'app.sqlite3'));
    const auth = new AuthService(database);

    const results = await Promise.allSettled([
      auth.setInitialPassword('first correct horse battery staple'),
      auth.setInitialPassword('second correct horse battery staple'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    database.close();
  });

  it('stores only token hashes and validates the CSRF value bound to a session', async () => {
    const { auth, database } = await createAuth();
    const session = await auth.login('correct horse battery staple');

    expect(await auth.verifySession(session.token)).toMatchObject({ expiresAt: session.expiresAt });
    expect(auth.verifyCsrf(session.token, session.csrfToken)).toBe(true);
    expect(auth.verifyCsrf(session.token, 'wrong')).toBe(false);
    expect(database.query<{ token_hash: string }, []>('SELECT token_hash FROM sessions').get()?.token_hash).not.toBe(
      session.token,
    );
  });

  it('uses generic failures and locks after five failed account-level attempts', async () => {
    const { auth, advance } = await createAuth();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await (expect(auth.login('wrong password')).rejects.toMatchObject({
        code: 'not_authenticated',
        status: 401,
      }) as unknown as Promise<void>);
    }
    await (expect(auth.login('wrong password')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterMs: 15 * 60_000,
    }) as unknown as Promise<void>);
    await (expect(auth.login('correct horse battery staple')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    }) as unknown as Promise<void>);

    advance(15);
    await (expect(auth.login('correct horse battery staple')).resolves.toMatchObject({
      token: expect.any(String),
    }) as unknown as Promise<void>);
  });

  it('requires the current password and revokes all sessions when changing it', async () => {
    const { auth } = await createAuth();
    const session = await auth.login('correct horse battery staple');

    await (expect(
      auth.changePassword('wrong current password', 'next correct horse battery staple'),
    ).rejects.toMatchObject({ code: 'not_authenticated' }) as unknown as Promise<void>);
    await auth.changePassword('correct horse battery staple', 'next correct horse battery staple');

    expect(await auth.verifySession(session.token)).toBeNull();
    await (expect(auth.login('correct horse battery staple')).rejects.toMatchObject({
      code: 'not_authenticated',
    }) as unknown as Promise<void>);
    await (expect(auth.login('next correct horse battery staple')).resolves.toMatchObject({
      token: expect.any(String),
    }) as unknown as Promise<void>);
  });
});
