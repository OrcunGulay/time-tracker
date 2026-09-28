import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { payrollToCsv, type PayrollDetailRow } from './payroll.service.js';

const row = (over: Partial<PayrollDetailRow>): PayrollDetailRow => ({
  userId: 'u1',
  userName: 'Ada Kaya',
  email: 'ada@localhost',
  currency: 'TRY',
  hourlyRate: 600,
  periodStart: '2026-03-01',
  periodEnd: '2026-03-07',
  payableSeconds: 3600 * 30,
  payableHours: 30,
  amount: 18000,
  sessionCount: 5,
  approvedSeconds: 3600 * 20,
  unapprovedSeconds: 3600 * 10,
  productivityScore: 72.5,
  idleSeconds: 1800,
  deductedSeconds: 600,
  ...over,
});

describe('payrollToCsv', () => {
  test('baslik satiri ve BOM ekler', () => {
    const csv = payrollToCsv([row({})]);
    assert.ok(csv.startsWith('\uFEFF'));
    const [header, first] = csv.trim().split('\r\n');
    assert.ok(header?.includes('Odenebilir Saat'));
    assert.ok(first?.startsWith('Ada Kaya;ada@localhost;'));
  });

  test('30 saat x 600 TRY = 18000 doner', () => {
    const csv = payrollToCsv([row({})]);
    const cells = csv.trim().split('\r\n')[1]?.split(';');
    assert.equal(cells?.[4], '30.00');
    assert.equal(cells?.[5], '600.00');
    assert.equal(cells?.[7], '18000.00');
  });

  test('bosluk ve silinen bloklar dakikaya cevrilir', () => {
    const csv = payrollToCsv([row({})]);
    const cells = csv.trim().split('\r\n')[1]?.split(';');
    assert.equal(cells?.[12], '30'); // 1800 sn bosluk
    assert.equal(cells?.[13], '10'); // 600 sn silinen blok
  });

  test('ozel karakterler tirnakla kacirilir', () => {
    const csv = payrollToCsv([row({ userName: 'Ada; "Kaya"' })]);
    assert.ok(csv.includes('"Ada; ""Kaya"""'));
  });
});
