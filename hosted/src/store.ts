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

  // --- thread cache ---

  // Cached rows for the given threads → Map<threadId, {latestUid, item}>.
  async getCachedThreads(sub: string, threadIds: string[]): Promise<Map<string, { latestUid: string; item: any }>> {
    const out = new Map<string, { latestUid: string; item: any }>();
    if (!threadIds.length) return out;
    // D1 caps bound params at 100/query; chunk to 90 to leave room for `sub`.
    for (let i = 0; i < threadIds.length; i += 90) {
      const chunk = threadIds.slice(i, i + 90);
      const ph = chunk.map(() => '?').join(',');
      const { results = [] } = await this.db
        .prepare(`SELECT thread_id, latest_uid, item_json FROM thread_cache WHERE sub = ? AND thread_id IN (${ph})`)
        .bind(sub, ...chunk).all<{ thread_id: string; latest_uid: string; item_json: string }>();
      for (const r of results) {
        try { out.set(r.thread_id, { latestUid: r.latest_uid, item: JSON.parse(r.item_json) }); } catch { /* skip corrupt */ }
      }
    }
    return out;
  }

  // Upsert rendered items. entries: {threadId, latestUid, item}.
  async putCachedThreads(sub: string, entries: { threadId: string; latestUid: string; item: any }[], now: number): Promise<void> {
    if (!entries.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO thread_cache (sub, thread_id, latest_uid, item_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sub, thread_id) DO UPDATE SET latest_uid = excluded.latest_uid, item_json = excluded.item_json, updated_at = excluded.updated_at`,
    );
    for (let i = 0; i < entries.length; i += 50) {
      const chunk = entries.slice(i, i + 50);
      await this.db.batch(chunk.map((e) => stmt.bind(sub, e.threadId, e.latestUid, JSON.stringify(e.item), now)));
    }
  }

  // Drop cached rows for threads whose flags changed (read/like/share) so the next
  // feed load re-fetches them — simpler and safer than patching the cached JSON.
  async invalidateThreads(sub: string, threadIds: string[]): Promise<void> {
    const ids = threadIds.filter(Boolean);
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 90) { // D1: ≤100 bound params/query
      const chunk = ids.slice(i, i + 90);
      const ph = chunk.map(() => '?').join(',');
      await this.db.prepare(`DELETE FROM thread_cache WHERE sub = ? AND thread_id IN (${ph})`).bind(sub, ...chunk).run();
    }
  }
}
