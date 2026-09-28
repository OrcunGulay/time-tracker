'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { UserSelect } from '@/components/UserSelect';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Spinner } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { formatBytes, formatDateTime, formatDuration, todayIso } from '@/lib/format';
import type { ScreenshotItem } from '@/lib/types';

export default function ScreenshotsPage() {
  const { user } = useAuthUser();
  const [date, setDate] = useState(todayIso());
  const [userId, setUserId] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [selected, setSelected] = useState<ScreenshotItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const targetUserId = user?.role === 'employee' ? user.id : userId || undefined;
  const range = useMemo(() => {
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start.getTime() + 86_400_000);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [date]);

  const { data, error, loaded, refresh } = useApi(
    () =>
      api.screenshots.list({
        userId: targetUserId,
        from: range.from,
        to: range.to,
        includeDeleted,
        limit: 60,
      }),
    [targetUserId, range.from, range.to, includeDeleted],
  );

  const items = data?.items ?? [];

  const removeScreenshot = async (item: ScreenshotItem) => {
    if (!item) return;
    const confirmed = window.confirm(
      'Bu ekran goruntusunu silmek uzere misiniz?\n\n' +
        'Gizlilik protokolu geregi silinen karenin ait oldugu 10 dakikalik blok ' +
        'mesai suresinden dusulur ve bu islem denetim kaydina yazilir.',
    );
    if (!confirmed) return;

    setBusy(true);
    setActionError(null);
    try {
      const response = await api.screenshots.remove(item.id);
      setNotice(response.notice);
      setSelected(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Silme islemi basarisiz');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title="Ekran goruntusu galerisi"
        subtitle="Rastgele zamanlanmis kareler; silinen kayitlar mesai suresinden dusulur"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {user?.role !== 'employee' && <UserSelect value={userId} onChange={setUserId} label="Personel" />}
          <Field label="Tarih">
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Gorunum">
            <label className="flex items-center gap-2 pt-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={includeDeleted}
                onChange={(event) => setIncludeDeleted(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Silinenleri de goster
            </label>
          </Field>
        </div>
      </Card>

      {notice && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-700">
          {notice}
        </div>
      )}
      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} onRetry={refresh} />}

      {!loaded && <Spinner />}
      {loaded && items.length === 0 && (
        <EmptyState
          title="Bu gun icin ekran goruntusu yok"
          description="Agent her 10 dakikalik blokta rastgele bir saniyede kare alir."
        />
      )}

      {items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelected(item)}
              className="group overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition hover:shadow-md"
            >
              <div className="relative aspect-video bg-slate-100">
                {item.url ? (
                  // Presigned URL: next/image optimizasyonu kullanilamaz
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.url}
                    alt={`Ekran goruntusu ${item.timestamp}`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-500">
                    Goruntu silindi
                  </div>
                )}
                <div className="absolute left-2 top-2 flex gap-1">
                  <Badge tone="brand">Monitör {item.monitorIndex + 1}</Badge>
                  {item.blurApplied && <Badge tone="violet">Bulanik</Badge>}
                  {item.deletedAt && <Badge tone="rose">Silindi</Badge>}
                </div>
              </div>
              <div className="space-y-1 p-3">
                <p className="text-sm font-medium text-slate-800">{formatDateTime(item.timestamp)}</p>
                <p className="text-xs text-slate-500">
                  {item.width && item.height ? `${item.width}x${item.height} · ` : ''}
                  {formatBytes(item.sizeBytes)}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4"
          onClick={() => setSelected(null)}
          role="presentation"
        >
          <div
            className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">
                  {formatDateTime(selected.timestamp)}
                </h3>
                <p className="text-xs text-slate-500">
                  Monitör {selected.monitorIndex + 1} · {selected.monitorName ?? '-'} ·{' '}
                  {formatBytes(selected.sizeBytes)}
                  {selected.blurApplied ? ' · bulaniklastirilmis' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selected.deletedAt ? (
                  <Badge tone="rose">
                    Silindi · {formatDuration(selected.deductedSeconds)} dusuldu
                  </Badge>
                ) : (
                  user?.id === selected.userId && (
                    <Button variant="danger" size="sm" onClick={() => removeScreenshot(selected)} disabled={busy}>
                      {busy ? 'Siliniyor...' : 'Bu goruntuyu sil'}
                    </Button>
                  )
                )}
                <Button variant="secondary" size="sm" onClick={() => setSelected(null)}>
                  Kapat
                </Button>
              </div>
            </div>

            {selected.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selected.url} alt="Ekran goruntusu" className="w-full rounded-xl" />
            ) : (
              <div className="rounded-xl bg-slate-100 py-24 text-center text-sm text-slate-500">
                Goruntu silinmis (S3 nesnesi kaldirildi)
              </div>
            )}

            <p className="mt-3 text-xs text-slate-500">
              Gizlilik protokolu: kendi karenizi sildiginizde ilgili 10 dakikalik blok mesai suresinden
              dusulur ve islem denetim kaydina yazilir.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
