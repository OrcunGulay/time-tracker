'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Select } from '@/components/ui';
import type { AdminUser } from '@/lib/types';

/**
 * Kullanici secici. Calisan rolu icin gizlenir (kendi verisini gorur).
 */
export function UserSelect({
  value,
  onChange,
  allowAll = true,
  label = 'Personel',
}: {
  value: string;
  onChange: (userId: string) => void;
  allowAll?: boolean;
  label?: string;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.admin
      .users({ limit: 200 })
      .then((response) => {
        if (!cancelled) setUsers(response.items);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return null;

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {allowAll && <option value="">Tum ekip</option>}
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name} ({user.email})
          </option>
        ))}
      </Select>
    </label>
  );
}
