'use client';

import { useMemo } from 'react';
import type { ProductivityCategory, TimelineSlice } from '@/lib/types';
import { CATEGORY_LABEL, formatDuration, TIMELINE_STATE_LABEL } from '@/lib/format';

/** Pasta (donut) grafik - bagimliliksiz SVG. */
export function Donut({
  data,
  size = 190,
  thickness = 26,
  centerLabel,
  centerValue,
}: {
  data: Array<{ label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  const segments = useMemo(() => {
    let offset = 0;
    return data.map((item) => {
      const fraction = total > 0 ? item.value / total : 0;
      const length = fraction * circumference;
      const segment = { ...item, length, offset, fraction };
      offset += length;
      return segment;
    });
  }, [data, total, circumference]);

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {total === 0 && (
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="#e2e8f0"
                strokeWidth={thickness}
              />
            )}
            {segments.map((segment) => (
              <circle
                key={segment.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth={thickness}
                strokeDasharray={`${segment.length} ${circumference - segment.length}`}
                strokeDashoffset={-segment.offset}
                strokeLinecap="butt"
              >
                <title>{`${segment.label}: ${formatDuration(segment.value)}`}</title>
              </circle>
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold text-slate-800">{centerValue ?? formatDuration(total)}</span>
          {centerLabel && <span className="text-xs text-slate-500">{centerLabel}</span>}
        </div>
      </div>

      <ul className="w-full space-y-1.5">
        {data.map((item) => (
          <li key={item.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: item.color }} />
              <span className="truncate text-slate-700">{item.label}</span>
            </span>
            <span className="shrink-0 font-medium text-slate-600">
              {formatDuration(item.value)}
              <span className="ml-1 text-xs text-slate-400">
                {total > 0 ? `${Math.round((item.value / total) * 100)}%` : '0%'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Yatay cubuk listesi (uygulama/domain dagilimi). */
export function BarList({
  items,
  max: maxOverride,
  showCategory = true,
}: {
  items: Array<{ label: string; value: number; category?: ProductivityCategory }>;
  max?: number;
  showCategory?: boolean;
}) {
  const max = maxOverride ?? Math.max(1, ...items.map((item) => item.value));
  const colors: Record<string, string> = {
    PRODUCTIVE: 'bg-emerald-500',
    UNPRODUCTIVE: 'bg-rose-500',
    NEUTRAL: 'bg-slate-400',
  };

  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium text-slate-700">{item.label}</span>
            <span className="shrink-0 text-slate-500">
              {formatDuration(item.value)}
              {showCategory && item.category && (
                <span className="ml-2 text-xs text-slate-400">{CATEGORY_LABEL[item.category]}</span>
              )}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${colors[item.category ?? 'NEUTRAL'] ?? 'bg-brand-500'}`}
              style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

const TIMELINE_COLORS: Record<TimelineSlice['state'], string> = {
  active: 'bg-emerald-500',
  idle: 'bg-amber-400',
  unproductive: 'bg-rose-500',
  deducted: 'bg-violet-500',
  offline: 'bg-slate-200',
};

/** Gunun saat saat dokumu. */
export function TimelineStrip({ slots }: { slots: TimelineSlice[] }) {
  if (slots.length === 0) {
    return <p className="text-sm text-slate-500">Bu gun icin kayit yok.</p>;
  }
  return (
    <div>
      <div className="flex h-10 w-full overflow-hidden rounded-lg ring-1 ring-slate-200">
        {slots.map((slot, index) => {
          const start = new Date(slot.start);
          const end = new Date(slot.end);
          const hourLabel = start.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
          const endLabel = end.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
          return (
            <div
              key={index}
              className={`${TIMELINE_COLORS[slot.state]} h-full flex-1 border-r border-white/60 last:border-r-0 transition hover:opacity-80`}
              title={[
                `${hourLabel} - ${endLabel}`,
                TIMELINE_STATE_LABEL[slot.state],
                slot.activeApp ?? '',
                slot.domain ?? '',
                slot.windowTitle ? slot.windowTitle.slice(0, 90) : '',
              ]
                .filter(Boolean)
                .join(' | ')}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-slate-500">
        <span>
          {new Date(slots[0]!.start).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span>
          {new Date(slots[slots.length - 1]!.end).toLocaleTimeString('tr-TR', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
      <ul className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
        {(
          [
            ['active', 'Calisiyor'],
            ['idle', 'Bosta'],
            ['unproductive', 'Uretken degil'],
            ['deducted', 'Silinen blok'],
            ['offline', 'Cevrimdisi'],
          ] as const
        ).map(([state, label]) => (
          <li key={state} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${TIMELINE_COLORS[state]}`} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Uretkenlik kompozisyonu: tek satirlik yiginli cubuk. */
export function StackedProductivity({
  productive,
  unproductive,
  neutral,
}: {
  productive: number;
  unproductive: number;
  neutral: number;
}) {
  const total = Math.max(1, productive + unproductive + neutral);
  const parts = [
    { value: productive, className: 'bg-emerald-500', label: 'Uretken' },
    { value: unproductive, className: 'bg-rose-500', label: 'Uretken degil' },
    { value: neutral, className: 'bg-slate-300', label: 'Notr' },
  ];
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {parts.map((part) => (
          <div
            key={part.label}
            className={part.className}
            style={{ width: `${(part.value / total) * 100}%` }}
            title={`${part.label}: ${formatDuration(part.value)}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
        {parts.map((part) => (
          <span key={part.label} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${part.className}`} />
            {part.label}: {formatDuration(part.value)}
          </span>
        ))}
      </div>
    </div>
  );
}
