/** category_rules tablosu veri erisimi (urelkenlik motoru kurallari). */
import { query, queryOne } from '../db/pool.js';
import { buildUpdate } from '../lib/sql.js';
import type { CategoryRule } from '../services/productivity.service.js';
import type { CategoryMatchType, ProductivityCategory } from '../types/api.js';

const COLS = `id, match_type AS "matchType", pattern, category, department,
  project_id AS "projectId", priority, is_active AS "isActive", notes,
  created_at AS "createdAt"`;

export type CategoryRuleRecord = CategoryRule & {
  notes: string | null;
  createdAt: Date;
};

export async function listRules(filters: {
  matchType?: CategoryMatchType;
  department?: string | null;
  projectId?: string;
  activeOnly?: boolean;
} = {}): Promise<CategoryRuleRecord[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.activeOnly) where.push('is_active = true');
  if (filters.matchType) { values.push(filters.matchType); where.push(`match_type = $${values.length}`); }
  if (filters.department !== undefined) {
    if (filters.department === null) where.push('department IS NULL');
    else { values.push(filters.department); where.push(`department = $${values.length}`); }
  }
  if (filters.projectId) { values.push(filters.projectId); where.push(`project_id = $${values.length}`); }

  const res = await query<CategoryRuleRecord>(
    `SELECT ${COLS} FROM category_rules
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY match_type, priority ASC, pattern ASC`,
    values,
  );
  return res.rows;
}

export async function findRuleById(id: string): Promise<CategoryRuleRecord | null> {
  return queryOne<CategoryRuleRecord>(`SELECT ${COLS} FROM category_rules WHERE id = $1`, [id]);
}

export async function createRule(input: {
  matchType: CategoryMatchType;
  pattern: string;
  category: ProductivityCategory;
  department?: string | null;
  projectId?: string | null;
  priority?: number;
  notes?: string | null;
  createdBy?: string | null;
}): Promise<CategoryRuleRecord> {
  const row = await queryOne<CategoryRuleRecord>(
    `INSERT INTO category_rules (match_type, pattern, category, department, project_id, priority, notes, created_by)
     VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8)
     RETURNING ${COLS}`,
    [
      input.matchType,
      input.pattern.trim(),
      input.category,
      input.department ?? null,
      input.projectId ?? null,
      input.priority ?? 50,
      input.notes ?? null,
      input.createdBy ?? null,
    ],
  );
  if (!row) throw new Error('Kural olusturulamadi');
  return row;
}

export async function updateRule(
  id: string,
  input: {
    pattern?: string;
    category?: ProductivityCategory;
    department?: string | null;
    priority?: number;
    isActive?: boolean;
    notes?: string | null;
  },
): Promise<CategoryRuleRecord | null> {
  const { clause, values } = buildUpdate({
    pattern: input.pattern,
    category: input.category,
    department: input.department,
    priority: input.priority,
    is_active: input.isActive,
    notes: input.notes,
  });
  if (!clause) return findRuleById(id);
  values.push(id);
  return queryOne<CategoryRuleRecord>(
    `UPDATE category_rules SET ${clause} WHERE id = $${values.length} RETURNING ${COLS}`,
    values,
  );
}

export async function deleteRule(id: string): Promise<boolean> {
  const res = await query('DELETE FROM category_rules WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}
