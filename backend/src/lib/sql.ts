/** Kucuk SQL yardimcilari (kismi UPDATE ve sayfalama). */

/**
 * `UPDATE` icin SET ifadesi uretir. `undefined` degerler atlanir.
 *   const { clause, values } = buildUpdate({ name: 'A', role: undefined });
 *   // clause: 'name = $1'
 */
export function buildUpdate(
  columns: Record<string, unknown>,
  startIndex = 1,
): { clause: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  let i = startIndex;
  for (const [col, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    parts.push(`${col} = $${i++}`);
    values.push(value);
  }
  return { clause: parts.join(', '), values };
}

export interface PageParams {
  limit: number;
  offset: number;
}

export function normalizePage(query: { limit?: unknown; offset?: unknown }): PageParams {
  const rawLimit = Number(query.limit ?? 50);
  const rawOffset = Number(query.offset ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  return { limit, offset };
}

/** IN ($1, $2, ...) ifadesi uretir; bos dizi icin guvenli yer tutucu doner. */
export function inClause(values: readonly unknown[], startIndex = 1): { clause: string; values: unknown[] } {
  if (values.length === 0) return { clause: '(NULL)', values: [] };
  const placeholders = values.map((_, i) => `$${startIndex + i}`).join(', ');
  return { clause: `(${placeholders})`, values: [...values] };
}
