'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, ready } = useAuthUser();
  const router = useRouter();

  useEffect(() => {
    if (ready && !user) router.replace('/login');
  }, [ready, user, router]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Oturum kontrol ediliyor..." />
      </div>
    );
  }

  if (!user) return null;

  return <AppShell user={user}>{children}</AppShell>;
}
