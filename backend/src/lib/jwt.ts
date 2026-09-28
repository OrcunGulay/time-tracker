/**
 * Bagimliliksiz HS256 JWT.
 *
 * Neden kendi implementasyonu? Erisim tokeni icin tek bir algoritma (HS256)
 * yeterlidir ve disari bagimlilik olmadan test edilebilir kalir. Yenileme
 * tokeni JWT degildir; opak rastgele bir dizedir (bkz. lib/crypto.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtClaims extends Record<string, unknown> {
  sub: string;
  role: string;
  email: string;
  iat: number;
  exp: number;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}

export function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const claims: Record<string, unknown> = {
    ...payload,
    iat: issuedAt,
    exp: issuedAt + Math.max(1, Math.floor(ttlSeconds)),
  };
  const head = base64urlJson(HEADER);
  const body = base64urlJson(claims);
  const signature = hmac(`${head}.${body}`, secret);
  return `${head}.${body}.${signature}`;
}

/** Token gecerliyse claim'leri, degilse JwtError firlatir. */
export function verifyJwt<T extends JwtClaims = JwtClaims>(
  token: string,
  secret: string,
  now: Date = new Date(),
): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('Gecersiz token formati');
  const [head, body, signature] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('Token basligi okunamadi');
  }
  if (header.alg !== 'HS256') throw new JwtError('Desteklenmeyen imza algoritmasi');

  const expected = hmac(`${head}.${body}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new JwtError('Imza dogrulanamadi');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('Token govdesi okunamadi');
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
    throw new JwtError('Token suresi dolmus');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 30) {
    throw new JwtError('Token henuz gecerli degil');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new JwtError('Token konusu (sub) eksik');
  }
  return claims as T;
}

/** Token'i dogrulamadan claim'lerini okur (yalnizca loglama/teshis icin). */
export function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 && parts.length !== 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
