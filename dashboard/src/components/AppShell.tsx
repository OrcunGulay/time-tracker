'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { clearAuth, getAuth } from '@/lib/session';
import type { AuthUser } from '@/lib/types';

interface NavItem {
  href: string;
  label: string;
  roles: Array<AuthUser['role']>;
  description: string;
}

const NAV: NavItem[] = [
  { href: '/live', label: 'Canli Durum', roles: ['admin', 'manager', 'employee'], description: 'Kim cevrimici?' },
  { href: '/timeline', label: 'Zaman Cizelgesi', roles: ['admin', 'manager', 'employee'], description: 'Saat saat dokum' },
  { href: '/screenshots', label: 'Ekran Goruntuleri', roles: ['admin', 'manager', 'employee'], description: 'Galeri + gizlilik' },
  { href: '/usage', label: 'Uygulama Kullanimi', roles: ['admin', 'manager', 'employee'], description: 'Dagilim grafikleri' },
  { href: '/productivity', label: 'Uretkenlik', roles: ['admin', 'manager', 'employee'], description: 'Skor raporu' },
  { href: '/payroll', label: 'Bordro', roles: ['admin', 'manager'], description: 'Maliyet & fatura' },
  { href: '/coach-payroll', label: 'Koç Ödemeleri', roles: ['admin', 'manager'], description: 'Google Drive & Zoom hakediş' },
  { href: '/team', label: 'Ekip & Ayarlar', roles: ['admin', 'manager'], description: 'Kullanici/proje/kural' },
  { href: '/me', label: 'Kendi Kayitlarim', roles: ['employee'], description: 'Kendi verilerim' },
];

export function AppShell({ user, children }: { user: AuthUser; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = NAV.filter((item) => item.roles.includes(user.role));

  const logout = async () => {
    const state = getAuth();
    if (state?.refreshToken) {
      try {
        await api.auth.logout(state.refreshToken);
      } catch {
        /* sunucuya ulasilamasa da yerel token temizlenir */
      }
    }
    clearAuth();
    router.replace('/login');
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Kenar cubugu */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 transform bg-brand-900 transition-transform lg:static lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center gap-2.5 border-b border-white/10 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
            TT
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-white">Zaman Takip</p>
            <p className="text-[11px] text-brand-200">Aktivite Paneli</p>
          </div>
        </div>

        <nav className="space-y-1 p-3">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`nav-link ${active ? 'nav-link-active' : ''}`}
              >
                <span className="flex-1">
                  <span className="block">{item.label}</span>
                  <span className="block text-[11px] text-slate-400">{item.description}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="absolute inset-x-0 bottom-0 border-t border-white/10 p-4">
          <p className="truncate text-sm font-medium text-white">{user.name}</p>
          <p className="truncate text-xs text-brand-200">
            {user.email} · {roleLabel(user.role)}
          </p>
          <button
            type="button"
            onClick={logout}
            className="mt-3 w-full rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
          >
            Cikis yap
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <button
          type="button"
          aria-label="Menuyu kapat"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:px-8">
          <button
            type="button"
            onClick={() => setMobileOpen((value) => !value)}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="Menu"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M3 5h14v2H3V5Zm0 4h14v2H3V9Zm0 4h14v2H3v-2Z" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-slate-800">
              {items.find((item) => pathname.startsWith(item.href))?.label ?? 'Panel'}
            </h1>
            <p className="truncate text-xs text-slate-500">
              {items.find((item) => pathname.startsWith(item.href))?.description ?? ''}
            </p>
          </div>
          <span className="hidden items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 sm:inline-flex">
            <span className="h-2 w-2 animate-pulseSoft rounded-full bg-emerald-500" />
            Canli veri
          </span>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 p-4 lg:p-8">{children}</main>

        <footer className="border-t border-slate-200 px-4 py-4 text-center text-xs text-slate-400 lg:px-8">
          Zaman Takip Platformu · Giris aktivitesi yalnizca sayac olarak toplanir, tus icerigi kaydedilmez.
        </footer>
      </div>
    </div>
  );
}

export function roleLabel(role: AuthUser['role']): string {
  if (role === 'admin') return 'Yonetici';
  if (role === 'manager') return 'Takim lideri';
  return 'Calisan';
}
