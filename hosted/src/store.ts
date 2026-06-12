// store.ts — D1 persistence for users (Gmail accounts + OAuth tokens) and sessions.
// Thin, hand-rolled queries; no ORM. All timestamps are epoch ms.

export interface User {
  sub: string;
  email: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: number | null;
  cutoff: string | null;
  created_at: number;
}

export class Store {
  constructor(private db: D1Database) {}

  async getUser(sub: string): Promise<User | null> {
    return await this.db.prepare('SELECT * FROM users WHERE sub = ?').bind(sub).first<User>();
  }

  // Upsert on sign-in. Keeps an existing refresh_token when Google omits one on a
  // repeat consent (Google only returns it on the first authorization / forced consent),
  // and preserves the original onboarding cutoff so it isn't reset on every login.
  async upsertUser(u: {
    sub: string; email: string; access_token: string; refresh_token: string | null;
    token_expiry: number; cutoff: string; now: number;
  }): Promise<void> {
    await this.db.prepare(
      `INSERT INTO users (sub, email, access_token, refresh_token, token_expiry, cutoff, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET
         email        = excluded.email,
         access_token = excluded.access_token,
         token_expiry = excluded.token_expiry,
         refresh_token = COALESCE(excluded.refresh_token, users.refresh_token)`,
    ).bind(u.sub, u.email, u.access_token, u.refresh_token, u.token_expiry, u.cutoff, u.now).run();
  }

  async updateTokens(sub: string, accessToken: string, expiry: number): Promise<void> {
    await this.db.prepare('UPDATE users SET access_token = ?, token_expiry = ? WHERE sub = ?')
      .bind(accessToken, expiry, sub).run();
  }

  // --- sessions ---

  async createSession(id: string, sub: string, expiresAt: number, now: number): Promise<void> {
    await this.db.prepare('INSERT INTO sessions (id, sub, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, sub, expiresAt, now).run();
  }

  // Returns the owning user iff the session exists and hasn't expired.
  async getSessionUser(id: string, now: number): Promise<User | null> {
    const row = await this.db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.sub = s.sub
       WHERE s.id = ? AND s.expires_at > ?`,
    ).bind(id, now).first<User>();
    return row || null;
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  }

  // Opportunistic cleanup of expired rows (called on login; cheap).
  async pruneSessions(now: number): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  }
}
