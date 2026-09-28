'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';

export interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Ilk yukleme tamamlandi mi (bos durum ile yukleniyor ayrimi icin). */
  loaded: boolean;
  refresh: () => void;
}

interface Options {
  /** Otomatik yenileme araligi (ms). Canli sayfalar icin. */
  intervalMs?: number;
  /** false ise istek yapilmaz (orn. secim bekleniyor). */
  enabled?: boolean;
}

export function useApi<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  options: Options = {},
): UseApiResult<T> {
  const { intervalMs, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      try {
        const result = await loaderRef.current();
        if (cancelled || !mounted.current) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled || !mounted.current) return;
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Bilinmeyen hata';
        setError(message);
      } finally {
        if (!cancelled && mounted.current) {
          setLoading(false);
          setLoaded(true);
        }
      }
    };

    void run();

    let timer: ReturnType<typeof setInterval> | undefined;
    if (intervalMs && intervalMs > 0) {
      timer = setInterval(() => void run(), intervalMs);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, enabled, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, loading, loaded, refresh };
}
