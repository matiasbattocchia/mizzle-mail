// oauth.ts — Google OAuth 2.0 Authorization-Code flow + token refresh, plumbed
// over fetch (no googleapis SDK; it doesn't run on Workers). Also: cookie signing.
//
// Scope is a single restricted scope, gmail.modify, which covers everything Mizzle
// does: read messages + bodies, modify labels (star / read / mizzle/sent), trash,
// archive, and send. Plus openid+email to identify the account. An unverified app
// shows Google's "unverified" warning and caps at 100 users — fine for friends.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'email',
].join(' ');

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  OAUTH_REDIRECT: string;
  SEED_DAYS?: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;        // seconds
  id_token?: string;
}

// Build the consent-screen URL. access_type=offline + prompt=consent ensures we get
// a refresh_token (Google only hands one out with explicit consent).
export function authUrl(env: Env, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.OAUTH_REDIRECT,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export async function exchangeCode(env: Env, code: string): Promise<Tokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.OAUTH_REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<Tokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function getUserInfo(accessToken: string): Promise<{ sub: string; email: string }> {
  const res = await fetch(USERINFO_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  const j: any = await res.json();
  return { sub: String(j.sub), email: String(j.email || '').toLowerCase() };
}

// --- signed cookies (HMAC-SHA256) -------------------------------------------
// The session id is opaque and server-side validated, but we still sign the cookie
// so a tampered/forged id is rejected before any D1 lookup.

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sign(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return `${value}.${b64url(sig)}`;
}

export async function unsign(signed: string, secret: string): Promise<string | null> {
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = await sign(value, secret);
  // constant-time-ish compare
  if (expected.length !== signed.length) return null;
  let diff = 0;
  for (let j = 0; j < expected.length; j++) diff |= expected.charCodeAt(j) ^ signed.charCodeAt(j);
  return diff === 0 ? value : null;
}
