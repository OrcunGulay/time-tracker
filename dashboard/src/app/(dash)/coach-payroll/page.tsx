'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Select, Spinner, StatCard, Table } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';
import type { CoachMeeting, CoachPayrollRecord, CoachRate } from '@/lib/types';

const MONTH_OPTIONS = [
  { value: '2026-03', label: '15 Şubat 2026 – 15 Mart 2026' },
  { value: '2026-02', label: '15 Ocak 2026 – 15 Şubat 2026' },
  { value: '2026-01', label: '15 Aralık 2025 – 15 Ocak 2026' },
  { value: '2025-12', label: '15 Kasım 2025 – 15 Aralık 2025' },
  { value: '2025-11', label: '15 Ekim 2025 – 15 Kasım 2025' },
];

function downloadCsv(content: string, filename: string) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function CoachPayrollPage() {
  const { user } = useAuthUser();
  const isStaff = user?.role === 'admin' || user?.role === 'manager';

  const [selectedMonth, setSelectedMonth] = useState('2026-03');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'warning'>('all');
  const [expandedCoachId, setExpandedCoachId] = useState<string | null>(null);

  // Senkronizasyon ve Bildirim Durumu
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Ücret Baremleri Modalı
  const [ratesModalOpen, setRatesModalOpen] = useState(false);
  const [editingRates, setEditingRates] = useState<CoachRate[]>([]);
  const [loadingRates, setLoadingRates] = useState(false);
  const [savingRates, setSavingRates] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatRate, setNewCatRate] = useState<number>(400);

  // Ana Koç Hakediş Verisini Çekme
  const { data, error, loaded, refresh } = useApi(
    () => api.coachPayroll.summary(selectedMonth),
    [selectedMonth],
  );

  const items: CoachPayrollRecord[] = data?.items ?? [];

  // Filtreleme
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchSearch =
        item.coachName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.meetings.some((m) => m.topic.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchSearch) return false;

      if (statusFilter === 'ok') return !item.hasError;
      if (statusFilter === 'warning') return item.hasError;
      return true;
    });
  }, [items, searchTerm, statusFilter]);

  // Google Drive Senkronizasyon Tetikleyicisi
  const triggerSync = async () => {
    setSyncing(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.coachPayroll.sync(selectedMonth);
      setNotice(res.message);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Google Drive senkronizasyonu başarısız oldu.');
    } finally {
      setSyncing(false);
    }
  };

  // Ücret Baremleri Modalını Aç
  const openRatesModal = async () => {
    setRatesModalOpen(true);
    setLoadingRates(true);
    setActionError(null);
    try {
      const res = await api.coachPayroll.rates();
      setEditingRates(res.rates);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ücret baremleri yüklenemedi.');
    } finally {
      setLoadingRates(false);
    }
  };

  // Ücret Baremini Güncelle
  const handleRateChange = (index: number, newRate: number) => {
    setEditingRates((prev) => {
      const next = [...prev];
      const target = next[index];
      if (target) {
        next[index] = { ...target, rate: Math.max(0, newRate) };
      }
      return next;
    });
  };

  // Yeni Kategori Ekle
  const handleAddCategory = () => {
    if (!newCatName.trim()) return;
    if (editingRates.some((r) => r.categoryName.toLowerCase() === newCatName.trim().toLowerCase())) {
      alert('Bu kategori zaten mevcut.');
      return;
    }
    setEditingRates((prev) => [
      ...prev,
      {
        id: `temp-${Date.now()}`,
        categoryName: newCatName.trim(),
        rate: newCatRate,
        currency: 'TRY',
        description: null,
      },
    ]);
    setNewCatName('');
    setNewCatRate(400);
  };

  // Ücret Baremlerini Kaydet
  const saveRates = async () => {
    setSavingRates(true);
    try {
      await api.coachPayroll.updateRates({
        rates: editingRates.map((r) => ({
          categoryName: r.categoryName,
          rate: r.rate,
          currency: r.currency,
          description: r.description ?? undefined,
        })),
        month: selectedMonth,
      });
      setRatesModalOpen(false);
      setNotice('Birim ücretler güncellendi ve hakediş tutarları yeniden hesaplandı.');
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Birim ücretler kaydedilemedi.');
    } finally {
      setSavingRates(false);
    }
  };

  // CSV Dışa Aktarma
  const exportCsv = () => {
    if (!data) return;

    let csv = `KOÇ HAKEDİŞ VE ÖDEME RAPORU\n`;
    csv += `Dönem:;${data.periodLabel} (${data.month})\n`;
    csv += `Toplam Ödenecek:;${data.totalAmount} TL\n`;
    csv += `Toplam Toplantı:;${data.totalMeetings}\n`;
    csv += `Koç Sayısı:;${data.totalCoaches}\n\n`;

    csv += `KOÇ BAZLI ÖZET TABLOSU\n`;
    csv += `Koç Adı;Toplam Toplantı;Toplam Hak Ediş (TL);Durum;Kategori Dağılımı;Hata / Açıklama\n`;

    for (const item of items) {
      const catSummary = Object.entries(item.categoryBreakdown)
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(' | ');
      const statusText = item.hasError ? 'Uyarı: Tablo Bulunamadı' : 'Başarılı';
      const errorMsg = item.errorMessage ? `"${item.errorMessage.replace(/"/g, '""')}"` : '';

      csv += `"${item.coachName}";${item.totalMeetings};${item.totalAmount};${statusText};"${catSummary}";${errorMsg}\n`;
    }

    csv += `\n\nDETAYLI ZOOM TOPLANTILARI LİSTESİ\n`;
    csv += `Koç Adı;Tarih;Saat;Öğrenci / Konu;Kategori;Hesaplanan Ücret (TL)\n`;

    for (const item of items) {
      for (const m of item.meetings) {
        csv += `"${item.coachName}";${m.date};"${m.time ?? ''}";"${m.topic.replace(/"/g, '""')}";"${m.category}";${m.rate}\n`;
      }
    }

    downloadCsv(csv, `koc_hakedis_${data.month}.csv`);
    setNotice('Koç hakediş tablosu ve toplantı detayları CSV formatında indirildi.');
  };

  const toggleExpand = (coachId: string) => {
    setExpandedCoachId((curr) => (curr === coachId ? null : coachId));
  };

  const getCategoryTone = (cat: string): 'brand' | 'violet' | 'amber' | 'green' | 'slate' => {
    const l = cat.toLowerCase();
    if (l.includes('bireysel')) return 'brand';
    if (l.includes('grup')) return 'violet';
    if (l.includes('deneme')) return 'amber';
    if (l.includes('veli')) return 'green';
    return 'slate';
  };

  return (
    <div className="space-y-6">
      {/* Üst Bar: Dönem Seçici & Eylem Butonları */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            </span>
            <span>Koç Hakediş ve Ödeme Yönetimi</span>
          </div>
        }
        subtitle="Google Drive üzerindeki koç klasörlerinden 'İşleyiş Tablosu' verileri taranarak hesaplanır"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Hesaplama Dönemi">
              <Select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="w-64 font-medium text-slate-800"
              >
                {MONTH_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={triggerSync}
                disabled={syncing}
                className="hover:border-indigo-300"
                title="Google Drive'daki tüm koç klasörlerini yeniden tara"
              >
                {syncing ? (
                  <Spinner label="Taranıyor..." />
                ) : (
                  <>
                    <svg className="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                    <span>Drive'dan Senkronize Et</span>
                  </>
                )}
              </Button>

              {isStaff && (
                <Button
                  variant="secondary"
                  onClick={openRatesModal}
                  className="hover:border-indigo-300"
                >
                  <svg className="h-4 w-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span>Birim Ücret Ayarları</span>
                </Button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={exportCsv}
              disabled={!data || items.length === 0}
              className="bg-emerald-50 text-emerald-700 hover:bg-emerald-100 ring-emerald-200"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span>Excel / CSV Olarak İndir</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* Bildirim ve Hata Mesajları */}
      {notice && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/90 px-4 py-3 text-sm text-emerald-800 shadow-sm">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-600 hover:text-emerald-800 text-xs font-semibold"
          >
            Kapat
          </button>
        </div>
      )}

      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} onRetry={refresh} />}

      {/* Özet İstatistik Kartları */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Toplam Ödenecek Hakediş"
          value={formatMoney(data?.totalAmount ?? 0, data?.currency ?? 'TRY')}
          tone="success"
          hint={`Dönem: ${data?.periodLabel ?? ''}`}
        />
        <StatCard
          label="Toplam Zoom Toplantısı"
          value={`${data?.totalMeetings ?? 0} Seans`}
          tone="info"
          hint="İki ayın 15'i arasındaki toplantılar"
        />
        <StatCard
          label="Aktif Koç Sayısı"
          value={`${data?.activeCoaches ?? 0} / ${data?.totalCoaches ?? 0}`}
          tone="default"
          hint="Tablosu başarıyla okunan koçlar"
        />
        <StatCard
          label="Uyarı / Eksik Tablo"
          value={`${data?.warningCoaches ?? 0} Koç`}
          tone={data && data.warningCoaches > 0 ? 'warning' : 'default'}
          hint={data && data.warningCoaches > 0 ? 'İşleyiş tablosu bulunamayanlar' : 'Tüm koç tabloları eksiksiz'}
        />
      </div>

      {/* Arama ve Filtreleme Çubuğu */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Input
            placeholder="Koç adı veya öğrenci/konu ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
          <svg
            className="absolute left-3 top-2.5 h-4 w-4 text-slate-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-500">Durum:</span>
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              statusFilter === 'all'
                ? 'bg-slate-800 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            Tümü ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('ok')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              statusFilter === 'ok'
                ? 'bg-emerald-600 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            Sorunsuz ({items.filter((i) => !i.hasError).length})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('warning')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              statusFilter === 'warning'
                ? 'bg-amber-600 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            Uyarı Alanlar ({items.filter((i) => i.hasError).length})
          </button>
        </div>
      </div>

      {!loaded && <Spinner label="Koç hakediş verileri yükleniyor..." />}

      {loaded && filteredItems.length === 0 && (
        <EmptyState
          title="Seçilen dönem ve filtreye uygun koç kaydı bulunamadı"
          description="Yukarıdaki 'Drive'dan Senkronize Et' butonunu kullanarak Google Drive'ı tarayabilirsiniz."
        />
      )}

      {/* Ana Tablo / Akordiyon */}
      {loaded && filteredItems.length > 0 && (
        <Card
          title={
            <div className="flex items-center justify-between">
              <span>Koç Hak Ediş Tablosu ({filteredItems.length} Koç)</span>
              <span className="text-xs font-normal text-slate-500">
                Toplantı listesini görmek için satıra tıklayın
              </span>
            </div>
          }
          subtitle={`Dönem aralığı: ${data?.periodLabel ?? ''}`}
        >
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {/* Tablo Başlığı */}
            <div className="grid grid-cols-12 bg-slate-50/80 px-4 py-3 text-xs font-semibold text-slate-600">
              <div className="col-span-4 sm:col-span-3">Koç Adı</div>
              <div className="col-span-2 text-center">Toplantı</div>
              <div className="col-span-3 hidden sm:block">Kategori Dağılımı</div>
              <div className="col-span-3 sm:col-span-2 text-right">Hak Ediş Tutarı</div>
              <div className="col-span-3 sm:col-span-2 text-center">Durum</div>
            </div>

            {/* Koç Satırları (Akordiyon) */}
            {filteredItems.map((coach) => {
              const isExpanded = expandedCoachId === coach.id;

              return (
                <div key={coach.id} className="transition-colors">
                  {/* Tıklanabilir Özet Satırı */}
                  <div
                    onClick={() => toggleExpand(coach.id)}
                    className={`grid grid-cols-12 cursor-pointer items-center px-4 py-3.5 transition-colors hover:bg-slate-50/90 ${
                      isExpanded ? 'bg-indigo-50/30 ring-1 ring-inset ring-indigo-200/50' : ''
                    } ${coach.hasError ? 'bg-amber-50/20' : ''}`}
                  >
                    {/* Koç Adı */}
                    <div className="col-span-4 sm:col-span-3 flex items-center gap-2.5">
                      <button
                        type="button"
                        aria-label={isExpanded ? 'Daralt' : 'Genişlet'}
                        className="text-slate-400 hover:text-indigo-600 transition"
                      >
                        <svg
                          className={`h-4 w-4 transform transition-transform duration-200 ${
                            isExpanded ? 'rotate-90 text-indigo-600' : ''
                          }`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 font-semibold text-slate-700 text-xs shadow-inner">
                        {coach.coachName
                          .split(' ')
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join('')}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">{coach.coachName}</p>
                        {coach.spreadsheetName && (
                          <p className="truncate text-[11px] text-slate-400">{coach.spreadsheetName}</p>
                        )}
                      </div>
                    </div>

                    {/* Toplantı Sayısı */}
                    <div className="col-span-2 text-center">
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-800">
                        {coach.totalMeetings} Seans
                      </span>
                    </div>

                    {/* Kategori Dağılımı Özeti */}
                    <div className="col-span-3 hidden sm:flex flex-wrap gap-1">
                      {Object.keys(coach.categoryBreakdown).length > 0 ? (
                        Object.entries(coach.categoryBreakdown).map(([cat, count]) => (
                          <Badge key={cat} tone={getCategoryTone(cat)}>
                            {count} {cat}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </div>

                    {/* Hak Ediş Tutarı */}
                    <div className="col-span-3 sm:col-span-2 text-right">
                      <span className="text-sm font-bold text-slate-900">
                        {formatMoney(coach.totalAmount, data?.currency ?? 'TRY')}
                      </span>
                    </div>

                    {/* Durum Rozeti: Hatalı olanlara Sarı Uyarı Rozeti */}
                    <div className="col-span-3 sm:col-span-2 flex items-center justify-center">
                      {coach.hasError ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-300"
                          title={coach.errorMessage ?? 'İşleyiş tablosu formatı doğrulanamadı'}
                        >
                          <svg className="h-3.5 w-3.5 text-amber-600" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                              clipRule="evenodd"
                            />
                          </svg>
                          <span>Tablo Eksik / Hata</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          <span>Hesaplandı</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Satır Genişletme: Toplantı Detay Listesi */}
                  {isExpanded && (
                    <div className="border-t border-slate-200/80 bg-slate-50/70 p-4 transition-all">
                      {coach.hasError ? (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-800">
                          <div className="flex items-start gap-2">
                            <svg className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <div>
                              <p className="font-semibold text-amber-900">Otomasyon Uyarısı</p>
                              <p className="mt-0.5 text-xs text-amber-800">
                                {coach.errorMessage || 'Bu koçun klasöründe "İşleyiş Tablosu" isimli dosya tespit edilemedi veya Excel yapısı okunamadı.'}
                              </p>
                              {coach.driveFolderId && (
                                <p className="mt-1 text-[11px] text-amber-700">
                                  Drive Klasör ID: <code className="rounded bg-amber-100 px-1 py-0.5">{coach.driveFolderId}</code>
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : coach.meetings.length === 0 ? (
                        <div className="rounded-lg border border-slate-200 bg-white p-4 text-center text-xs text-slate-500">
                          Bu koç için {data?.periodLabel} aralığında herhangi bir Zoom toplantısı bulunamadı.
                        </div>
                      ) : (
                        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                          <div className="border-b border-slate-200 bg-slate-100/60 px-4 py-2 text-xs font-semibold text-slate-700 flex justify-between items-center">
                            <span>Toplantı Detayları ({coach.meetings.length} Toplantı)</span>
                            <span className="text-slate-500 font-normal">
                              Tarih aralığı: {data?.periodStart} / {data?.periodEnd}
                            </span>
                          </div>
                          <table className="min-w-full divide-y divide-slate-100 text-xs">
                            <thead className="bg-slate-50 text-slate-500">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium">Tarih</th>
                                <th className="px-3 py-2 text-left font-medium">Saat</th>
                                <th className="px-3 py-2 text-left font-medium">Toplantı Konusu / Öğrenci</th>
                                <th className="px-3 py-2 text-left font-medium">Kategori</th>
                                <th className="px-3 py-2 text-right font-medium">Hesaplanan Ücret</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {coach.meetings.map((m: CoachMeeting, index: number) => (
                                <tr key={m.id || index} className="hover:bg-slate-50/50">
                                  <td className="px-3 py-2 font-medium text-slate-700 whitespace-nowrap">
                                    {m.date}
                                  </td>
                                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                                    {m.time || '-'}
                                  </td>
                                  <td className="px-3 py-2 text-slate-800 font-medium">
                                    {m.topic}
                                  </td>
                                  <td className="px-3 py-2">
                                    <Badge tone={getCategoryTone(m.category)}>{m.category}</Badge>
                                  </td>
                                  <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                                    {formatMoney(m.rate, data?.currency ?? 'TRY')}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-800">
                              <tr>
                                <td colSpan={4} className="px-3 py-2 text-right">
                                  Koç Toplam Hakedişi:
                                </td>
                                <td className="px-3 py-2 text-right text-emerald-800 font-bold">
                                  {formatMoney(coach.totalAmount, data?.currency ?? 'TRY')}
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Birim Ücret Ayarları Modalı */}
      {ratesModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Birim Ücret Ayarları (TL)</h3>
                <p className="text-xs text-slate-500">
                  Her toplantı kategorisinin seans başı hakediş bedelini belirleyin
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRatesModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 space-y-3 max-h-80 overflow-y-auto pr-1">
              {loadingRates ? (
                <Spinner label="Baremler getiriliyor..." />
              ) : (
                editingRates.map((rateItem, idx) => (
                  <div
                    key={rateItem.id || rateItem.categoryName}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm text-slate-800">{rateItem.categoryName}</p>
                      {rateItem.description && (
                        <p className="text-[11px] text-slate-500">{rateItem.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 w-32">
                      <Input
                        type="number"
                        min="0"
                        step="50"
                        value={rateItem.rate}
                        onChange={(e) => handleRateChange(idx, Number(e.target.value))}
                        className="text-right font-semibold"
                      />
                      <span className="text-xs font-semibold text-slate-500">₺</span>
                    </div>
                  </div>
                ))
              )}

              {/* Yeni Kategori Ekleme */}
              <div className="pt-2 border-t border-slate-100">
                <p className="text-xs font-semibold text-slate-700 mb-2">+ Yeni Kategori Ekle</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Örn: Rehberlik"
                    value={newCatName}
                    onChange={(e) => setNewCatName(e.target.value)}
                    className="flex-1 text-xs"
                  />
                  <Input
                    type="number"
                    min="0"
                    step="50"
                    placeholder="Ücret"
                    value={newCatRate}
                    onChange={(e) => setNewCatRate(Number(e.target.value))}
                    className="w-24 text-right text-xs font-semibold"
                  />
                  <Button size="sm" variant="secondary" onClick={handleAddCategory}>
                    Ekle
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <Button variant="secondary" onClick={() => setRatesModalOpen(false)}>
                Vazgeç
              </Button>
              <Button onClick={saveRates} disabled={savingRates || loadingRates}>
                {savingRates ? 'Kaydediliyor...' : 'Kaydet ve Hakedişleri Güncelle'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
