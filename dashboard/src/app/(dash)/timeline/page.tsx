'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { TimelineStrip } from '@/components/charts';
import { UserSelect } from '@/components/UserSelect';
import { Badge, Card, EmptyState, ErrorBanner, Field, Input, Select, Spinner, StatCard, Table } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { CATEGORY_LABEL, formatClock, formatDuration, formatHours, TIMELINE_STATE_LABEL, todayIso } from '@/lib/format';
import type { TimelineSlice } from '@/lib/types';

const STATE_TONE: Record<TimelineSlice['state'], 'green' | 'amber' | 'rose' | 'violet' | 'slate'> = {
  active: 'green',
  idle: 'amber',
  unproductive: 'rose',
  deducted: 'violet',
  offline: 'slate',
};

export default function TimelinePage() {
  const { user } = useAuthUser();
  const [date, setDate] = useState(todayIso());
  const [userId, setUserId] = useState('');
  const [slotMinutes, setSlotMinutes] = useState(5);
  const [hideOffline, setHideOffline] = useState(true);

  const targetUserId = user?.role === 'employee' ? user.id : userId || undefined;

  const { data, error, loaded, refresh } = useApi(
    () => api.reports.timeline({ userId: targetUserId, date, slotMinutes }),
    [targetUserId, date, slotMinutes],
  );

  const slots = data?.slots ?? [];
  const summary = data?.summary;
  const visible = hideOffline ? slots.filter((slot) => slot.state !== 'offline') : slots;

  return (
    <>
      <Card title="Filtreler" subtitle="Gun secin ve zaman cizelgesini inceleyin">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {user?.role !== 'employee' && (
            <UserSelect value={userId} onChange={setUserId} label="Personel" />
          )}
          <Field label="Tarih">
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Dilim">
            <Select
              value={slotMinutes}
              onChange={(event) => setSlotMinutes(Number(event.target.value))}
            >
              <option value={5}>5 dakika</option>
              <option value={10}>10 dakika</option>
              <option value={15}>15 dakika</option>
              <option value={30}>30 dakika</option>
              <option value={60}>1 saat</option>
            </Select>
          </Field>
          <Field label="Gorunum">
            <label className="flex items-center gap-2 pt-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={hideOffline}
                onChange={(event) => setHideOffline(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Cevrimdisi dilimleri gizle
            </label>
          </Field>
        </div>
      </Card>

      {error && <ErrorBanner message={error} onRetry={refresh} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Odenebilir sure"
          value={formatHours(summary?.payableSeconds ?? ((summary?.activeMinutes ?? 0) * 60))}
          hint={formatDuration(summary?.payableSeconds ?? ((summary?.activeMinutes ?? 0) * 60))}
          tone="success"
        />
        <StatCard
          label="Bosta"
          value={formatDuration(summary?.idleSeconds ?? ((summary?.idleMinutes ?? 0) * 60))}
          tone="warning"
        />
        <StatCard
          label="Uretken degil"
          value={formatDuration(summary?.unproductiveSeconds ?? ((summary?.unproductiveMinutes ?? 0) * 60))}
          tone="danger"
        />
        <StatCard
          label="Silinen blok"
          value={formatDuration(summary?.deductedSeconds ?? ((summary?.deductedMinutes ?? 0) * 60))}
          hint="Gizlilik protokolu"
        />
        <StatCard label="Cevrimdisi" value={formatDuration((summary?.offlineMinutes ?? 0) * 60)} />
      </div>

      <Card title="Zaman cizelgesi" subtitle={`${date} · ${slotMinutes} dakikalik dilimler`}>
        {!loaded && <Spinner />}
        {loaded && <TimelineStrip slots={slots} />}
      </Card>

      <Card title="Dilim dokumu" subtitle="Yesil: calisiyor · Sari: bosta · Kirmizi: uretken degil">
        {loaded && visible.length === 0 && <EmptyState title="Kayit bulunamadi" />}
        {visible.length > 0 && (
          <Table head={['Aralik', 'Durum', 'Kategori', 'Uygulama', 'Domain', 'Pencere']}>
            {visible.map((slot, index) => (
              <tr key={index} className="hover:bg-slate-50/70">
                <td className="td text-slate-600">
                  {formatClock(slot.start)} - {formatClock(slot.end)}
                </td>
                <td className="td">
                  <Badge tone={STATE_TONE[slot.state]}>{TIMELINE_STATE_LABEL[slot.state]}</Badge>
                </td>
                <td className="td text-slate-600">{CATEGORY_LABEL[slot.category] ?? '-'}</td>
                <td className="td font-medium text-slate-700">{slot.activeApp ?? '-'}</td>
                <td className="td text-slate-600">{slot.domain ?? '-'}</td>
                <td className="td max-w-[26rem] truncate text-slate-500" title={slot.windowTitle ?? ''}>
                  {slot.windowTitle ?? '-'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
