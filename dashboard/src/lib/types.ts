/** Backend API sozlesmesinin istemci tarafi tipleri (backend/src/types/api.ts ile uyumlu). */

export type UserRole = 'admin' | 'manager' | 'employee';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type SessionStatus = 'active' | 'stopped' | 'approved' | 'rejected';
export type ProductivityCategory = 'PRODUCTIVE' | 'UNPRODUCTIVE' | 'NEUTRAL';
export type MonitorStatus = 'active' | 'idle' | 'offline';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  department: string | null;
  timezone: string;
  hourlyRate: number;
  currency: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
}

export interface LiveStatusRow {
  userId: string;
  userName: string;
  email: string;
  status: MonitorStatus;
  sessionId: string | null;
  projectName: string | null;
  taskTitle: string | null;
  currentApp: string | null;
  currentWindow: string | null;
  currentDomain: string | null;
  currentCategory: ProductivityCategory | null;
  sessionSeconds: number;
  idleSeconds: number;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface DailyReportRow {
  userId: string;
  userName: string;
  email: string;
  projectId: string | null;
  projectName: string | null;
  trackedSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  deductedSeconds: number;
  payableSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  productivityScore: number;
  screenshotCount: number;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}

export type TimelineState = 'active' | 'idle' | 'offline' | 'deducted' | 'unproductive';

export interface TimelineSlice {
  start: string;
  end: string;
  minutes: number;
  state: TimelineState;
  activeApp: string | null;
  windowTitle: string | null;
  url: string | null;
  domain: string | null;
  category: ProductivityCategory;
}

export interface TimelineSummary {
  activeMinutes: number;
  idleMinutes: number;
  unproductiveMinutes: number;
  deductedMinutes: number;
  offlineMinutes: number;
  totalSeconds?: number;
  trackedSeconds?: number;
  activeSeconds?: number;
  idleSeconds?: number;
  deductedSeconds?: number;
  payableSeconds?: number;
  unproductiveSeconds?: number;
  productiveSeconds?: number;
  neutralSeconds?: number;
}

export interface AppUsageRow {
  key: string;
  label: string;
  category: ProductivityCategory;
  seconds: number;
  keyboardEvents: number;
  mouseEvents: number;
}

export interface ScreenshotItem {
  id: string;
  sessionId: string;
  userId: string;
  timestamp: string;
  monitorIndex: number;
  monitorName: string | null;
  blurApplied: boolean;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  deletedByEmployee: boolean;
  deletedAt: string | null;
  deductedSeconds: number;
  url: string | null;
}

export interface ProductivityUserRow {
  userId: string;
  userName: string;
  email: string;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  totalSeconds: number;
  score: number;
}

export interface PayrollLine {
  userId: string;
  userName: string;
  email: string;
  currency: string;
  hourlyRate: number;
  periodStart: string;
  periodEnd: string;
  payableSeconds: number;
  payableHours: number;
  amount: number;
  sessionCount: number;
  approvedSeconds: number;
  unapprovedSeconds: number;
  productivityScore?: number;
  idleSeconds?: number;
  deductedSeconds?: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  department: string | null;
  timezone: string;
  hourlyRate: number;
  currency: string;
  isActive: boolean;
  hasAgentKey: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  isBillable: boolean;
  createdAt: string;
}

export interface CategoryRule {
  id: string;
  matchType: 'app' | 'domain';
  pattern: string;
  category: ProductivityCategory;
  department: string | null;
  projectId: string | null;
  priority: number;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
}

export interface SessionDto {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  startTime: string;
  endTime: string | null;
  totalDuration: number;
  idleDuration: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  deductedSeconds: number;
  status: SessionStatus;
  billableSeconds: number;
  payableSeconds: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
