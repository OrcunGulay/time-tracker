/** Tarayici tarafi kimlik saklama (localStorage) ve abonelik. */
'use client';

import type { AuthUser, LoginResponse } from './types';

const STORAGE_KEY = 'timetracker.auth';

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
  expiresAt: number;
}

type Listener = (state: AuthState | null) => void;

const listeners = new Set<Listener>();
let cached: AuthState | null | undefined;

function read(): AuthState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthState;
    if (!parsed.accessToken || !parsed.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getAuth(): AuthState | null {
  if (cached === undefined) cached = read();
  return cached;
}

export function setAuth(response: LoginResponse): AuthState {
  const state: AuthState = {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    user: response.user,
    expiresAt: Date.now() + response.expiresIn * 1000,
  };
  cached = state;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  listeners.forEach((listener) => listener(state));
  return state;
}

export function clearAuth(): void {
  cached = null;
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  listeners.forEach((listener) => listener(null));
}

export function updateTokens(accessToken: string, refreshToken: string, expiresIn: number): AuthState | null {
  const current = getAuth();
  if (!current) return null;
  const next: AuthState = {
    ...current,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  cached = next;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hasRole(role: AuthUser['role'], allowed: AuthUser['role'][]): boolean {
  return allowed.includes(role);
}
