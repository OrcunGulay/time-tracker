import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  categorize,
  computeProductivityScore,
  extractDomain,
  isIdleBreached,
  matchRule,
  normalizeAppName,
  sampleDurationSeconds,
  type CategoryRule,
} from './productivity.service.js';

const rule = (over: Partial<CategoryRule>): CategoryRule => ({
  id: over.id ?? '00000000-0000-0000-0000-00000000000a',
  matchType: 'app',
  pattern: 'code',
  category: 'PRODUCTIVE',
  department: null,
  projectId: null,
  priority: 50,
  isActive: true,
  ...over,
});

describe('normalizeAppName', () => {
  test('Windows yolundan uygulama adini cikarir', () => {
    assert.equal(normalizeAppName('C:\\Program Files\\Google\\Chrome\\chrome.exe'), 'chrome');
  });
  test('macOS .app uzantisini soyar', () => {
    assert.equal(normalizeAppName('/Applications/Visual Studio Code.app'), 'visual studio code');
  });
  test('bos deger icin null', () => {
    assert.equal(normalizeAppName(''), null);
    assert.equal(normalizeAppName(null), null);
  });
});

describe('extractDomain', () => {
  test('protokolu ve www onekini kaldirir', () => {
    assert.equal(extractDomain('https://www.youtube.com/watch?v=abc'), 'youtube.com');
  });
  test('alt alan adini korur', () => {
    assert.equal(extractDomain('https://docs.google.com/document/d/1'), 'docs.google.com');
  });
  test('sema yoksa da cozumler', () => {
    assert.equal(extractDomain('github.com/org/repo'), 'github.com');
  });
  test('URL olmayan metinde null', () => {
    assert.equal(extractDomain('Untitled document'), null);
  });
});

describe('matchRule', () => {
  test('wildcard alt alan adlarini yakalar', () => {
    const rules = [rule({ matchType: 'domain', pattern: '*.atlassian.net', category: 'PRODUCTIVE' })];
    assert.equal(categorize({ url: 'https://acme.atlassian.net/browse/TT-1' }, rules), 'PRODUCTIVE');
  });

  test('kok domain alt alan adlarini da kapsar', () => {
    const rules = [rule({ matchType: 'domain', pattern: 'youtube.com', category: 'UNPRODUCTIVE' })];
    assert.equal(categorize({ domain: 'music.youtube.com' }, rules), 'UNPRODUCTIVE');
  });

  test('departman kurali global kurali yener', () => {
    const rules = [
      rule({ id: 'a'.repeat(36), matchType: 'app', pattern: 'chrome', category: 'PRODUCTIVE' }),
      rule({
        id: 'b'.repeat(36),
        matchType: 'app',
        pattern: 'chrome',
        category: 'UNPRODUCTIVE',
        department: 'Destek',
      }),
    ];
    assert.equal(categorize({ activeApp: 'chrome.exe', department: 'Destek' }, rules), 'UNPRODUCTIVE');
    assert.equal(categorize({ activeApp: 'chrome.exe', department: 'Yazilim' }, rules), 'PRODUCTIVE');
  });

  test('domain kurali uygulama kuralindan daha ozguldur', () => {
    const rules = [
      rule({ id: 'a'.repeat(36), matchType: 'app', pattern: 'chrome', category: 'PRODUCTIVE' }),
      rule({ id: 'b'.repeat(36), matchType: 'domain', pattern: 'instagram.com', category: 'UNPRODUCTIVE' }),
    ];
    assert.equal(
      categorize({ activeApp: 'chrome.exe', url: 'https://instagram.com/feed' }, rules),
      'UNPRODUCTIVE',
    );
  });

  test('pasif kurallar yok sayilir', () => {
    const rules = [rule({ isActive: false })];
    assert.equal(matchRule({ activeApp: 'code' }, rules), null);
    assert.equal(categorize({ activeApp: 'code' }, rules), 'NEUTRAL');
  });

  test('ayni ozgullukta kucuk priority kazanir', () => {
    const rules = [
      rule({ id: 'a'.repeat(36), pattern: 'slack', category: 'NEUTRAL', priority: 90 }),
      rule({ id: 'b'.repeat(36), pattern: 'slack', category: 'PRODUCTIVE', priority: 10 }),
    ];
    assert.equal(categorize({ activeApp: 'slack' }, rules), 'PRODUCTIVE');
  });

  test('proje kurali en ozgul olanidir', () => {
    const projectId = '11111111-1111-1111-1111-111111111111';
    const rules = [
      rule({ id: 'a'.repeat(36), matchType: 'domain', pattern: 'figma.com', category: 'NEUTRAL' }),
      rule({
        id: 'b'.repeat(36),
        matchType: 'domain',
        pattern: 'figma.com',
        category: 'PRODUCTIVE',
        projectId,
      }),
    ];
    assert.equal(
      categorize({ url: 'https://figma.com/file/1', projectId }, rules),
      'PRODUCTIVE',
    );
  });
});

describe('computeProductivityScore', () => {
  test('agirliksiz skor', () => {
    // 3000 uretken, 1000 uretken degil -> %75
    assert.equal(
      computeProductivityScore(
        { productiveSeconds: 3000, unproductiveSeconds: 1000, neutralSeconds: 0 },
        0,
      ),
      75,
    );
  });

  test('neutral agirligi skoru yukseltir', () => {
    const parts = { productiveSeconds: 1000, unproductiveSeconds: 1000, neutralSeconds: 2000 };
    assert.equal(computeProductivityScore(parts, 0), 25);
    assert.equal(computeProductivityScore(parts, 1), 75);
    assert.equal(computeProductivityScore(parts, 0.5), 50);
  });

  test('veri yoksa sifir', () => {
    assert.equal(
      computeProductivityScore({ productiveSeconds: 0, unproductiveSeconds: 0, neutralSeconds: 0 }),
      0,
    );
  });

  test('agirlik 0-1 araligina kilitlenir', () => {
    const parts = { productiveSeconds: 0, unproductiveSeconds: 0, neutralSeconds: 100 };
    assert.equal(computeProductivityScore(parts, 5), 100);
    assert.equal(computeProductivityScore(parts, -3), 0);
  });
});

describe('yardimcilar', () => {
  test('sampleDurationSeconds varsayilana duser', () => {
    assert.equal(sampleDurationSeconds({}), 20);
    assert.equal(sampleDurationSeconds({ durationSeconds: 0 }), 20);
    assert.equal(sampleDurationSeconds({ durationSeconds: 45 }), 45);
    assert.equal(sampleDurationSeconds({ durationSeconds: 99999 }), 3600);
  });

  test('isIdleBreached esik davranisi', () => {
    assert.equal(isIdleBreached(179, 180), false);
    assert.equal(isIdleBreached(180, 180), true);
  });
});
