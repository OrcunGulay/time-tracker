/**
 * Uretkenlik (Productivity) Motoru - saf fonksiyonlar.
 *
 * Kural tablosu uzerinden her uygulama/domain icin PRODUCTIVE | UNPRODUCTIVE |
 * NEUTRAL etiketi uretir ve agirlikli uretkenlik yuzdesini hesaplar.
 * Veritabani erisimi yoktur; bu nedenle dogrudan test edilebilir.
 */
import type { ProductivityCategory } from '../types/api.js';

export interface CategoryRule {
  id: string;
  matchType: 'app' | 'domain';
  pattern: string;
  category: ProductivityCategory;
  department: string | null;
  projectId: string | null;
  priority: number;
  isActive: boolean;
}

export interface CategorizeInput {
  activeApp?: string | null;
  url?: string | null;
  domain?: string | null;
  /** Etiketlemede kullanilacak calisanin departmani (varsa). */
  department?: string | null;
  /** Oturumun bagli oldugu proje (varsa). */
  projectId?: string | null;
}

export interface ProductivityParts {
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
}

export const DEFAULT_CATEGORY: ProductivityCategory = 'NEUTRAL';

/** 'C:\\Program Files\\Google\\Chrome\\chrome.exe' -> 'chrome' */
export function normalizeAppName(app: string | null | undefined): string | null {
  if (!app) return null;
  const base = app.split(/[\\/]/).pop() ?? app;
  return base
    .replace(/\.(exe|app|bin)$/i, '')
    .trim()
    .toLowerCase() || null;
}

/** 'https://www.youtube.com/watch?v=x' -> 'youtube.com' */
export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let candidate = url.trim();
  if (!candidate) return null;
  try {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      // Semasiz girdi: ya domain ya da pencere basligi icindeki URL
      const embedded = /([a-z0-9-]+(\.[a-z0-9-]+)+)(\/|$)/i.exec(candidate);
      if (!embedded) return null;
      candidate = `https://${embedded[1]}`;
    }
    const host = new URL(candidate).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Wildcard (*) destekli basit glob -> regex. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesPattern(value: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.includes('*')) return globToRegex(p).test(value);
  // Alt alan adlari da eslesir: 'github.com' -> 'gist.github.com'
  return value === p || value.endsWith(`.${p}`);
}

/**
 * Kural onceligi: proje > departman > global, sonra kucuk `priority` degeri,
 * sonra kural id'si (deterministik).
 */
function specificity(rule: CategoryRule, input: CategorizeInput): number {
  let score = 0;
  if (rule.projectId && input.projectId && rule.projectId === input.projectId) score += 4;
  if (rule.department && input.department && rule.department === input.department) score += 2;
  return score;
}

function isApplicable(rule: CategoryRule, input: CategorizeInput): boolean {
  if (!rule.isActive) return false;
  if (rule.department && rule.department !== (input.department ?? null)) return false;
  if (rule.projectId && rule.projectId !== (input.projectId ?? null)) return false;
  return true;
}

/** Eslesen en ozgul kurali dondurur (yoksa null). */
export function matchRule(input: CategorizeInput, rules: readonly CategoryRule[]): CategoryRule | null {
  const app = normalizeAppName(input.activeApp);
  const domain = extractDomain(input.domain ?? input.url);

  let best: { rule: CategoryRule; spec: number } | null = null;

  for (const rule of rules) {
    if (!isApplicable(rule, input)) continue;
    const value = rule.matchType === 'app' ? app : domain;
    if (!value) continue;
    if (!matchesPattern(value, rule.pattern)) continue;

    const spec = specificity(rule, input);
    if (
      best === null ||
      spec > best.spec ||
      (spec === best.spec && rule.priority < best.rule.priority) ||
      (spec === best.spec && rule.priority === best.rule.priority && rule.id < best.rule.id)
    ) {
      best = { rule, spec };
    }
  }

  return best?.rule ?? null;
}

/**
 * Domain kurali uygulama kuralindan daha ozgul kabul edilir:
 * Chrome'da youtube.com aciksa 'chrome' (PRODUCTIVE) degil domain kurali kazanir.
 */
export function categorize(input: CategorizeInput, rules: readonly CategoryRule[]): ProductivityCategory {
  const domain = extractDomain(input.domain ?? input.url);
  if (domain) {
    const domainRule = matchRule({ ...input, activeApp: null }, rules);
    if (domainRule) return domainRule.category;
  }
  const appRule = matchRule({ ...input, url: null, domain: null }, rules);
  return appRule?.category ?? DEFAULT_CATEGORY;
}

/**
 * Agirlikli uretkenlik yuzdesi (0-100).
 *   score = (productive + neutral * neutralWeight) / toplam
 * `neutralWeight` 0 ise yalnizca uretken saniyeler sayilir.
 */
export function computeProductivityScore(
  parts: ProductivityParts,
  neutralWeight = 0,
): number {
  const { productiveSeconds: p, unproductiveSeconds: u, neutralSeconds: n } = parts;
  const total = p + u + n;
  if (total <= 0) return 0;
  const weight = Math.min(1, Math.max(0, neutralWeight));
  const score = ((p + n * weight) / total) * 100;
  return Math.round(score * 10) / 10;
}

/** Aktivite orneklerini saniyeye cevirir (agent pencere suresini bildirmezse). */
export function sampleDurationSeconds(sample: { durationSeconds?: number }, sampleIntervalSeconds = 20): number {
  const d = sample.durationSeconds;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return Math.min(d, 3600);
  return sampleIntervalSeconds;
}

/** Idle esigi asildi mi? (saniye) */
export function isIdleBreached(idleSeconds: number, thresholdSeconds: number): boolean {
  return idleSeconds >= thresholdSeconds;
}
