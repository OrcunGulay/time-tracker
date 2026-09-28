/**
 * /api/admin - yonetim uc noktalari (kullanici, proje, gorev, kategori kurali).
 * Rol matrisi:
 *   - kullanicilar: admin
 *   - projeler/gorevler: admin + manager
 *   - kategori kurallari: admin (+ manager kendi departmani icin)
 */
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { normalizePage } from '../lib/sql.js';
import * as auditRepo from '../repositories/misc.repo.js';
import * as categoryRepo from '../repositories/category.repo.js';
import * as projectRepo from '../repositories/project.repo.js';
import * as userRepo from '../repositories/user.repo.js';
import * as categoryService from '../services/category.service.js';
import { currentUser } from '../lib/auth.js';
import type { CategoryMatchType, ProductivityCategory, TaskStatus, UserRole } from '../types/api.js';

const uuidSchema = { type: 'string', minLength: 36, maxLength: 36 } as const;

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = app.requireRole('admin');
  const staff = app.requireRole('admin', 'manager');

  // ------------------------------------------------------------------ users
  app.get('/users', { preHandler: staff }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const page = normalizePage(q);
    const { items, total } = await userRepo.listUsers(
      {
        role: q.role as UserRole | undefined,
        department: q.department,
        search: q.search,
        activeOnly: q.includeInactive !== 'true',
      },
      page,
    );
    return {
      items: items.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        department: u.department,
        timezone: u.timezone,
        hourlyRate: u.hourlyRate,
        currency: u.currency,
        isActive: u.isActive,
        hasAgentKey: u.agentApiKeyHash !== null,
        lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      })),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.get('/departments', { preHandler: staff }, async () => ({
    items: await userRepo.listDepartments(),
  }));

  app.post(
    '/users',
    {
      preHandler: adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'email', 'password'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 160 },
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', minLength: 8, maxLength: 200 },
            role: { type: 'string', enum: ['admin', 'manager', 'employee'] },
            department: { type: ['string', 'null'] },
            timezone: { type: 'string' },
            hourlyRate: { type: 'number', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
          },
        },
      },
    },
    async (request) => {
      const actor = currentUser(request);
      const body = request.body as {
        name: string;
        email: string;
        password: string;
        role?: UserRole;
        department?: string | null;
        timezone?: string;
        hourlyRate?: number;
        currency?: string;
      };
      const existing = await userRepo.findByEmail(body.email);
      if (existing) throw conflict('Bu e-posta ile kayitli kullanici var');

      const created = await userRepo.createUser({
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: body.role ?? 'employee',
        department: body.department ?? null,
        timezone: body.timezone ?? 'Europe/Istanbul',
        hourlyRate: body.hourlyRate ?? 0,
        currency: body.currency ?? 'TRY',
      });
      await auditRepo.insertAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: 'user.create',
        entityType: 'user',
        entityId: created.id,
        metadata: { role: created.role, email: created.email },
        ipAddress: request.ip,
      });
      return { id: created.id };
    },
  );

  app.patch(
    '/users/:id',
    {
      preHandler: adminOnly,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 160 },
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', minLength: 8, maxLength: 200 },
            role: { type: 'string', enum: ['admin', 'manager', 'employee'] },
            department: { type: ['string', 'null'] },
            timezone: { type: 'string' },
            hourlyRate: { type: 'number', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            isActive: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const actor = currentUser(request);
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown>;
      const updated = await userRepo.updateUser(id, {
        name: body.name as string | undefined,
        email: body.email as string | undefined,
        passwordHash: body.password ? await hashPassword(body.password as string) : undefined,
        role: body.role as UserRole | undefined,
        department: body.department as string | null | undefined,
        timezone: body.timezone as string | undefined,
        hourlyRate: body.hourlyRate as number | undefined,
        currency: body.currency as string | undefined,
        isActive: body.isActive as boolean | undefined,
      });
      if (!updated) throw notFound('Kullanici bulunamadi');
      await auditRepo.insertAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        metadata: { fields: Object.keys(body) },
        ipAddress: request.ip,
      });
      return { ok: true };
    },
  );

  app.delete('/users/:id', { preHandler: adminOnly, schema: { params: { type: 'object', properties: { id: uuidSchema } } } }, async (request) => {
    const actor = currentUser(request);
    const { id } = request.params as { id: string };
    if (actor.id === id) throw badRequest('Kendi hesabinizi silemezsiniz');
    const ok = await userRepo.deleteUser(id);
    if (!ok) throw notFound('Kullanici bulunamadi');
    await auditRepo.insertAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'user.delete',
      entityType: 'user',
      entityId: id,
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  // --------------------------------------------------------------- projects
  app.get('/projects', { preHandler: staff }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    return { items: await projectRepo.listProjects(q.includeArchived === 'true') };
  });

  app.post(
    '/projects',
    {
      preHandler: staff,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 160 },
            description: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      const actor = currentUser(request);
      const body = request.body as { name: string; description?: string | null };
      const project = await projectRepo.createProject(body);
      await auditRepo.insertAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: 'project.create',
        entityType: 'project',
        entityId: project.id,
        ipAddress: request.ip,
      });
      return { project };
    },
  );

  app.patch('/projects/:id', { preHandler: staff }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string | null; isArchived?: boolean };
    const project = await projectRepo.updateProject(id, body);
    if (!project) throw notFound('Proje bulunamadi');
    return { project };
  });

  app.post('/projects/:id/members', { preHandler: staff }, async (request) => {
    const { id } = request.params as { id: string };
    const { userId, remove } = (request.body ?? {}) as { userId?: string; remove?: boolean };
    if (!userId) throw badRequest('userId gerekli');
    if (remove) await projectRepo.removeProjectMember(id, userId);
    else await projectRepo.addProjectMember(id, userId);
    return { ok: true };
  });

  // ------------------------------------------------------------------ tasks
  app.get('/tasks', { preHandler: app.authenticate }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    return {
      items: await projectRepo.listTasks({
        projectId: q.projectId,
        status: q.status as TaskStatus | undefined,
      }),
    };
  });

  app.post(
    '/tasks',
    {
      preHandler: staff,
      schema: {
        body: {
          type: 'object',
          required: ['projectId', 'title'],
          additionalProperties: false,
          properties: {
            projectId: uuidSchema,
            title: { type: 'string', minLength: 2, maxLength: 200 },
            description: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
            isBillable: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        projectId: string;
        title: string;
        description?: string | null;
        status?: TaskStatus;
        isBillable?: boolean;
      };
      const project = await projectRepo.findProjectById(body.projectId);
      if (!project) throw notFound('Proje bulunamadi');
      const task = await projectRepo.createTask(body);
      return { task };
    },
  );

  app.patch('/tasks/:id', { preHandler: staff }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      title?: string;
      description?: string | null;
      status?: TaskStatus;
      isBillable?: boolean;
    };
    const task = await projectRepo.updateTask(id, body);
    if (!task) throw notFound('Gorev bulunamadi');
    return { task };
  });

  app.delete('/tasks/:id', { preHandler: staff }, async (request) => {
    const { id } = request.params as { id: string };
    const ok = await projectRepo.deleteTask(id);
    if (!ok) throw notFound('Gorev bulunamadi');
    return { ok: true };
  });

  // ------------------------------------------------------- category rules
  app.get('/categories', { preHandler: staff }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    return {
      items: await categoryRepo.listRules({
        matchType: q.matchType as CategoryMatchType | undefined,
        department: q.department === undefined ? undefined : q.department === 'global' ? null : q.department,
        activeOnly: q.includeInactive !== 'true',
      }),
    };
  });

  app.post(
    '/categories',
    {
      preHandler: staff,
      schema: {
        body: {
          type: 'object',
          required: ['matchType', 'pattern', 'category'],
          additionalProperties: false,
          properties: {
            matchType: { type: 'string', enum: ['app', 'domain'] },
            pattern: { type: 'string', minLength: 2, maxLength: 200 },
            category: { type: 'string', enum: ['PRODUCTIVE', 'UNPRODUCTIVE', 'NEUTRAL'] },
            department: { type: ['string', 'null'] },
            projectId: { type: ['string', 'null'] },
            priority: { type: 'integer', minimum: 1, maximum: 1000 },
            notes: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      const actor = currentUser(request);
      const body = request.body as {
        matchType: CategoryMatchType;
        pattern: string;
        category: ProductivityCategory;
        department?: string | null;
        projectId?: string | null;
        priority?: number;
        notes?: string | null;
      };
      // Manager yalnizca kendi departmani icin kural tanimlayabilir
      const department =
        actor.role === 'manager' ? (actor.department ?? null) : (body.department ?? null);
      if (actor.role === 'manager' && !department) {
        throw badRequest('Departman bilgisi olmayan yonetici kategori kurali tanimlayamaz');
      }

      const rule = await categoryRepo.createRule({ ...body, department, createdBy: actor.id });
      categoryService.invalidateCache();
      await auditRepo.insertAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: 'category.create',
        entityType: 'category_rule',
        entityId: rule.id,
        metadata: { matchType: rule.matchType, pattern: rule.pattern, category: rule.category },
        ipAddress: request.ip,
      });
      return { rule };
    },
  );

  app.patch('/categories/:id', { preHandler: staff }, async (request) => {
    const actor = currentUser(request);
    const { id } = request.params as { id: string };
    const existing = await categoryRepo.findRuleById(id);
    if (!existing) throw notFound('Kural bulunamadi');
    if (actor.role === 'manager' && existing.department !== actor.department) {
      throw badRequest('Yalnizca kendi departmaninizin kurallarini duzenleyebilirsiniz');
    }

    const body = request.body as Record<string, unknown>;
    const rule = await categoryRepo.updateRule(id, {
      pattern: body.pattern as string | undefined,
      category: body.category as ProductivityCategory | undefined,
      priority: body.priority as number | undefined,
      isActive: body.isActive as boolean | undefined,
      notes: body.notes as string | null | undefined,
    });
    categoryService.invalidateCache();
    return { rule };
  });

  app.delete('/categories/:id', { preHandler: staff }, async (request) => {
    const actor = currentUser(request);
    const { id } = request.params as { id: string };
    const existing = await categoryRepo.findRuleById(id);
    if (!existing) throw notFound('Kural bulunamadi');
    if (actor.role === 'manager' && existing.department !== actor.department) {
      throw badRequest('Yalnizca kendi departmaninizin kurallarini silebilirsiniz');
    }
    await categoryRepo.deleteRule(id);
    categoryService.invalidateCache();
    await auditRepo.insertAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'category.delete',
      entityType: 'category_rule',
      entityId: id,
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  /** Kural testi: "chrome.exe + youtube.com" ne olarak etiketlenir? */
  app.get('/categories/test', { preHandler: staff }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const category = await categoryService.classify({
      activeApp: q.app ?? null,
      url: q.url ?? null,
      domain: q.domain ?? null,
      department: q.department ?? null,
    });
    return { category };
  });

  // ------------------------------------------------------------------ audit
  app.get('/audit', { preHandler: adminOnly }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const page = normalizePage(q);
    return auditRepo.listAudit(
      {
        actorId: q.actorId,
        action: q.action,
        entityType: q.entityType,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      },
      page,
    );
  });
}
