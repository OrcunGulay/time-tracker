/** projects, project_members ve tasks tablolari veri erisimi. */
import { query, queryOne } from '../db/pool.js';
import { buildUpdate } from '../lib/sql.js';
import type { TaskStatus } from '../types/api.js';

export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  createdAt: Date;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  isBillable: boolean;
  createdAt: Date;
}

const PROJECT_COLS = `id, name, description, is_archived AS "isArchived", created_at AS "createdAt"`;
const TASK_COLS = `id, project_id AS "projectId", title, description, status,
  is_billable AS "isBillable", created_at AS "createdAt"`;

export async function listProjects(includeArchived = false): Promise<ProjectRecord[]> {
  const res = await query<ProjectRecord>(
    `SELECT ${PROJECT_COLS} FROM projects
     ${includeArchived ? '' : 'WHERE is_archived = false'}
     ORDER BY name ASC`,
  );
  return res.rows;
}

export async function findProjectById(id: string): Promise<ProjectRecord | null> {
  return queryOne<ProjectRecord>(`SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`, [id]);
}

export async function createProject(input: {
  name: string;
  description?: string | null;
}): Promise<ProjectRecord> {
  const row = await queryOne<ProjectRecord>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING ${PROJECT_COLS}`,
    [input.name, input.description ?? null],
  );
  if (!row) throw new Error('Proje olusturulamadi');
  return row;
}

export async function updateProject(
  id: string,
  input: { name?: string; description?: string | null; isArchived?: boolean },
): Promise<ProjectRecord | null> {
  const { clause, values } = buildUpdate({
    name: input.name,
    description: input.description,
    is_archived: input.isArchived,
  });
  if (!clause) return findProjectById(id);
  values.push(id);
  return queryOne<ProjectRecord>(
    `UPDATE projects SET ${clause} WHERE id = $${values.length} RETURNING ${PROJECT_COLS}`,
    values,
  );
}

export async function addProjectMember(projectId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [projectId, userId],
  );
}

export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
}

export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2) AS exists`,
    [projectId, userId],
  );
  return row?.exists ?? false;
}

export async function listUserProjects(userId: string): Promise<ProjectRecord[]> {
  const res = await query<ProjectRecord>(
    `SELECT ${PROJECT_COLS.split(',').map((c) => `p.${c.trim()}`).join(', ')}
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE pm.user_id = $1 AND p.is_archived = false
     ORDER BY p.name ASC`,
    [userId],
  );
  return res.rows;
}

// ------------------------------------------------------------------- tasks

export async function listTasks(filters: { projectId?: string; status?: TaskStatus }): Promise<TaskRecord[]> {
  const values: unknown[] = [];
  const where: string[] = [];
  if (filters.projectId) { values.push(filters.projectId); where.push(`project_id = $${values.length}`); }
  if (filters.status) { values.push(filters.status); where.push(`status = $${values.length}`); }
  const res = await query<TaskRecord>(
    `SELECT ${TASK_COLS} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT 500`,
    values,
  );
  return res.rows;
}

export async function findTaskById(id: string): Promise<TaskRecord | null> {
  return queryOne<TaskRecord>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [id]);
}

export async function createTask(input: {
  projectId: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  isBillable?: boolean;
}): Promise<TaskRecord> {
  const row = await queryOne<TaskRecord>(
    `INSERT INTO tasks (project_id, title, description, status, is_billable)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${TASK_COLS}`,
    [input.projectId, input.title, input.description ?? null, input.status ?? 'todo', input.isBillable ?? true],
  );
  if (!row) throw new Error('Gorev olusturulamadi');
  return row;
}

export async function updateTask(
  id: string,
  input: { title?: string; description?: string | null; status?: TaskStatus; isBillable?: boolean },
): Promise<TaskRecord | null> {
  const { clause, values } = buildUpdate({
    title: input.title,
    description: input.description,
    status: input.status,
    is_billable: input.isBillable,
  });
  if (!clause) return findTaskById(id);
  values.push(id);
  return queryOne<TaskRecord>(
    `UPDATE tasks SET ${clause} WHERE id = $${values.length} RETURNING ${TASK_COLS}`,
    values,
  );
}

export async function deleteTask(id: string): Promise<boolean> {
  const res = await query('DELETE FROM tasks WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}
