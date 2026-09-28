/**
 * Ortak API tipleri. Agent ve dashboard bu sozlesmeye gore konusur.
 * docs/API.md ile senkron tutulmalidir.
 */

export type UserRole = 'admin' | 'manager' | 'employee';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type SessionStatus = 'active' | 'stopped' | 'approved' | 'rejected';
export type ProductivityCategory = 'PRODUCTIVE' | 'UNPRODUCTIVE' | 'NEUTRAL';
export type CategoryMatchType = 'app' | 'domain';
export type IdleDecision = 'count' | 'discard';
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

export interface StartSessionInput {
  projectId?: string | null;
  taskId?: string | null;
  clientStartedAt?: string;
  clientInfo?: Record<string, unknown>;
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
  /** Ekran goruntusu silme protokolu ile dusulen sure. */
  deductedSeconds: number;
  /** Idle diyalogunda "calisilmis say" secilen bosluklar. */
  creditedSeconds: number;
  status: SessionStatus;
  billableSeconds: number;
  /** Bordroya esas sure: total - idle - deducted + credited */
  payableSeconds: number;
}

export interface HeartbeatInput {
  sessionId: string;
  status: MonitorStatus;
  idleSeconds?: number;
  activeApp?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  agentVersion?: string;
}

export interface HeartbeatResponse {
  serverTime: string;
  /** Sunucudan gelen komutlar: agent davranisini uzaktan yonetir. */
  commands: {
    /** Uretken olmayan sitede esik asildiginda true doner. */
    promptDistraction: boolean;
    /** Sunucu tarafi bosluk tespiti. */
    forceIdle: boolean;
    /** Oturum sunucuda kapatildiysa agent de durmalidir. */
    stopSession: boolean;
  };
  session: {
    id: string;
    totalDuration: number;
    idleDuration: number;
    status: SessionStatus;
  } | null;
}

export interface ActivitySample {
  /** ISO-8601, ornekleme penceresinin baslangici. */
  timestamp: string;
  activeApp?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  domain?: string | null;
  monitorIndex?: number;
  mouseEvents?: number;
  keyboardEvents?: number;
  mouseDistance?: number;
  isIdle?: boolean;
  idleSeconds?: number;
  /** Pencere suresi (saniye) - agirlikli skor icin */
  durationSeconds?: number;
}

export interface ActivityBatchInput {
  sessionId: string;
  batch: ActivitySample[];
  agentVersion?: string;
}

export interface ActivityBatchResponse {
  accepted: number;
  duplicates: number;
  idleEvents: Array<{
    id: string;
    startedAt: string;
    idleSeconds: number;
  }>;
}

export interface PresignedUrlInput {
  sessionId: string;
  capturedAt: string;
  monitorIndex?: number;
  monitorName?: string | null;
  contentType?: string;
  sizeBytes?: number;
  blurApplied?: boolean;
}

export interface PresignedUrlResponse {
  screenshotId: string;
  storageKey: string;
  uploadUrl: string;
  /** uploadUrl'in gecerli oldugu sure (saniye) */
  expiresIn: number;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface DailyReportRow {
  userId: string;
  userName: string;
  email: string;
  projectId: string | null;
  projectName: string | null;
  /** Saniye */
  trackedSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  deductedSeconds: number;
  payableSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  /** 0-100 */
  productivityScore: number;
  screenshotCount: number;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}

export interface TimelineSlice {
  start: string;
  end: string;
  minutes: number;
  state: 'active' | 'idle' | 'offline' | 'deducted' | 'unproductive';
  activeApp: string | null;
  windowTitle: string | null;
  url: string | null;
  domain: string | null;
  category: ProductivityCategory;
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

export interface AppUsageRow {
  key: string;
  label: string;
  category: ProductivityCategory;
  seconds: number;
  keyboardEvents: number;
  mouseEvents: number;
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
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
