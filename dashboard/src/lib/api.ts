/**
 * Backend API istemcisi.
 *
 * - Erisim tokeni localStorage'dan okunur (bkz. lib/session.ts)
 * - 401 alindiginda yenileme tokeni ile otomatik yenileme + tekrar deneme
 * - Sure dolmasi yaklastiginda istek oncesi yenileme
 */
'use client';

import { clearAuth, getAuth, setAuth, updateTokens } from './session';
import type {
  AdminUser,
  AppUsageRow,
  CategoryRule,
  DailyReportRow,
  LiveStatusRow,
  LoginResponse,
  Paged,
  PayrollLine,
  ProductivityUserRow,
  Project,
  ScreenshotItem,
  SessionDto,
  Task,
  TimelineSlice,
  TimelineSummary,
} from './types';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Kimlik dogrulama gerektirmeyen istekler (login). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function rawRequest(path: string, options: RequestOptions, token?: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
}

async function parseError(response: Response): Promise<never> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || 'Istek basarisiz';
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    if (payload.error) code = payload.error;
    if (payload.message) message = payload.message;
  } catch {
    /* gövde JSON degil */
  }
  throw new ApiError(response.status, code, message);
}

async function tryRefresh(): Promise<string | null> {
  const state = getAuth();
  if (!state?.refreshToken) return null;
  try {
    const response = await rawRequest(
      '/api/auth/refresh',
      { method: 'POST', body: { refreshToken: state.refreshToken } },
      null,
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as LoginResponse;
    const next = updateTokens(payload.accessToken, payload.refreshToken, payload.expiresIn);
    return next?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const state = getAuth();
  let token = options.anonymous ? null : state?.accessToken ?? null;

  // Suresi dolmak uzereyse once yenile
  if (!options.anonymous && state && state.expiresAt - Date.now() < 30_000) {
    token = (await tryRefresh()) ?? token;
  }

  let response = await rawRequest(path, options, token);

  if (response.status === 401 && !options.anonymous) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      response = await rawRequest(path, options, refreshed);
    } else {
      clearAuth();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      throw new ApiError(401, 'UNAUTHORIZED', 'Oturum suresi doldu, tekrar giris yapin');
    }
  }

  if (!response.ok) await parseError(response);
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) return (await response.json()) as T;
  return (await response.text()) as unknown as T;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

// -------------------------------------------------------------------- auth
export const authApi = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      anonymous: true,
    }),

  logout: (refreshToken: string) =>
    request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
      body: { refreshToken },
      anonymous: true,
    }),

  me: () => request<{ user: LoginResponse['user'] }>('/api/auth/me'),

  createAgentKey: () =>
    request<{ apiKey: string; warning: string }>('/api/auth/agent-key', { method: 'POST' }),

  revokeAgentKey: () => request<{ ok: boolean }>('/api/auth/agent-key', { method: 'DELETE' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
};

// ----------------------------------------------------------------- reports
export interface UsageResponse {
  date: string;
  groupBy: 'app' | 'domain';
  items: AppUsageRow[];
}

export interface TimelineResponse {
  date: string;
  slots: TimelineSlice[];
  summary: TimelineSummary;
}

export const reportsApi = {
  live: () => request<{ items: LiveStatusRow[] }>('/api/reports/live'),

  daily: (params: { date?: string; userId?: string; projectId?: string }) =>
    request<{ date: string; rows: DailyReportRow[] }>(`/api/reports/daily${query(params)}`),

  timeline: (params: { userId?: string; date?: string; slotMinutes?: number }) =>
    request<TimelineResponse>(`/api/reports/timeline${query(params)}`),

  usage: (params: { date?: string; userId?: string; groupBy?: 'app' | 'domain' }) =>
    request<UsageResponse>(`/api/reports/usage${query(params)}`),

  productivity: (params: { from?: string; to?: string; userId?: string }) =>
    request<{
      from: string;
      to: string;
      neutralWeight: number;
      overall: {
        productiveSeconds: number;
        unproductiveSeconds: number;
        neutralSeconds: number;
        score: number;
      };
      users: ProductivityUserRow[];
    }>(`/api/reports/productivity${query(params)}`),
};

// ------------------------------------------------------------- screenshots
export const screenshotsApi = {
  list: (params: {
    userId?: string;
    sessionId?: string;
    from?: string;
    to?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }) =>
    request<Paged<ScreenshotItem>>(
      `/api/screenshots${query({
        ...params,
        includeDeleted: params.includeDeleted ? 'true' : undefined,
      })}`,
    ),

  /** Gizlilik protokolu: kendi goruntusunu siler, blok mesai suresinden dusulur. */
  remove: (id: string) =>
    request<{ ok: boolean; deductedSeconds: number; notice: string }>(`/api/screenshots/${id}`, {
      method: 'DELETE',
    }),

  freshUrl: (id: string) => request<{ url: string; expiresIn: number }>(`/api/screenshots/${id}/url`),
};

// ---------------------------------------------------------------- sessions
export const sessionsApi = {
  list: (params: { userId?: string; from?: string; to?: string; status?: string; limit?: number }) =>
    request<Paged<SessionDto>>(`/api/sessions${query(params)}`),

  approve: (id: string) =>
    request<{ session: SessionDto }>(`/api/sessions/${id}/approve`, {
      method: 'POST',
      body: { status: 'approved' },
    }),

  reject: (id: string) =>
    request<{ session: SessionDto }>(`/api/sessions/${id}/approve`, {
      method: 'POST',
      body: { status: 'rejected' },
    }),
};

// ---------------------------------------------------------------- payroll
export interface PayrollSummary {
  periodStart: string;
  periodEnd: string;
  totalAmount: number;
  totalSeconds: number;
  currency: string;
  items: PayrollLine[];
}

export const payrollApi = {
  summary: (params: { periodStart?: string; periodEnd?: string; userId?: string }) =>
    request<PayrollSummary>(`/api/payroll/summary${query(params)}`),

  mine: (params: { periodStart?: string; periodEnd?: string }) =>
    request<PayrollSummary>(`/api/payroll/me${query(params)}`),

  issue: (body: { periodStart: string; periodEnd: string }) =>
    request<{ ok: boolean; issued: number }>('/api/payroll/issue', { method: 'POST', body }),

  exportUrl: (params: { periodStart?: string; periodEnd?: string; userId?: string; format: 'csv' | 'pdf' }) =>
    `${API_URL}/api/payroll/export${query(params)}`,

  /** Yetki gerektiren dosyalar icin imzali indirme (Authorization basligi ile). */
  download: async (params: {
    periodStart?: string;
    periodEnd?: string;
    userId?: string;
    format: 'csv' | 'pdf';
  }): Promise<Blob> => {
    const state = getAuth();
    const response = await fetch(`${API_URL}/api/payroll/export${query(params)}`, {
      headers: state ? { Authorization: `Bearer ${state.accessToken}` } : {},
    });
    if (!response.ok) await parseError(response);
    return response.blob();
  },
};

// ------------------------------------------------------------------ admin
export const adminApi = {
  users: (params: { search?: string; role?: string; department?: string; limit?: number } = {}) =>
    request<Paged<AdminUser>>(`/api/admin/users${query(params)}`),

  departments: () => request<{ items: string[] }>('/api/admin/departments'),

  createUser: (body: {
    name: string;
    email: string;
    password: string;
    role: string;
    department?: string | null;
    hourlyRate?: number;
    currency?: string;
  }) => request<{ id: string }>('/api/admin/users', { method: 'POST', body }),

  updateUser: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'PATCH', body }),

  deleteUser: (id: string) => request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),

  projects: () => request<{ items: Project[] }>('/api/admin/projects'),

  createProject: (body: { name: string; description?: string }) =>
    request<{ project: Project }>('/api/admin/projects', { method: 'POST', body }),

  tasks: (projectId?: string) => request<{ items: Task[] }>(`/api/admin/tasks${query({ projectId })}`),

  createTask: (body: { projectId: string; title: string; status?: string }) =>
    request<{ task: Task }>('/api/admin/tasks', { method: 'POST', body }),

  updateTask: (id: string, body: Record<string, unknown>) =>
    request<{ task: Task }>(`/api/admin/tasks/${id}`, { method: 'PATCH', body }),

  categories: (params: { matchType?: string; department?: string } = {}) =>
    request<{ items: CategoryRule[] }>(`/api/admin/categories${query(params)}`),

  createCategory: (body: {
    matchType: 'app' | 'domain';
    pattern: string;
    category: string;
    department?: string | null;
    priority?: number;
  }) => request<{ rule: CategoryRule }>('/api/admin/categories', { method: 'POST', body }),

  updateCategory: (id: string, body: Record<string, unknown>) =>
    request<{ rule: CategoryRule }>(`/api/admin/categories/${id}`, { method: 'PATCH', body }),

  deleteCategory: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/categories/${id}`, { method: 'DELETE' }),

  /** Kural motoru testi: verilen uygulama/URL hangi kategoriye duser? */
  testCategory: (params: { app?: string; url?: string; domain?: string; department?: string }) =>
    request<{ category: string }>(`/api/admin/categories/test${query(params)}`),

  audit: (params: { limit?: number } = {}) =>
    request<Paged<Record<string, unknown>>>(`/api/admin/audit${query(params)}`),
};

export const api = {
  auth: authApi,
  reports: reportsApi,
  screenshots: screenshotsApi,
  sessions: sessionsApi,
  payroll: payrollApi,
  admin: adminApi,
};

export { setAuth, clearAuth, getAuth };
