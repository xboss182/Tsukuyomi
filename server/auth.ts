import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;

export class AuthServiceError extends Error {
  constructor(
    readonly code: 'not_authenticated' | 'rate_limited',
    readonly status: 401 | 429,
    readonly retryAfterMs?: number,
  ) {
    super(code === 'rate_limited' ? '登录尝试过多，请稍后重试' : '用户名或密码错误');
  }
}

export type AuthSession = {
  token: string;
  csrfToken: string;
  expiresAt: string;
};

export type AuthClock = {
  now: () => number;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function equalHash(left: string, right: string): boolean {
  const leftValue = Buffer.from(left, 'hex');
  const rightValue = Buffer.from(right, 'hex');
  return leftValue.length === rightValue.length && timingSafeEqual(leftValue, rightValue);
}

function asDate(value: string): number {
  return Date.parse(value);
}

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly clock: AuthClock = { now: Date.now },
  ) {}

  hasAccount(): boolean {
    return this.database.query('SELECT 1 FROM auth_account WHERE id = 1').get() !== null;
  }

  async setInitialPassword(password: string): Promise<void> {
    const hash = await this.passwordHash(password);
    const result = this.database
      .query('INSERT OR IGNORE INTO auth_account (id, password_hash, updated_at) VALUES (1, ?, ?)')
      .run(hash, new Date(this.clock.now()).toISOString());
    if (result.changes !== 1) throw new Error('管理员密码已设置');
  }

  async resetPassword(password: string): Promise<void> {
    const hash = await this.passwordHash(password);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.storePasswordHash(hash);
      this.database.exec('DELETE FROM sessions');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const account = this.database
      .query('SELECT password_hash FROM auth_account WHERE id = 1')
      .get() as { password_hash: string } | null;
    if (!account || !(await Bun.password.verify(currentPassword, account.password_hash))) {
      throw new AuthServiceError('not_authenticated', 401);
    }
    await this.resetPassword(nextPassword);
  }

  async login(password: string): Promise<AuthSession> {
    const now = this.clock.now();
    const throttle = this.database
      .query('SELECT window_started_at, failed_attempts, locked_until FROM login_throttle WHERE id = 1')
      .get() as
      | { window_started_at: string; failed_attempts: number; locked_until: string | null }
      | null;
    const lockedUntil = throttle?.locked_until ? asDate(throttle.locked_until) : 0;
    if (lockedUntil > now) {
      throw new AuthServiceError('rate_limited', 429, lockedUntil - now);
    }

    const account = this.database
      .query('SELECT password_hash FROM auth_account WHERE id = 1')
      .get() as { password_hash: string } | null;
    const valid = account ? await Bun.password.verify(password, account.password_hash) : false;
    if (!valid) {
      this.recordFailedLogin(now, throttle);
      const updated = this.database
        .query('SELECT locked_until FROM login_throttle WHERE id = 1')
        .get() as { locked_until: string | null } | null;
      const retryAt = updated?.locked_until ? asDate(updated.locked_until) : 0;
      if (retryAt > now) throw new AuthServiceError('rate_limited', 429, retryAt - now);
      throw new AuthServiceError('not_authenticated', 401);
    }

    this.database.exec('DELETE FROM login_throttle');
    const value = token();
    const csrfToken = token();
    const expiresAt = new Date(now + SESSION_DURATION_MS).toISOString();
    this.database
      .query('INSERT INTO sessions (token_hash, csrf_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(value), sha256(csrfToken), expiresAt, new Date(now).toISOString());
    return { token: value, csrfToken, expiresAt };
  }

  verifySession(value: string | undefined): Promise<{ expiresAt: string } | null> {
    if (!value) return Promise.resolve(null);
    const session = this.database
      .query('SELECT expires_at, revoked_at FROM sessions WHERE token_hash = ?')
      .get(sha256(value)) as { expires_at: string; revoked_at: string | null } | null;
    if (!session || session.revoked_at || asDate(session.expires_at) <= this.clock.now()) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ expiresAt: session.expires_at });
  }

  verifyCsrf(sessionToken: string | undefined, csrfToken: string | undefined): boolean {
    if (!sessionToken || !csrfToken) return false;
    const session = this.database
      .query('SELECT csrf_hash, expires_at, revoked_at FROM sessions WHERE token_hash = ?')
      .get(sha256(sessionToken)) as
      | { csrf_hash: string; expires_at: string; revoked_at: string | null }
      | null;
    return Boolean(
      session &&
        !session.revoked_at &&
        asDate(session.expires_at) > this.clock.now() &&
        equalHash(session.csrf_hash, sha256(csrfToken)),
    );
  }

  revokeSession(value: string | undefined): Promise<void> {
    if (!value) return Promise.resolve();
    this.database
      .query('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(new Date(this.clock.now()).toISOString(), sha256(value));
    return Promise.resolve();
  }

  private async replacePassword(password: string): Promise<void> {
    this.storePasswordHash(await this.passwordHash(password));
  }

  private async passwordHash(password: string): Promise<string> {
    if (password.length < 12 || password.length > 1024) {
      throw new Error('管理员密码长度必须在 12 到 1024 个字符之间');
    }
    return await Bun.password.hash(password, { algorithm: 'argon2id' });
  }

  private storePasswordHash(hash: string): void {
    this.database
      .query(
        `INSERT INTO auth_account (id, password_hash, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      )
      .run(hash, new Date(this.clock.now()).toISOString());
  }

  private recordFailedLogin(
    now: number,
    existing: { window_started_at: string; failed_attempts: number; locked_until: string | null } | null,
  ): void {
    const withinWindow = existing && now - asDate(existing.window_started_at) < LOGIN_WINDOW_MS;
    const attempts = (withinWindow ? existing.failed_attempts : 0) + 1;
    const lockedUntil = attempts >= MAX_FAILED_LOGINS ? new Date(now + LOGIN_LOCK_MS).toISOString() : null;
    this.database
      .query(
        `INSERT INTO login_throttle (id, window_started_at, failed_attempts, locked_until)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           failed_attempts = excluded.failed_attempts,
           locked_until = excluded.locked_until`,
      )
      .run(new Date(now).toISOString(), withinWindow ? attempts : 1, lockedUntil);
  }
}

export const sessionCookieName = '__Host-tsukuyomi_session';
export const csrfCookieName = '__Host-tsukuyomi_csrf';
export const sessionDurationSeconds = SESSION_DURATION_MS / 1000;
