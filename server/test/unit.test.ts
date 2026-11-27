import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bahtToSatang, buildBillPaymentPayload, crc16, satangToBaht } from '../src/promptpay.ts';
import { decrypt, encrypt, hmacHex, maskName, maskPhone } from '../src/crypto.ts';
import { BankAuthError, verifyBankRequest } from '../src/bank/adapter.ts';
import { fiscalYearBE } from '../src/util.ts';

test('crc16 CCITT-FALSE vector', () => assert.equal(crc16('123456789'), '29B1'));

test('bill payment payload', () => {
  const p = buildBillPaymentPayload({ billerId: '099400016550100', ref1: 'A0001', ref2: 'INV1', amountSatang: 4050 });
  assert.ok(p.startsWith('000201010212'));
  assert.ok(p.includes('3056' + '0016A000000677010112' + '0115099400016550100' + '0205A0001' + '0304INV1'));
  assert.ok(p.includes('5303764' + '540540.50' + '5802TH'));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  assert.throws(() => buildBillPaymentPayload({ billerId: '1', ref1: 'A', amountSatang: 1 }));
  assert.throws(() => buildBillPaymentPayload({ billerId: '099400016550100', ref1: 'a-1', amountSatang: 1 }));
});

test('amount conversions without float', () => {
  assert.equal(bahtToSatang('40'), 4000);
  assert.equal(bahtToSatang('40.5'), 4050);
  assert.equal(bahtToSatang('0.07'), 7);
  assert.throws(() => bahtToSatang('1.234'));
  assert.equal(satangToBaht(4005), '40.05');
});

test('AES-GCM roundtrip + tamper detection', () => {
  const k = Buffer.alloc(32, 7);
  const c = encrypt('นายสมชาย', k);
  assert.equal(decrypt(c, k), 'นายสมชาย');
  const parts = c.split(':');
  parts[3] = Buffer.from('xxxx').toString('base64url');
  assert.throws(() => decrypt(parts.join(':'), k));
});

test('masking', () => {
  assert.equal(maskName('นายสมชาย ใจดี'), 'น*** ใ***');
  assert.equal(maskPhone('081-234-5678'), '08x-xxx-5678');
});

test('bank signature + replay guard', () => {
  const body = '{"a":1}';
  const ts = '1700000000';
  const sig = hmacHex('s', `${ts}.${body}`);
  const now = 1700000000_000;
  verifyBankRequest(body, { 'x-bank-timestamp': ts, 'x-bank-signature': sig }, 's', now);
  assert.throws(() => verifyBankRequest(body + ' ', { 'x-bank-timestamp': ts, 'x-bank-signature': sig }, 's', now), BankAuthError);
  assert.throws(() => verifyBankRequest(body, { 'x-bank-timestamp': ts, 'x-bank-signature': sig }, 's', now + 600_000), BankAuthError);
});

test('fiscal year BE starts Oct 1 (Bangkok time)', () => {
  assert.equal(fiscalYearBE('2026-09-30T16:59:00Z'), 2569);
  assert.equal(fiscalYearBE('2026-09-30T17:00:00Z'), 2570);
});
