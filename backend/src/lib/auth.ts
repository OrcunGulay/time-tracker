/**
 * Kimlik dogrulama katmani.
 *
 * Iki yontem desteklenir:
 *  1) Authorization: Bearer <JWT>  -> dashboard ve interactive agent
 *  2) x-agent-key: tt_xxx          -> silent/headless agent (OS boot servisi)
 *
 * Root Fastify instance uzerinde cagrilir; boylece decorator'lar tum route
 * scope'larinda gorunur olur (encapsulation sorunu yasanmaz).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { sha256 } from './crypto.js';
import { forbidden, unauthorized } from './errors.js';
import { JwtError, verifyJwt, type JwtClaims } from './jwt.js';
import * as userRepo from '../repositories/user.repo.js';
import type { AuthContext } from '../types/fastify.js';
import type { UserRole } from '../types/api.js';

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('authUser', null);

  const resolveFromJwt = async (request: FastifyRequest): Promise<AuthContext | null> => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token) return null;

    let claims: JwtClaims;
    try {
      claims = verifyJwt(token, config.jwt.accessSecret);
    } catch (err) {
      throw unauthorized(err instanceof JwtError ? err.message : 'Gecersiz token');
    }
    const user = await userRepo.findById(claims.sub);
    if (!user || !user.isActive) throw unauthorized('Kullanici bulunamadi veya pasif');
    return toContext(user);
  };

  const resolveFromAgentKey = async (request: FastifyRequest): Promise<AuthContext | null> => {
    const raw = request.headers['x-agent-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key) return null;
    const user = await userRepo.findByAgentApiKeyHash(sha256(key));
    if (!user) throw unauthorized('Gecersiz agent API anahtari');
    request.authenticatedByAgentKey = true;
    return toContext(user);
  };

  const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (request.authUser) return;
    const ctx = (await resolveFromAgentKey(request)) ?? (await resolveFromJwt(request));
    if (!ctx) throw unauthorized('Authorization basligi veya x-agent-key gerekli');
    request.authUser = ctx;
  };

  app.decorate('authenticate', authenticate);
  app.decorate(
    'requireRole',
    (...roles: UserRole[]) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        await authenticate(request, reply);
        const role = request.authUser?.role;
        if (!role || !roles.includes(role)) {
          throw forbidden(`Bu uc nokta icin roller: ${roles.join(', ')}`);
        }
      },
  );
}

type UserRecordLike = Awaited<ReturnType<typeof userRepo.findById>>;

function toContext(user: NonNullable<UserRecordLike>): AuthContext {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
    timezone: user.timezone,
    hourlyRate: user.hourlyRate,
    currency: user.currency,
  };
}

/** Route handler'larda tekrar eden kontrol. */
export function currentUser(request: FastifyRequest): AuthContext {
  if (!request.authUser) throw unauthorized();
  return request.authUser;
}

/** Agent yalnizca kendi oturumu uzerinde islem yapabilir. */
export function assertSelfOrAdmin(request: FastifyRequest, userId: string): void {
  const user = currentUser(request);
  if (user.id !== userId && user.role !== 'admin') {
    throw forbidden('Yalnizca kendi kayitlariniz uzerinde islem yapabilirsiniz');
  }
}
