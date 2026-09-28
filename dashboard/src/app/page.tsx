'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { getAuth } from '@/lib/session';
import { Spinner } from '@/components/ui';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const state = getAuth();
    router.replace(state ? '/live' : '/login');
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <Spinner label="Yonlendiriliyor..." />
    </main>
  );
}
