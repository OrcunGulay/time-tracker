'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { UserSelect } from '@/components/UserSelect';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Spinner, StatCard, Table } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { formatDuration, formatHours, formatMoney, monthStartIso, todayIso } from '@/lib/format';
import type { PayrollLine } from '@/lib/types';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function PayrollPage() {
  const { user } = useAuthUser();
  const isStaff = user?.role === 'admin' || user?.role === 'manager';
  const [periodStart, setPeriodStart] = useState(monthStartIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, loaded, refresh } = useApi(
    () =>
      isStaff
        ? api.payroll.summary({ periodStart, periodEnd, userId: userId || undefined })
        : api.payroll.mine({ periodStart, periodEnd }),
    [periodStart, periodEnd, userId, isStaff],
  );

  const items: PayrollLine[] = data?.items ?? [];

  const exportFile = async (format: 'csv' | 'pdf') => {
    setBusy(true);
    setActionError(null);
    try {
      const blob = await api.payroll.download({
        periodStart,
        periodEnd,
        userId: userId || undefined,
        format,
      });
      downloadBlob(blob, `bordro_${periodStart}_${periodEnd}.${format}`);
      setNotice(`${format.toUpperCase()} raporu indirildi.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rapor indirilemedi');
    } finally {
      setBusy(false);
    }
  };

  const issuePeriod = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await api.payroll.issue({ periodStart, periodEnd });
      setNotice(`${response.issued} personel icin bordro donemi donduruldu (issued).`);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Bordro dondurulamadi');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Donem ve personel" subtitle="Onaylanan oturumlara gore odenebilir saatler hesaplanir">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Baslangic">
            <Input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
          </Field>
          <Field label="Bitis">
            <Input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
          </Field>
          {isStaff && <UserSelect value={userId} onChange={setUserId} label="Personel" />}
          <Field label="Cikti">
            <div className="flex gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={() => exportFile('csv')} disabled={busy}>
                CSV
              </Button>
              <Button variant="secondary" size="sm" onClick={() => exportFile('pdf')} disabled={busy}>
                PDF fatura
              </Button>
              {isStaff && (
                <Button size="sm" onClick={issuePeriod} disabled={busy || items.length === 0}>
                  Donemi dondur
                </Button>
              )}
            </div>
          </Field>
        </div>
      </Card>

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}
      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} onRetry={refresh} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Odenebilir sure" value={formatHours(data?.totalSeconds ?? 0)} tone="info" />
        <StatCard
          label="Toplam maliyet"
          value={formatMoney(data?.totalAmount ?? 0, data?.currency ?? 'TRY')}
          tone="success"
        />
        <StatCard label="Personel" value={items.length} />
        <StatCard
          label="Onay bekleyen sure"
          value={formatHours(items.reduce((sum, item) => sum + item.unapprovedSeconds, 0))}
          tone="warning"
        />
      </div>

      {!loaded && <Spinner />}
      {loaded && items.length === 0 && (
        <EmptyState title="Bu donem icin bordro verisi yok" description="Durdurulmus oturumlar onay bekliyor olabilir." />
      )}

      {items.length > 0 && (
        <Card
          title="Bordro dokumu"
          subtitle="Odenebilir = toplam - bosluk - silinen bloklar (+ sayilan bosluklar)"
        >
          <Table
            head={[
              'Personel',
              'Odenebilir',
              'Saatlik',
              'Tutar',
              'Onayli',
              'Onaysiz',
              'Bosluk',
              'Oturum',
              'Uretkenlik',
            ]}
          >
            {items.map((item) => (
              <tr key={item.userId} className="hover:bg-slate-50/70">
                <td className="td">
                  <div className="font-medium text-slate-800">{item.userName}</div>
                  <div className="text-xs text-slate-500">{item.email}</div>
                </td>
                <td className="td font-medium">{formatHours(item.payableSeconds)}</td>
                <td className="td text-slate-600">{formatMoney(item.hourlyRate, item.currency)}</td>
                <td className="td font-semibold text-slate-800">{formatMoney(item.amount, item.currency)}</td>
                <td className="td text-emerald-700">{formatHours(item.approvedSeconds)}</td>
                <td className="td text-amber-700">{formatHours(item.unapprovedSeconds)}</td>
                <td className="td text-slate-600">{formatDuration(item.idleSeconds ?? 0)}</td>
                <td className="td text-slate-600">{item.sessionCount}</td>
                <td className="td">
                  <Badge tone={(item.productivityScore ?? 0) >= 60 ? 'green' : 'amber'}>
                    {(item.productivityScore ?? 0).toFixed(1)}%
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
