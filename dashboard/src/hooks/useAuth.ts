'use client';

import { useEffect, useState } from 'react';
import { getAuth, subscribe } from '@/lib/session';
import type { AuthUser } from '@/lib/types';

export interface AuthUserState {
  user: AuthUser | null;
  /** localStorage okunana kadar false; hidrasyon uyumsuzlugunu onler. */
  ready: boolean;
}

export function useAuthUser(): AuthUserState {
  const [state, setState] = useState<AuthUserState>({ user: null, ready: false });

  useEffect(() => {
    setState({ user: getAuth()?.user ?? null, ready: true });
    return subscribe((next) => setState({ user: next?.user ?? null, ready: true }));
  }, []);

  return state;
}
