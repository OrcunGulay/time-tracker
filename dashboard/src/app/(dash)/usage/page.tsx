'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { BarList, Donut } from '@/components/charts';
import { UserSelect } from '@/components/UserSelect';
import { Badge, Card, EmptyState, ErrorBanner, Field, Input, Spinner, StatCard, Table } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { CATEGORY_LABEL, formatDuration, todayIso } from '@/lib/format';
import type { AppUsageRow, ProductivityCategory } from '@/lib/types';

const CATEGORY_COLORS: Record<ProductivityCategory, string> = {
  PRODUCTIVE: '#10b981',
  UNPRODUCTIVE: '#f43f5e',
  NEUTRAL: '#94a3b8',
};

export default function UsagePage() {
  const { user } = useAuthUser();
  const [date, setDate] = useState(todayIso());
  const [userId, setUserId] = useState('');
  const [groupBy, setGroupBy] = useState<'app' | 'domain'>('app');

  const targetUserId = user?.role === 'employee' ? user.id : userId || undefined;
  const { data, error, loaded, refresh } = useApi(
    () => api.reports.usage({ userId: targetUserId, date, groupBy }),
    [targetUserId, date, groupBy],
  );

  const items: AppUsageRow[] = data?.items ?? [];
  const totals = items.reduce(
    (acc, item) => {
      acc[item.category] += item.seconds;
      acc.total += item.seconds;
      return acc;
    },
    { PRODUCTIVE: 0, UNPRODUCTIVE: 0, NEUTRAL: 0, total: 0 },
  );

  return (
    <>
      <Card title="Filtreler" subtitle="Uygulama veya domain bazli dagilim">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {user?.role !== 'employee' && <UserSelect value={userId} onChange={setUserId} label="Personel" />}
          <Field label="Tarih">
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Kirilim">
            <div className="flex gap-1 pt-1">
              {(['app', 'domain'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGroupBy(option)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    groupBy === option
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {option === 'app' ? 'Uygulama' : 'Domain'}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Card>

      {error && <ErrorBanner message={error} onRetry={refresh} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Toplam aktif sure" value={formatDuration(totals.total)} tone="info" />
        <StatCard label="Uretken" value={formatDuration(totals.PRODUCTIVE)} tone="success" />
        <StatCard label="Uretken degil" value={formatDuration(totals.UNPRODUCTIVE)} tone="danger" />
        <StatCard label="Notr" value={formatDuration(totals.NEUTRAL)} />
      </div>

      {!loaded && <Spinner />}

      {loaded && items.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card
            title="Kategori dagilimi"
            subtitle={`${groupBy === 'app' ? 'Uygulama' : 'Domain'} sureleri kategorilere gore`}
          >
            <Donut
              data={(
                [
                  ['PRODUCTIVE', 'Uretken'],
                  ['UNPRODUCTIVE', 'Uretken degil'],
                  ['NEUTRAL', 'Notr'],
                ] as const
              ).map(([key, label]) => ({
                label,
                value: totals[key],
                color: CATEGORY_COLORS[key],
              }))}
            />
          </Card>

          <Card title={`En cok kullanilan ${groupBy === 'app' ? 'uygulamalar' : 'domainler'}`}>
            <BarList
              items={items.slice(0, 10).map((item) => ({
                label: item.label,
                value: item.seconds,
                category: item.category,
              }))}
            />
          </Card>
        </div>
      )}

      {loaded && items.length === 0 && (
        <EmptyState title="Bu gun icin kullanim verisi yok" description="Secilen tarihte aktivite kaydi bulunamadi." />
      )}

      {items.length > 0 && (
        <Card title="Detayli dokum">
          <Table head={[groupBy === 'app' ? 'Uygulama' : 'Domain', 'Kategori', 'Sure', 'Tus vurusu', 'Fare olayi']}>
            {items.map((item) => (
              <tr key={item.key} className="hover:bg-slate-50/70">
                <td className="td font-medium text-slate-700">{item.label}</td>
                <td className="td">
                  <Badge
                    tone={
                      item.category === 'PRODUCTIVE' ? 'green' : item.category === 'UNPRODUCTIVE' ? 'rose' : 'slate'
                    }
                  >
                    {CATEGORY_LABEL[item.category]}
                  </Badge>
                </td>
                <td className="td">{formatDuration(item.seconds)}</td>
                <td className="td text-slate-600">{item.keyboardEvents.toLocaleString('tr-TR')}</td>
                <td className="td text-slate-600">{item.mouseEvents.toLocaleString('tr-TR')}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
