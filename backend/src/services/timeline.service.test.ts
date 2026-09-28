import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildTimeline, summarizeTimeline, type TimelineSample } from './timeline.service.js';

const rangeStart = new Date('2026-03-10T06:00:00.000Z');
const rangeEnd = new Date('2026-03-10T07:00:00.000Z');

function sample(over: Partial<TimelineSample> & { timestamp: Date }): TimelineSample {
  return {
    isIdle: false,
    category: 'PRODUCTIVE',
    activeApp: 'Code',
    windowTitle: 'main.ts',
    url: null,
    domain: null,
    durationSeconds: 60,
    ...over,
  };
}

describe('buildTimeline', () => {
  test('60 dakikayi 5 dakikalik dilimlere boler', () => {
    const slices = buildTimeline({ samples: [], rangeStart, rangeEnd, slotMinutes: 5 });
    assert.equal(slices.length, 12);
    assert.equal(slices[0]?.minutes, 5);
    assert.equal(slices.every((s) => s.state === 'offline'), true);
  });

  test('bosluklu dilimi idle olarak isaretler', () => {
    const slices = buildTimeline({
      samples: [
        sample({ timestamp: new Date('2026-03-10T06:00:00Z'), durationSeconds: 600, isIdle: true }),
      ],
      rangeStart,
      rangeEnd,
      slotMinutes: 10,
    });
    assert.equal(slices[0]?.state, 'idle');
    assert.equal(slices[1]?.state, 'offline');
  });

  test('baskin kategori unproductive dilimi kirmizi yapar', () => {
    const slices = buildTimeline({
      samples: [
        sample({
          timestamp: new Date('2026-03-10T06:00:10Z'),
          durationSeconds: 200,
          category: 'UNPRODUCTIVE',
          domain: 'youtube.com',
        }),
        sample({ timestamp: new Date('2026-03-10T06:03:30Z'), durationSeconds: 60 }),
      ],
      rangeStart,
      rangeEnd,
      slotMinutes: 5,
    });
    assert.equal(slices[0]?.state, 'unproductive');
    assert.equal(slices[0]?.domain, 'youtube.com');
  });

  test('silinen ekran goruntusu blogu deducted olur', () => {
    const slices = buildTimeline({
      samples: [
        sample({ timestamp: new Date('2026-03-10T06:01:00Z'), durationSeconds: 600, deducted: true }),
      ],
      rangeStart,
      rangeEnd,
      slotMinutes: 10,
    });
    assert.equal(slices[0]?.state, 'deducted');
  });

  test('aralik disi ornekler yok sayilir', () => {
    const slices = buildTimeline({
      samples: [sample({ timestamp: new Date('2026-03-11T06:00:00Z') })],
      rangeStart,
      rangeEnd,
      slotMinutes: 10,
    });
    assert.equal(slices.every((s) => s.state === 'offline'), true);
  });

  test('baskin uygulama/pencere dilimde raporlanir', () => {
    const slices = buildTimeline({
      samples: [
        sample({ timestamp: new Date('2026-03-10T06:00:00Z'), durationSeconds: 30 }),
        sample({
          timestamp: new Date('2026-03-10T06:00:30Z'),
          durationSeconds: 200,
          activeApp: 'chrome.exe',
          windowTitle: 'GitHub',
          domain: 'github.com',
        }),
      ],
      rangeStart,
      rangeEnd,
      slotMinutes: 5,
    });
    assert.equal(slices[0]?.activeApp, 'chrome.exe');
    assert.equal(slices[0]?.windowTitle, 'GitHub');
    assert.equal(slices[0]?.state, 'active');
  });
});

describe('summarizeTimeline', () => {
  test('durum bazli dakika toplamlari', () => {
    const summary = summarizeTimeline([
      { start: '', end: '', minutes: 5, state: 'active', activeApp: null, windowTitle: null, url: null, domain: null, category: 'PRODUCTIVE' },
      { start: '', end: '', minutes: 10, state: 'idle', activeApp: null, windowTitle: null, url: null, domain: null, category: 'NEUTRAL' },
      { start: '', end: '', minutes: 15, state: 'unproductive', activeApp: null, windowTitle: null, url: null, domain: null, category: 'UNPRODUCTIVE' },
      { start: '', end: '', minutes: 20, state: 'deducted', activeApp: null, windowTitle: null, url: null, domain: null, category: 'NEUTRAL' },
      { start: '', end: '', minutes: 25, state: 'offline', activeApp: null, windowTitle: null, url: null, domain: null, category: 'NEUTRAL' },
    ]);
    assert.deepEqual(summary, {
      activeMinutes: 5,
      idleMinutes: 10,
      unproductiveMinutes: 15,
      deductedMinutes: 20,
      offlineMinutes: 25,
    });
  });
});
