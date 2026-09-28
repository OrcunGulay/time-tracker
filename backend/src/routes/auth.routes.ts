/** /api/auth - oturum acma, token yenileme, agent API anahtari yonetimi. */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { generateAgentApiKey, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { signJwt } from '../lib/jwt.js';
import { currentUser } from '../lib/auth.js';
import * as auditRepo from '../repositories/misc.repo.js';
import * as userRepo from '../repositories/user.repo.js';
import type { AuthUser, LoginResponse } from '../types/api.js';

const loginBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

const refreshBody = {
  type: 'object',
  required: ['refreshToken'],
  additionalProperties: false,
  properties: { refreshToken: { type: 'string', minLength: 10 } },
} as const;

function toAuthUser(user: NonNullable<Awaited<ReturnType<typeof userRepo.findById>>>): AuthUser {
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

/** Yenileme tokeni: opak rastgele dize, DB'de tuzlanmis hash olarak tutulur. */
function hashRefreshToken(token: string): string {
  return sha256(`${token}${config.jwt.refreshSecret}`);
}

export async function issueTokens(
  user: NonNullable<Awaited<ReturnType<typeof userRepo.findById>>>,
  userAgent?: string,
): Promise<LoginResponse> {
  const accessToken = signJwt(
    { sub: user.id, role: user.role, email: user.email },
    config.jwt.accessSecret,
    config.jwt.accessTtl,
  );
  const refreshToken = randomToken(32);
  await auditRepo.storeRefreshToken({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(Date.now() + config.jwt.refreshTtl * 1000),
    userAgent,
  });
  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.accessTtl,
    user: toAuthUser(user),
  };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', { schema: { body: loginBody } }, async (request) => {
    const { email, password } = request.body as { email: string; password: string };
    const user = await userRepo.findByEmail(email);
    // Zamanlama saldirilarini zorlastirmak icin ayni hata mesaji
    if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized('E-posta veya parola hatali');
    }
    const tokens = await issueTokens(user, request.headers['user-agent']);
    await userRepo.touchLastSeen(user.id);
    await auditRepo.insertAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ipAddress: request.ip,
    });
    return tokens;
  });

  app.post('/refresh', { schema: { body: refreshBody } }, async (request) => {
    const { refreshToken } = request.body as { refreshToken: string };
    const hash = hashRefreshToken(refreshToken);
    const stored = await auditRepo.findValidRefreshToken(hash);
    if (!stored) throw unauthorized('Yenileme tokeni gecersiz veya suresi dolmus');
    const user = await userRepo.findById(stored.userId);
    if (!user || !user.isActive) throw unauthorized('Kullanici bulunamadi');

    // Rotasyon: eski token iptal edilir
    await auditRepo.revokeRefreshToken(hash);
    return issueTokens(user, request.headers['user-agent']);
  });

  app.post('/logout', { schema: { body: refreshBody } }, async (request) => {
    const { refreshToken } = request.body as { refreshToken: string };
    await auditRepo.revokeRefreshToken(hashRefreshToken(refreshToken));
    return { ok: true };
  });

  app.get('/me', { preHandler: app.authenticate }, async (request) => {
    const user = currentUser(request);
    return { user };
  });

  // ------------------------------------------------------------ agent API key
  app.post(
    '/agent-key',
    { preHandler: app.authenticate },
    async (request) => {
      const user = currentUser(request);
      const apiKey = generateAgentApiKey();
      await userRepo.setAgentApiKeyHash(user.id, sha256(apiKey));
      await auditRepo.insertAudit({
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.agent_key.created',
        entityType: 'user',
        entityId: user.id,
        ipAddress: request.ip,
      });
      // Ham anahtar yalnizca bu yanitta gosterilir, tekrar elde edilemez.
      return { apiKey, warning: 'Bu anahtar bir daha gosterilmeyecek. Guvenli saklayin.' };
    },
  );

  app.delete('/agent-key', { preHandler: app.authenticate }, async (request) => {
    const user = currentUser(request);
    await userRepo.setAgentApiKeyHash(user.id, null);
    return { ok: true };
  });

  // Parola degistirme (kendi hesabi)
  app.post(
    '/change-password',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: {
            currentPassword: { type: 'string', minLength: 1 },
            newPassword: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      const me = currentUser(request);
      const { currentPassword, newPassword } = request.body as {
        currentPassword: string;
        newPassword: string;
      };
      const user = await userRepo.findById(me.id);
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
        throw badRequest('Mevcut parola hatali');
      }
      const { hashPassword } = await import('../lib/crypto.js');
      await userRepo.updateUser(me.id, { passwordHash: await hashPassword(newPassword) });
      // Tum yenileme tokenlari iptal edilir
      await auditRepo.revokeAllUserTokens(me.id);
      return { ok: true };
    },
  );
}
