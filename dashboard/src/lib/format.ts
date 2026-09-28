/** Sure/tarih bicimlendirme yardimcilari. */

export function formatDuration(seconds: number | null | undefined): string {
  const value = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours}sa ${String(minutes).padStart(2, '0')}dk`;
  if (minutes > 0) return `${minutes}dk`;
  return `${value}sn`;
}

export function formatHours(seconds: number | null | undefined): string {
  return `${((seconds ?? 0) / 3600).toFixed(2)} sa`;
}

export function formatMinutes(seconds: number | null | undefined): string {
  return `${Math.round((seconds ?? 0) / 60)} dk`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const diff = Math.round((Date.now() - date.getTime()) / 1000);
  if (diff < 5) return 'az once';
  if (diff < 60) return `${diff} sn once`;
  if (diff < 3600) return `${Math.floor(diff / 60)} dk once`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa once`;
  return `${Math.floor(diff / 86400)} gun once`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatScore(score: number | null | undefined): string {
  return `${(score ?? 0).toFixed(1)}%`;
}

export function formatMoney(amount: number, currency = 'TRY'): string {
  try {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(amount ?? 0);
  } catch {
    return `${(amount ?? 0).toFixed(2)} ${currency}`;
  }
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function monthStartIso(): string {
  return `${todayIso().slice(0, 7)}-01`;
}

export function weekStartIso(): string {
  const date = new Date();
  const day = (date.getDay() + 6) % 7; // Pazartesi = 0
  date.setDate(date.getDate() - day);
  return date.toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const STATUS_LABEL: Record<string, string> = {
  active: 'Cevrimici',
  idle: 'Bosta',
  offline: 'Cevrimdisi',
  approved: 'Onaylandi',
  rejected: 'Reddedildi',
  stopped: 'Onay bekliyor',
};

export const CATEGORY_LABEL: Record<string, string> = {
  PRODUCTIVE: 'Uretken',
  UNPRODUCTIVE: 'Uretken degil',
  NEUTRAL: 'Notr',
};

export const TIMELINE_STATE_LABEL: Record<string, string> = {
  active: 'Calisiyor',
  idle: 'Bosta',
  unproductive: 'Uretken degil',
  deducted: 'Silinen blok',
  offline: 'Cevrimdisi',
};
