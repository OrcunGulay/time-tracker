/**
 * Zaman cizelgesi (timeline) uretimi - saf fonksiyonlar.
 *
 * Gunu esit dilimlere boler ve her dilimi active | idle | unproductive |
 * deducted | offline olarak isaretler. Dashboard bunlari yesil/sari/kirmizi
 * olarak cizer.
 */
import type { ProductivityCategory, TimelineSlice } from '../types/api.js';

export interface TimelineSample {
  timestamp: Date;
  isIdle: boolean;
  category: ProductivityCategory;
  activeApp: string | null;
  windowTitle: string | null;
  url: string | null;
  domain: string | null;
  durationSeconds: number;
  /** Silinen ekran goruntusu nedeniyle mesai disi birakilmis blok mu? */
  deducted?: boolean;
}

export interface BuildTimelineOptions {
  samples: readonly TimelineSample[];
  rangeStart: Date;
  rangeEnd: Date;
  /** Dilim buyuklugu (dakika). Varsayilan 5. */
  slotMinutes?: number;
}

interface SlotAccumulator {
  totalSeconds: number;
  idleSeconds: number;
  categorySeconds: Record<ProductivityCategory, number>;
  deducted: boolean;
  appCounts: Map<string, number>;
  windowCounts: Map<string, number>;
  domainCounts: Map<string, number>;
  urlCounts: Map<string, number>;
}

function emptyAcc(): SlotAccumulator {
  return {
    totalSeconds: 0,
    idleSeconds: 0,
    categorySeconds: { PRODUCTIVE: 0, UNPRODUCTIVE: 0, NEUTRAL: 0 },
    deducted: false,
    appCounts: new Map(),
    windowCounts: new Map(),
    domainCounts: new Map(),
    urlCounts: new Map(),
  };
}

function topOf(map: Map<string, number>): string | null {
  let bestKey: string | null = null;
  let bestVal = -1;
  for (const [key, val] of map) {
    if (val > bestVal) {
      bestKey = key;
      bestVal = val;
    }
  }
  return bestKey;
}

export function buildTimeline(opts: BuildTimelineOptions): TimelineSlice[] {
  const slotMinutes = Math.max(1, opts.slotMinutes ?? 5);
  const slotMs = slotMinutes * 60_000;
  const startMs = opts.rangeStart.getTime();
  const endMs = opts.rangeEnd.getTime();
  const slotCount = Math.max(1, Math.ceil((endMs - startMs) / slotMs));

  const slots: SlotAccumulator[] = Array.from({ length: slotCount }, emptyAcc);

  for (const sample of opts.samples) {
    const t = sample.timestamp.getTime();
    if (t < startMs || t >= endMs) continue;
    const idx = Math.min(slotCount - 1, Math.floor((t - startMs) / slotMs));
    const slot = slots[idx];
    if (!slot) continue;

    slot.totalSeconds += sample.durationSeconds;
    if (sample.deducted) slot.deducted = true;
    if (sample.isIdle) slot.idleSeconds += sample.durationSeconds;
    else slot.categorySeconds[sample.category] += sample.durationSeconds;

    const bump = (map: Map<string, number>, key: string | null) => {
      if (key) map.set(key, (map.get(key) ?? 0) + sample.durationSeconds);
    };
    bump(slot.appCounts, sample.activeApp);
    bump(slot.windowCounts, sample.windowTitle);
    bump(slot.domainCounts, sample.domain);
    bump(slot.urlCounts, sample.url);
  }

  return slots.map((slot, i) => {
    const slotStart = new Date(startMs + i * slotMs);
    const slotEnd = new Date(Math.min(endMs, startMs + (i + 1) * slotMs));

    const { PRODUCTIVE: p, UNPRODUCTIVE: u } = slot.categorySeconds;
    const dominant: ProductivityCategory = u > p ? 'UNPRODUCTIVE' : 'PRODUCTIVE';

    let state: TimelineSlice['state'];
    if (slot.totalSeconds <= 0) state = 'offline';
    else if (slot.deducted) state = 'deducted';
    else if (slot.idleSeconds >= slot.totalSeconds * 0.5) state = 'idle';
    else if (dominant === 'UNPRODUCTIVE') state = 'unproductive';
    else state = 'active';

    return {
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      minutes: Math.round((slotEnd.getTime() - slotStart.getTime()) / 60_000),
      state,
      activeApp: topOf(slot.appCounts),
      windowTitle: topOf(slot.windowCounts),
      url: topOf(slot.urlCounts),
      domain: topOf(slot.domainCounts),
      category: slot.totalSeconds <= 0 ? 'NEUTRAL' : dominant,
    };
  });
}

/** Timeline ozeti: dashboard ust kartlari icin. */
export function summarizeTimeline(slices: readonly TimelineSlice[]): {
  activeMinutes: number;
  idleMinutes: number;
  unproductiveMinutes: number;
  deductedMinutes: number;
  offlineMinutes: number;
} {
  const acc = { activeMinutes: 0, idleMinutes: 0, unproductiveMinutes: 0, deductedMinutes: 0, offlineMinutes: 0 };
  for (const s of slices) {
    switch (s.state) {
      case 'active': acc.activeMinutes += s.minutes; break;
      case 'idle': acc.idleMinutes += s.minutes; break;
      case 'unproductive': acc.unproductiveMinutes += s.minutes; break;
      case 'deducted': acc.deductedMinutes += s.minutes; break;
      case 'offline': acc.offlineMinutes += s.minutes; break;
    }
  }
  return acc;
}
