/** Zaman dilimi farkindali tarih yardimcilari. Harici bagimlilik yok. */

/** Verilen UTC aninda belirtilen timezone'un UTC'ye gore offset'i (ms). */
function tzOffsetMs(utcDate: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    // 'en-US' + hour12:false bazi surumlerde 24 dondurur
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - utcDate.getTime();
}

/** YYYY-MM-DD -> [gun basi, ertesi gun basi) UTC araligi. DST guvenli. */
export function zonedDayRange(dateStr: string, timeZone: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`Gecersiz tarih formati (YYYY-MM-DD bekleniyor): ${dateStr}`);
  const [, y, mo, d] = m.map(Number) as unknown as [string, number, number, number];

  const startGuess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  let start = startGuess - tzOffsetMs(new Date(startGuess), timeZone);
  start = startGuess - tzOffsetMs(new Date(start), timeZone);

  const endGuess = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  let end = endGuess - tzOffsetMs(new Date(endGuess), timeZone);
  end = endGuess - tzOffsetMs(new Date(end), timeZone);

  return { start: new Date(start), end: new Date(end) };
}

/** Ani verilen timezone'da YYYY-MM-DD olarak dondurur. */
export function toZonedDateString(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(date);
}

export function parseDateOnly(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`Gecersiz tarih: ${value}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export const secondsBetween = (a: Date, b: Date): number =>
  Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));

/** Iki araligin kesisim suresi (saniye). */
export function overlapSeconds(
  aStart: Date, aEnd: Date, bStart: Date, bEnd: Date,
): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, Math.round((end - start) / 1000));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** 0-86399 -> "HH:MM" */
export function secondsToClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function hoursFromSeconds(seconds: number): number {
  return round2(seconds / 3600);
}
