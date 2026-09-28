/**
 * Kategori kurallarini onbellekle servis eder.
 * Telemetri akisi her ornek icin kural tablosunu okumasin diye 60 sn TTL'li
 * in-memory cache kullanilir; kural degisikliginde cache temizlenir.
 */
import * as categoryRepo from '../repositories/category.repo.js';
import {
  categorize,
  computeProductivityScore,
  extractDomain,
  type CategoryRule,
  type CategorizeInput,
  type ProductivityParts,
} from './productivity.service.js';
import type { ProductivityCategory } from '../types/api.js';

const TTL_MS = 60_000;
let cache: { rules: CategoryRule[]; loadedAt: number } | null = null;

export async function getRules(force = false): Promise<CategoryRule[]> {
  const now = Date.now();
  if (!force && cache && now - cache.loadedAt < TTL_MS) return cache.rules;
  const rules = await categoryRepo.listRules({ activeOnly: true });
  cache = { rules, loadedAt: now };
  return rules;
}

export function invalidateCache(): void {
  cache = null;
}

export async function classify(input: CategorizeInput): Promise<ProductivityCategory> {
  const rules = await getRules();
  return categorize(input, rules);
}

/** Toplu siniflandirma: ayni istekte tek kural okumasi yapar. */
export async function classifyMany(
  inputs: readonly CategorizeInput[],
): Promise<ProductivityCategory[]> {
  const rules = await getRules();
  return inputs.map((input) => categorize(input, rules));
}

export function score(parts: ProductivityParts, neutralWeight: number): number {
  return computeProductivityScore(parts, neutralWeight);
}

export { extractDomain };
