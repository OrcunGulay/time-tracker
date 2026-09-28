'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Donut } from '@/components/charts';
import { Badge, Button, Card, EmptyState, ErrorBanner, Spinner, StatCard } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { formatBytes, formatDateTime, formatDuration, formatHours, formatMoney, formatScore, monthStartIso, todayIso } from '@/lib/format';

export default function MyRecordsPage() {
  const { user } = useAuthUser();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const daily = useApi(
    () => api.reports.daily({ date: todayIso(), userId: user?.id }),
    [user?.id],
    { enabled: Boolean(user?.id), intervalMs: 30_000 },
  );

  const screenshots = useApi(
    () => api.screenshots.list({ userId: user?.id, limit: 8 }),
    [user?.id],
    { enabled: Boolean(user?.id) },
  );

  const payroll = useApi(
    () => api.payroll.mine({ periodStart: monthStartIso(), periodEnd: todayIso() }),
    [user?.id],
    { enabled: Boolean(user?.id) },
  );

  const today = daily.data?.rows?.[0];
  const items = screenshots.data?.items ?? [];
  const payrollLine = payroll.data?.items?.[0];

  const remove = async (id: string) => {
    const confirmed = window.confirm(
      'Bu ekran goruntusunu silmek istiyor musunuz?\n\n' +
        'Silinen karenin ait oldugu 10 dakikalik blok mesai suresinden dusulur ve denetim kaydina yazilir.',
    );
    if (!confirmed) return;
    setDeleting(id);
    try {
      const response = await api.screenshots.remove(id);
      setNotice(response.notice);
      screenshots.refresh();
      daily.refresh();
    } catch {
      setNotice('Silme islemi basarisiz oldu.');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <Card
        title={`Bugunun ozeti · ${user?.name ?? ''}`}
        subtitle="Kendi verinizi goruntuleyin ve gizlilik hakkınızı kullanin"
        actions={
          <Link href="/timeline" className="text-sm font-medium text-brand-600 hover:underline">
            Zaman cizelgesini ac
          </Link>
        }
      >
        {daily.error && <ErrorBanner message={daily.error} onRetry={daily.refresh} />}
        {!daily.loaded && <Spinner />}
        {daily.loaded && !today && (
          <EmptyState
            title="Bugun icin kayit yok"
            description="Desktop agent'ta 'Mesaiyi Baslat' dedikten sonra veriler burada gorunur."
          />
        )}
      </Card>

      {today && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Takip edilen" value={formatDuration(today.trackedSeconds)} tone="info" />
          <StatCard label="Odenebilir" value={formatDuration(today.payableSeconds)} tone="success" />
          <StatCard label="Bosta" value={formatDuration(today.idleSeconds)} tone="warning" />
          <StatCard label="Uretkenlik" value={formatScore(today.productivityScore)} />
        </div>
      )}

      {today && (
        <Card title="Uretkenlik dagilimi" subtitle="Bugunun kategori kirilimi">
          <Donut
            data={[
              { label: 'Uretken', value: today.productiveSeconds, color: '#10b981' },
              { label: 'Uretken degil', value: today.unproductiveSeconds, color: '#f43f5e' },
              { label: 'Notr', value: today.neutralSeconds, color: '#94a3b8' },
            ]}
            centerLabel="urelkenlik"
            centerValue={formatScore(today.productivityScore)}
          />
        </Card>
      )}

      <Card
        title="Son ekran goruntulerim"
        subtitle="Kisisel bir goruntu yakalandiysa silme hakkınız vardir"
        actions={
          <Link href="/screenshots" className="text-sm font-medium text-brand-600 hover:underline">
            Tum galeriyi ac
          </Link>
        }
      >
        {notice && (
          <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-700">
            {notice}
          </div>
        )}
        {screenshots.error && <ErrorBanner message={screenshots.error} onRetry={screenshots.refresh} />}
        {!screenshots.loaded && <Spinner />}
        {screenshots.loaded && items.length === 0 && (
          <EmptyState title="Ekran goruntusu yok" description="Mesai sirasinda rastgele zamanlarda kare alinir." />
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((item) => (
            <div key={item.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="aspect-video bg-slate-100">
                {item.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.url} alt="Ekran goruntusu" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-500">Silindi</div>
                )}
              </div>
              <div className="space-y-2 p-3">
                <p className="text-xs text-slate-600">{formatDateTime(item.timestamp)}</p>
                <p className="text-xs text-slate-400">
                  {item.width && item.height ? `${item.width}x${item.height} · ` : ''}
                  {formatBytes(item.sizeBytes)}
                  {item.blurApplied ? ' · bulanik' : ''}
                </p>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={deleting === item.id}
                  onClick={() => remove(item.id)}
                  className="w-full"
                >
                  {deleting === item.id ? 'Siliniyor...' : 'Sil'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Bordro ozetim" subtitle={`${monthStartIso()} - ${todayIso()}`}>
        {payroll.error && <ErrorBanner message={payroll.error} onRetry={payroll.refresh} />}
        {!payroll.loaded && <Spinner />}
        {payroll.loaded && !payrollLine && (
          <EmptyState title="Bu donemde bordro kaydi yok" description="Durdurulmus oturumlar onay bekliyor olabilir." />
        )}
        {payrollLine && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Odenebilir sure" value={formatHours(payrollLine.payableSeconds)} tone="info" />
            <StatCard label="Saatlik ucret" value={formatMoney(payrollLine.hourlyRate, payrollLine.currency)} />
            <StatCard
              label="Toplam tutar"
              value={formatMoney(payrollLine.amount, payrollLine.currency)}
              tone="success"
            />
            <StatCard
              label="Durum"
              value={<Badge tone={payrollLine.unapprovedSeconds > 0 ? 'amber' : 'green'}>
                {payrollLine.unapprovedSeconds > 0 ? 'Onay bekliyor' : 'Onaylandi'}
              </Badge>}
            />
          </div>
        )}
      </Card>
    </>
  );
}
