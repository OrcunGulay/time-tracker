/**
 * Oturum (mesai) yasam dongusu.
 *
 * Sunucu otoritesi: sureler her zaman activity_logs uzerinden yeniden
 * hesaplanir; agent'in bildirdigi sureler dogrudan guvenilmez.
 */
import { config } from '../config.js';
import { conflict, notFound, forbidden } from '../lib/errors.js';
import * as activityRepo from '../repositories/activity.repo.js';
import * as sessionRepo from '../repositories/session.repo.js';
import * as projectRepo from '../repositories/project.repo.js';
import type { Requester } from '../lib/scope.js';
import type { SessionDto } from '../types/api.js';
import type { SessionRecord } from '../repositories/session.repo.js';

export function toDto(s: SessionRecord): SessionDto {
  // Odenebilir sure: toplam - bosluk - silinen blok + "calisilmis say" kredisi
  const payable = Math.max(
    0,
    s.totalDuration - s.idleDuration - s.deductedSeconds + s.creditedSeconds,
  );
  return {
    id: s.id,
    userId: s.userId,
    projectId: s.projectId,
    taskId: s.taskId,
    startTime: s.startTime.toISOString(),
    endTime: s.endTime ? s.endTime.toISOString() : null,
    totalDuration: s.totalDuration,
    idleDuration: s.idleDuration,
    productiveSeconds: s.productiveSeconds,
    unproductiveSeconds: s.unproductiveSeconds,
    neutralSeconds: s.neutralSeconds,
    deductedSeconds: s.deductedSeconds,
    creditedSeconds: s.creditedSeconds,
    status: s.status,
    billableSeconds: payable,
    payableSeconds: payable,
  };
}

/** Oturumun toplamlarini aktivite loglarindan yeniden hesaplar. */
export async function recomputeTotals(
  sessionId: string,
  opts: { touchEndTime?: boolean } = {},
): Promise<SessionRecord | null> {
  const agg = await activityRepo.aggregateBySession(sessionId);

  const patch: Parameters<typeof sessionRepo.updateTotals>[1] = {
    totalDuration: agg.totalSeconds,
    idleDuration: agg.idleSeconds,
    productiveSeconds: agg.productiveSeconds,
    unproductiveSeconds: agg.unproductiveSeconds,
    neutralSeconds: agg.neutralSeconds,
  };

  // ONEMLI: end_time yalnizca acik oturumlarda guncellenir. Durdurulmus bir
  // oturumun bitis zamani (offline kuyruk sonradan bosaltildiginda) silinmemelidir.
  if (opts.touchEndTime !== false && agg.lastAt) {
    patch.endTime = new Date(agg.lastAt.getTime() + 30_000); // son ornegin pencere sonu
  }

  return sessionRepo.updateTotals(sessionId, patch);
}

export async function startSession(
  user: Requester & { id: string },
  input: {
    projectId?: string | null;
    taskId?: string | null;
    clientStartedAt?: string | null;
    clientInfo?: Record<string, unknown>;
  },
): Promise<SessionDto> {
  const existing = await sessionRepo.findActiveByUser(user.id);
  if (existing) {
    // Coklu cihaz/tekrar gonderim korumasi: mevcut oturum varsa onu dondur.
    return toDto(existing);
  }

  if (input.taskId) {
    const task = await projectRepo.findTaskById(input.taskId);
    if (!task) throw notFound('Gorev bulunamadi');
    if (input.projectId && task.projectId !== input.projectId) {
      throw conflict('Gorev secilen projeye ait degil');
    }
  }
  if (input.projectId) {
    const project = await projectRepo.findProjectById(input.projectId);
    if (!project) throw notFound('Proje bulunamadi');
  }

  const startTime = new Date();
  const record = await sessionRepo.startSession({
    userId: user.id,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    startTime,
    clientStartedAt: input.clientStartedAt ? new Date(input.clientStartedAt) : startTime,
    clientInfo: input.clientInfo,
  });
  return toDto(record);
}

export async function stopSession(
  session: SessionRecord,
  endedAt: Date = new Date(),
): Promise<SessionDto> {
  const agg = await activityRepo.aggregateBySession(session.id);
  const effectiveEnd =
    agg.lastAt && agg.lastAt.getTime() + 30_000 > endedAt.getTime()
      ? new Date(agg.lastAt.getTime() + 30_000)
      : endedAt;

  const record = await sessionRepo.stopSession(session.id, effectiveEnd, {
    totalDuration: agg.totalSeconds,
    idleDuration: agg.idleSeconds,
    productiveSeconds: agg.productiveSeconds,
    unproductiveSeconds: agg.unproductiveSeconds,
    neutralSeconds: agg.neutralSeconds,
  });
  if (!record) throw notFound('Oturum bulunamadi');
  return toDto(record);
}

export async function requireSessionForUser(
  sessionId: string,
  userId: string,
): Promise<SessionRecord> {
  const session = await sessionRepo.findById(sessionId);
  if (!session) throw notFound('Oturum bulunamadi');
  if (session.userId !== userId) throw forbidden('Bu oturum size ait degil');
  return session;
}

export async function getActiveSession(userId: string): Promise<SessionDto | null> {
  const active = await sessionRepo.findActiveByUser(userId);
  return active ? toDto(active) : null;
}

/**
 * Heartbeat'te cagrilir: sureler periyodik olarak guncellenir ve
 * sunucu tarafi idle tespiti yapilir.
 */
export async function refreshLiveSession(sessionId: string): Promise<SessionRecord | null> {
  return recomputeTotals(sessionId, { touchEndTime: false });
}

export interface IdleCheck {
  isIdle: boolean;
  idleSeconds: number;
}

/** Son ornege gore sunucu tarafi bosluk tespiti. */
export async function evaluateIdle(sessionId: string, now = new Date()): Promise<IdleCheck> {
  const recent = await activityRepo.recentSamples(sessionId, 1);
  const last = recent[0];
  if (!last) return { isIdle: false, idleSeconds: 0 };
  const idleSeconds = Math.max(0, Math.round((now.getTime() - last.timestamp.getTime()) / 1000));
  if (last.isIdle && last.idleSeconds > idleSeconds) {
    return { isIdle: true, idleSeconds: last.idleSeconds };
  }
  return {
    isIdle: idleSeconds >= config.rules.idleThresholdSeconds,
    idleSeconds,
  };
}

/**
 * Uretken olmayan icerikte gecirilen kesintisiz sure (saniye).
 * Agent 60 saniyeyi asarsa "Hala calisiyor musunuz?" uyarisi gosterir.
 */
export async function tailUnproductiveSeconds(sessionId: string, lookback = 40): Promise<number> {
  const recent = await activityRepo.recentSamples(sessionId, lookback);
  let total = 0;
  let previousTs: Date | null = null;
  for (const sample of recent) {
    if (sample.isIdle || sample.category !== 'UNPRODUCTIVE') break;
    // Ornekler arasi buyuk bosluk zinciri kirar
    if (previousTs && previousTs.getTime() - sample.timestamp.getTime() > 120_000) break;
    total += sample.durationSeconds || 0;
    previousTs = sample.timestamp;
  }
  return total;
}
