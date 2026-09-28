import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JwtError, decodeJwt, signJwt, verifyJwt } from './jwt.js';
import { buildUpdate, inClause, normalizePage } from './sql.js';
import { extractDomain } from '../services/productivity.service.js';

const SECRET = 'test-secret-test-secret-1234567890';

describe('signJwt / verifyJwt', () => {
  test('imzalanan token dogrulanir', () => {
    const token = signJwt({ sub: 'user-1', role: 'admin', email: 'a@b.c' }, SECRET, 900);
    const claims = verifyJwt(token, SECRET);
    assert.equal(claims.sub, 'user-1');
    assert.equal(claims.role, 'admin');
    assert.ok(claims.exp > claims.iat);
  });

  test('farkli secret ile dogrulanamaz', () => {
    const token = signJwt({ sub: 'user-1', role: 'admin', email: 'a@b.c' }, SECRET, 900);
    assert.throws(() => verifyJwt(token, 'baska-bir-secret-1234567890abc'), JwtError);
  });

  test('suresi dolmus token reddedilir', () => {
    const past = new Date(Date.now() - 3600_000);
    const token = signJwt({ sub: 'user-1', role: 'admin', email: 'a@b.c' }, SECRET, 60, past);
    assert.throws(() => verifyJwt(token, SECRET), /suresi dolmus/);
  });

  test('degistirilmis govde reddedilir', () => {
    const token = signJwt({ sub: 'user-1', role: 'employee', email: 'a@b.c' }, SECRET, 900);
    const [head, , sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'user-1', role: 'admin', email: 'a@b.c', iat: 1, exp: 9999999999 }),
      'utf8',
    ).toString('base64url');
    assert.throws(() => verifyJwt(`${head}.${forged}.${sig}`, SECRET), /Imza/);
  });

  test('gecersiz format reddedilir', () => {
    assert.throws(() => verifyJwt('abc', SECRET), /formati/);
    assert.equal(decodeJwt('abc'), null);
  });

  test('sub alani zorunludur', () => {
    const token = signJwt({ role: 'admin', email: 'a@b.c' }, SECRET, 900);
    assert.throws(() => verifyJwt(token, SECRET), /konusu/);
  });
});

describe('sql yardimcilari', () => {
  test('buildUpdate undefined alanlari atlar', () => {
    const { clause, values } = buildUpdate({ name: 'Ada', role: undefined, is_active: true });
    assert.equal(clause, 'name = $1, is_active = $2');
    assert.deepEqual(values, ['Ada', true]);
  });

  test('buildUpdate offset ile devam eder', () => {
    const { clause } = buildUpdate({ name: 'Ada' }, 4);
    assert.equal(clause, 'name = $4');
  });

  test('inClause bos dizi icin guvenli', () => {
    assert.equal(inClause([]).clause, '(NULL)');
    assert.equal(inClause(['a', 'b'], 3).clause, '($3, $4)');
  });

  test('normalizePage sinirlari uygular', () => {
    assert.deepEqual(normalizePage({}), { limit: 50, offset: 0 });
    assert.deepEqual(normalizePage({ limit: 10000, offset: -5 }), { limit: 500, offset: 0 });
    assert.deepEqual(normalizePage({ limit: '25', offset: '10' }), { limit: 25, offset: 10 });
  });
});

describe('domain yardimcilari', () => {
  test('bozuk url guvenli sekilde null doner', () => {
    assert.equal(extractDomain('::::'), null);
    assert.equal(extractDomain(''), null);
  });
});
