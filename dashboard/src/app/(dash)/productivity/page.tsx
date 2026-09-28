'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Donut, StackedProductivity } from '@/components/charts';
import { UserSelect } from '@/components/UserSelect';
import { Badge, Card, EmptyState, ErrorBanner, Field, Input, ProgressBar, Spinner, StatCard, Table } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { formatDuration, formatScore, monthStartIso, todayIso } from '@/lib/format';

export default function ProductivityPage() {
  const { user } = useAuthUser();
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [userId, setUserId] = useState('');

  const targetUserId = user?.role === 'employee' ? user.id : userId || undefined;
  const { data, error, loaded, refresh } = useApi(
    () => api.reports.productivity({ from, to, userId: targetUserId }),
    [from, to, targetUserId],
  );

  const overall = data?.overall;
  const rows = data?.users ?? [];

  return (
    <>
      <Card title="Donem" subtitle="Uretkenlik skoru: uretken / (uretken + uretken degil + notr agirlikli)">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Baslangic">
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="Bitis">
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          {user?.role !== 'employee' && <UserSelect value={userId} onChange={setUserId} label="Personel" />}
        </div>
      </Card>

      {error && <ErrorBanner message={error} onRetry={refresh} />}
      {!loaded && <Spinner />}

      {loaded && overall && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Genel skor"
              value={formatScore(overall.score)}
              tone={overall.score >= 60 ? 'success' : overall.score >= 40 ? 'warning' : 'danger'}
            />
            <StatCard label="Uretken sure" value={formatDuration(overall.productiveSeconds)} tone="success" />
            <StatCard
              label="Uretken olmayan sure"
              value={formatDuration(overall.unproductiveSeconds)}
              tone="danger"
            />
            <StatCard label="Notr sure" value={formatDuration(overall.neutralSeconds)} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Skor dagilimi">
              <Donut
                data={[
                  { label: 'Uretken', value: overall.productiveSeconds, color: '#10b981' },
                  { label: 'Uretken degil', value: overall.unproductiveSeconds, color: '#f43f5e' },
                  { label: 'Notr', value: overall.neutralSeconds, color: '#94a3b8' },
                ]}
                centerLabel="genel skor"
                centerValue={formatScore(overall.score)}
              />
            </Card>

            <Card title="Kompozisyon" subtitle={`Notr agirligi: ${data?.neutralWeight ?? 0}`}>
              <StackedProductivity
                productive={overall.productiveSeconds}
                unproductive={overall.unproductiveSeconds}
                neutral={overall.neutralSeconds}
              />
              <p className="mt-4 text-xs text-slate-500">
                Skor hesabi backend'de yapilir; kategori kurallari Uretim/Ayarlar sayfasindan yonetilir.
              </p>
            </Card>
          </div>
        </>
      )}

      {loaded && rows.length === 0 && <EmptyState title="Bu donem icin veri yok" />}

      {rows.length > 0 && (
        <Card title="Personel kirilimi">
          <Table head={['Personel', 'Skor', 'Uretken', 'Uretken degil', 'Notr', 'Toplam']}>
            {rows.map((row) => (
              <tr key={row.userId} className="hover:bg-slate-50/70">
                <td className="td">
                  <div className="font-medium text-slate-800">{row.userName}</div>
                  <div className="text-xs text-slate-500">{row.email}</div>
                </td>
                <td className="td w-40">
                  <div className="flex items-center gap-2">
                    <span className="w-12 font-semibold text-slate-800">{formatScore(row.score)}</span>
                    <ProgressBar
                      value={row.score}
                      tone={row.score >= 60 ? 'green' : row.score >= 40 ? 'amber' : 'rose'}
                    />
                  </div>
                </td>
                <td className="td text-emerald-700">{formatDuration(row.productiveSeconds)}</td>
                <td className="td text-rose-700">{formatDuration(row.unproductiveSeconds)}</td>
                <td className="td text-slate-600">{formatDuration(row.neutralSeconds)}</td>
                <td className="td">
                  <Badge tone="brand">{formatDuration(row.totalSeconds)}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
