import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { encrypt, hmacHex, sha256Hex } from '../src/crypto.ts';
import { MemoryStore } from '../src/store/memory.ts';
import type { Config } from '../src/config.ts';

const cfg: Config = {
  port: 0, baseUrl: 'http://t', store: 'memory', dataKey: Buffer.alloc(32, 1), receiptSecret: 'rs',
  municipalityName: 'เทศบาลทดสอบ', billerId: '099400016550100', qrTtlMinutes: 15,
  bank: { callbackSecret: 'bs', allowedIps: [] },
  line: { channelSecret: 'ls', channelAccessToken: 'x', loginChannelId: 'x', liffId: 'liff' },
};
const store = new MemoryStore();
const pushed: { to: string; msg: any }[] = [];
let server: Server;
let base = '';
let inv1 = '', inv2 = '', inv3 = '';

before(async () => {
  const k = cfg.dataKey;
  const p = store.addPayer({ code: 'A0001', nameEnc: encrypt('นายสมชาย ใจดี', k), addressEnc: encrypt('99/1 หมู่ 2', k), phoneEnc: null });
  inv1 = store.addInvoice({ invoiceNo: 'INV1', payerId: p.id, period: '2569-11', amountSatang: 4000, dueDate: '2026-12-15' }).id;
  inv2 = store.addInvoice({ invoiceNo: 'INV2', payerId: p.id, period: '2569-12', amountSatang: 4000, dueDate: '2027-01-15' }).id;
  inv3 = store.addInvoice({ invoiceNo: 'INV3', payerId: p.id, period: '2570-01', amountSatang: 4000, dueDate: '2027-02-15' }).id;
  store.staff.set(sha256Hex('cashier-token'), { id: 's1', name: 'แคชเชียร์', role: 'CASHIER' });
  store.staff.set(sha256Hex('viewer-token'), { id: 's2', name: 'ดูอย่างเดียว', role: 'VIEWER' });
  const app = createApp({
    cfg, store,
    line: { push: async (to, m) => void pushed.push({ to, msg: m[0] }), reply: async () => {} },
    verifyIdToken: async (t) => (t.startsWith('ok-') ? t.slice(3) : null),
  });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const liff = (path: string, init: RequestInit = {}, user = 'U1') =>
  fetch(base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ok-${user}` } });
const bank = (body: object, secret = 'bs') => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(base + '/api/bank/callback', {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': hmacHex(secret, `${ts}.${raw}`) },
  });
};
const staff = (path: string, body?: object, token = 'cashier-token') =>
  fetch(base + path, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

test('LIFF requires valid LINE token', async () => {
  const r = await fetch(base + '/api/liff/invoices', { headers: { authorization: 'Bearer bad' } });
  assert.equal(r.status, 401);
});

test('link → invoices are masked', async () => {
  assert.equal((await liff('/api/liff/invoices')).status, 404);
  assert.equal((await liff('/api/liff/link', { method: 'POST', body: JSON.stringify({ payerCode: 'A0001', invoiceNo: 'WRONG', consent: true }) })).status, 404);
  assert.equal((await liff('/api/liff/link', { method: 'POST', body: JSON.stringify({ payerCode: 'A0001', invoiceNo: 'INV1', consent: false }) })).status, 400);
  const r = await liff('/api/liff/link', { method: 'POST', body: JSON.stringify({ payerCode: 'a0001', invoiceNo: 'inv1', consent: true }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.payer.nameMasked, 'น*** ใ***');
  assert.ok(!JSON.stringify(j).includes('สมชาย'));
  assert.equal(j.invoices.length, 3);
});

test('other LINE user cannot create QR for this invoice', async () => {
  assert.equal((await liff(`/api/liff/invoices/${inv1}/qr`, { method: 'POST' }, 'U2')).status, 404);
});

test('QR → bank callback → PAID + receipt pushed to LINE; duplicate ignored', async () => {
  const q = await (await liff(`/api/liff/invoices/${inv1}/qr`, { method: 'POST' })).json();
  assert.match(q.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(q.payload.includes('0205A0001'));
  assert.equal(store.invoices.get(inv1)!.status, 'PENDING');

  const cb = { txnId: 'T1', billerId: cfg.billerId, ref1: 'A0001', ref2: 'INV1', amount: '40.00', paidAt: new Date().toISOString() };
  assert.equal((await bank(cb, 'wrong')).status, 401);
  const r = await (await bank(cb)).json();
  assert.equal(r.result, 'PAID');
  assert.equal(store.invoices.get(inv1)!.status, 'PAID');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]!.to, 'U1');
  assert.equal(pushed[0]!.msg.type, 'flex');

  const dup = await (await bank(cb)).json();
  assert.equal(dup.result, 'DUPLICATE');
  assert.equal(store.receipts.size, 1);
  assert.equal(pushed.length, 1);

  const rc = await (await liff('/api/liff/receipts')).json();
  assert.equal(rc.receipts.length, 1);
  const page = await fetch(rc.receipts[0].verifyUrl.replace('http://t', base));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ใบเสร็จถูกต้อง/);
  const forged = await fetch(`${base}/r/${rc.receipts[0].receiptNo}?sig=0000`);
  assert.equal(forged.status, 404);
});

test('wrong amount → MISMATCH, no receipt', async () => {
  const r = await (await bank({ txnId: 'T2', billerId: cfg.billerId, ref1: 'A0001', ref2: 'INV2', amount: '4.00', paidAt: new Date().toISOString() })).json();
  assert.equal(r.result, 'MISMATCH');
  assert.equal(store.invoices.get(inv2)!.status, 'MISMATCH');
  assert.equal(store.receipts.size, 1);
});

test('counter cash payment with change; viewer forbidden; no double pay', async () => {
  assert.equal((await staff('/api/staff/payers/A0001/invoices', undefined, 'nope')).status, 401);
  const look = await (await staff('/api/staff/payers/A0001/invoices')).json();
  assert.equal(look.payer.name, 'นายสมชาย ใจดี');
  assert.ok(store.audits.some((a) => a.action === 'VIEW_PAYER'));

  assert.equal((await staff('/api/staff/counter/pay', { invoiceId: inv3, receivedSatang: 10000 }, 'viewer-token')).status, 403);
  assert.equal((await staff('/api/staff/counter/pay', { invoiceId: inv3, receivedSatang: 100 })).status, 400);
  const r = await (await staff('/api/staff/counter/pay', { invoiceId: inv3, receivedSatang: 10000 })).json();
  assert.equal(r.receipt.changeSatang, 6000);
  assert.equal(r.lineNotified, true);
  assert.match(r.receipt.receiptNo, /^R25\d\d-000002$/);
  assert.equal((await staff('/api/staff/counter/pay', { invoiceId: inv3, receivedSatang: 10000 })).status, 409);
});

test('LINE webhook signature', async () => {
  const raw = JSON.stringify({ events: [] });
  const bad = await fetch(base + '/webhook/line', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-line-signature': 'x' } });
  assert.equal(bad.status, 401);
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', 'ls').update(raw).digest('base64');
  const ok = await fetch(base + '/webhook/line', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-line-signature': sig } });
  assert.equal(ok.status, 200);
});
