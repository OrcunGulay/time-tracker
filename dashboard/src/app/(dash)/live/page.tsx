'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Card, EmptyState, ErrorBanner, Spinner, StatCard, StatusDot, Table } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { CATEGORY_LABEL, formatDuration, formatRelative } from '@/lib/format';
import type { LiveStatusRow, MonitorStatus } from '@/lib/types';

const FILTERS: Array<{ value: MonitorStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Tumu' },
  { value: 'active', label: 'Cevrimici' },
  { value: 'idle', label: 'Bosta' },
  { value: 'offline', label: 'Cevrimdisi' },
];

function categoryTone(category: string | null): 'green' | 'rose' | 'slate' {
  if (category === 'PRODUCTIVE') return 'green';
  if (category === 'UNPRODUCTIVE') return 'rose';
  return 'slate';
}

export default function LivePage() {
  const [filter, setFilter] = useState<MonitorStatus | 'all'>('all');
  // Canli durum: 10 saniyede bir otomatik yenilenir
  const { data, error, loaded, refresh } = useApi(() => api.reports.live(), [], { intervalMs: 10_000 });

  const rows = data?.items ?? [];
  const counts = useMemo(
    () => ({
      active: rows.filter((row) => row.status === 'active').length,
      idle: rows.filter((row) => row.status === 'idle').length,
      offline: rows.filter((row) => row.status === 'offline').length,
      tracked: rows.reduce((sum, row) => sum + row.sessionSeconds, 0),
    }),
    [rows],
  );

  const visible = filter === 'all' ? rows : rows.filter((row) => row.status === filter);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Cevrimici" value={counts.active} tone="success" hint="Su anda aktif calisan" />
        <StatCard label="Bosta" value={counts.idle} tone="warning" hint="Girdi bekleniyor" />
        <StatCard label="Cevrimdisi" value={counts.offline} hint="Agent kapali veya oturum yok" />
        <StatCard
          label="Toplam takip suresi (bugun)"
          value={formatDuration(counts.tracked)}
          tone="info"
          hint="Acik oturumlarin toplami"
        />
      </div>

      {error && <ErrorBanner message={error} onRetry={refresh} />}

      <Card
        title="Canli durum"
        subtitle="10 saniyede bir otomatik yenilenir"
        actions={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setFilter(item.value)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                  filter === item.value
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      >
        {!loaded && <Spinner />}
        {loaded && visible.length === 0 && (
          <EmptyState
            title="Bu filtre icin kayit yok"
            description="Agent kurulu ve mesai baslatildiginda kayitlar burada gorunur."
          />
        )}

        {visible.length > 0 && (
          <Table head={['Personel', 'Durum', 'Proje / Gorev', 'Aktif uygulama', 'Domain', 'Oturum', 'Son sinyal']}>
            {visible.map((row: LiveStatusRow) => (
              <tr key={row.userId} className="hover:bg-slate-50/70">
                <td className="td">
                  <div className="font-medium text-slate-800">{row.userName}</div>
                  <div className="text-xs text-slate-500">{row.email}</div>
                </td>
                <td className="td">
                  <StatusDot status={row.status} />
                  {row.idleSeconds > 0 && row.status === 'idle' && (
                    <div className="mt-0.5 text-xs text-amber-600">{formatDuration(row.idleSeconds)} bosluk</div>
                  )}
                </td>
                <td className="td">
                  {row.projectName ? (
                    <div>
                      <div className="text-slate-800">{row.projectName}</div>
                      {row.taskTitle && <div className="text-xs text-slate-500">{row.taskTitle}</div>}
                    </div>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )}
                </td>
                <td className="td">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-700">{row.currentApp ?? '-'}</span>
                    {row.currentCategory && (
                      <Badge tone={categoryTone(row.currentCategory)}>
                        {CATEGORY_LABEL[row.currentCategory]}
                      </Badge>
                    )}
                  </div>
                  {row.currentWindow && (
                    <div className="max-w-[22rem] truncate text-xs text-slate-500" title={row.currentWindow}>
                      {row.currentWindow}
                    </div>
                  )}
                </td>
                <td className="td">
                  {row.currentDomain ? (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                      {row.currentDomain}
                    </span>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )}
                </td>
                <td className="td">{formatDuration(row.sessionSeconds)}</td>
                <td className="td text-slate-500">
                  {formatRelative(row.lastHeartbeatAt ?? row.lastSeenAt)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
