'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, setAuth } from '@/lib/api';
import { getAuth } from '@/lib/session';
import { Button, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getAuth()) router.replace('/live');
  }, [router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await api.auth.login(email.trim(), password);
      setAuth(response);
      router.replace('/live');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Giris yapilamadi');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">
            TT
          </span>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Zaman Takip Paneli</h1>
            <p className="text-xs text-slate-500">Aktivite, verimlilik ve bordro yonetimi</p>
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-4">
          <Field label="E-posta">
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              placeholder="ada@localhost"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Parola">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {error}
            </p>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? 'Giris yapiliyor...' : 'Giris yap'}
          </Button>

          <p className="text-center text-xs text-slate-400">
            Sunucu: {process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}
          </p>
        </form>

        <div className="mt-4 rounded-xl border border-slate-200 bg-white/70 p-3 text-xs text-slate-500">
          <p className="font-medium text-slate-600">Demo hesaplari (npm run seed sonrasi)</p>
          <p className="mt-1">Yonetici: admin@localhost / Admin123!</p>
          <p>Takim lideri: deniz@localhost / Deniz123!</p>
          <p>Calisan: ada@localhost / Ada123!</p>
        </div>
      </div>
    </main>
  );
}
