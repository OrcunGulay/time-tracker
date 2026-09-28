/**
 * Rol bazli veri kapsami.
 *  - admin   : tum kullanicilar
 *  - manager : kendi departmani (+ kendisi)
 *  - employee: yalnizca kendisi
 */
import { forbidden } from './errors.js';
import * as userRepo from '../repositories/user.repo.js';
import type { AuthUser } from '../types/api.js';

export interface Requester {
  id: string;
  role: AuthUser['role'];
  department: string | null;
}

/** Istek sahibinin gorebilecegi kullanici id'leri. */
export async function resolveVisibleUserIds(requester: Requester): Promise<string[] | 'all'> {
  if (requester.role === 'admin') return 'all';
  if (requester.role === 'manager') {
    const { items } = await userRepo.listUsers(
      { department: requester.department ?? undefined, activeOnly: true },
      { limit: 500, offset: 0 },
    );
    const ids = new Set(items.map((u) => u.id));
    ids.add(requester.id);
    return [...ids];
  }
  return [requester.id];
}

/** Istenen kullaniciyi gorme yetkisi var mi? */
export async function assertCanAccessUser(
  requester: Requester,
  targetUserId: string,
): Promise<void> {
  if (requester.id === targetUserId) return;
  if (requester.role === 'admin') return;
  if (requester.role === 'manager') {
    const target = await userRepo.findById(targetUserId);
    if (target && target.department === requester.department) return;
  }
  throw forbidden('Bu kullanicinin verisine erisemezsiniz');
}

/** Raporlama icin filtre parametrelerini cozer. */
export async function resolveReportScope(
  requester: Requester,
  requestedUserId?: string | null,
): Promise<{ userIds: string[] | 'all'; singleUserId: string | null }> {
  if (requestedUserId) {
    await assertCanAccessUser(requester, requestedUserId);
    return { userIds: [requestedUserId], singleUserId: requestedUserId };
  }
  const visible = await resolveVisibleUserIds(requester);
  return { userIds: visible, singleUserId: visible === 'all' ? null : (visible[0] ?? null) };
}
