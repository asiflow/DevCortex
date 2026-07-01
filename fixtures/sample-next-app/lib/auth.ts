/**
 * Cookie/session-based authentication for the sample app.
 *
 * Session tokens are stateless, signed payloads:
 *
 *   <base64url(JSON payload)>.<hex HMAC-SHA256(payload, SESSION_SECRET)>
 *
 * The full cryptographic verification (`verifySessionToken` / `getSession`)
 * runs server-side (route handlers, server components) where `node:crypto` and
 * `next/headers` are available. `middleware.ts` runs in the Edge runtime and so
 * only performs the cheap, allocation-free structural check `hasValidSessionShape`
 * before deferring real verification to the server — a deliberately layered
 * auth surface that DevCortex should flag as risky.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'sid';

/** Default session lifetime (24h) when `SESSION_MAX_AGE` is not set. */
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;

export interface Session {
  userId: string;
  email: string;
  /** unix epoch seconds */
  issuedAt: number;
  /** unix epoch seconds */
  expiresAt: number;
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('SESSION_SECRET is not configured');
  }
  return secret;
}

/** Configured session lifetime in seconds (read from an undocumented env var). */
export function sessionMaxAgeSeconds(): number {
  const raw = process.env.SESSION_MAX_AGE;
  if (raw === undefined) return DEFAULT_SESSION_MAX_AGE_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_MAX_AGE_SECONDS;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function sign(payloadSegment: string): string {
  return createHmac('sha256', sessionSecret()).update(payloadSegment).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Mint a signed session token for a user. */
export function createSessionToken(userId: string, email: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const session: Session = {
    userId,
    email,
    issuedAt,
    expiresAt: issuedAt + sessionMaxAgeSeconds(),
  };
  const payloadSegment = base64UrlEncode(JSON.stringify(session));
  return `${payloadSegment}.${sign(payloadSegment)}`;
}

/**
 * Cheap, Edge-safe structural validation used by middleware: confirms the token
 * has the expected two-segment shape with non-empty parts. Does NOT verify the
 * signature — that requires the secret and happens server-side.
 */
export function hasValidSessionShape(token: string | undefined): boolean {
  if (token === undefined || token.length === 0) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  return payload !== undefined && payload.length > 0 && signature !== undefined && signature.length > 0;
}

/** Fully verify a session token's signature and expiry. Returns null if invalid. */
export function verifySessionToken(token: string): Session | null {
  if (!hasValidSessionShape(token)) return null;
  const parts = token.split('.');
  const payloadSegment = parts[0];
  const signature = parts[1];
  if (payloadSegment === undefined || signature === undefined) return null;

  if (!constantTimeEquals(signature, sign(payloadSegment))) return null;

  let session: Session;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(payloadSegment));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate['userId'] !== 'string' ||
      typeof candidate['email'] !== 'string' ||
      typeof candidate['issuedAt'] !== 'number' ||
      typeof candidate['expiresAt'] !== 'number'
    ) {
      return null;
    }
    session = {
      userId: candidate['userId'],
      email: candidate['email'],
      issuedAt: candidate['issuedAt'],
      expiresAt: candidate['expiresAt'],
    };
  } catch {
    return null;
  }

  if (session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return session;
}

/** Read and verify the current request's session from the cookie store. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token === undefined) return null;
  return verifySessionToken(token);
}

/** Require an authenticated session; throw when absent. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (session === null) {
    throw new Error('Authentication required');
  }
  return session;
}
