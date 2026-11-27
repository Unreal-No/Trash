import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { encrypt, hmacHex, sha256Hex } from '../src/crypto.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { fiscalYearBE, fiscalYearPeriods } from '../src/util.ts';
import type { Config } from '../src/config.ts';

const cfg: Config = {
  port: 0, baseUrl: 'http://t', store: 'memory', dataKey: Buffer.alloc(32, 1), receiptSecret: 'rs',
  municipalityName: 'เทศบาลทดสอบ', billerId: '099400016550100', qrTtlMinutes: 15,
  bank: { callbackSecret: 'bs', allowedIps: [] },
  line: { channelSecret: 'ls', channelAccessToken: 'x', loginChannelId: 'x', liffId: 'liff' },
};
const FY = fiscalYearBE(new Date().toISOString());
const P1 = fiscalYearPeriods(FY)[1]!; // งวดที่มีใบแจ้งหนี้อยู่แล้ว
const store = new MemoryStore();
const pushed: { to: string; n: number }[] = [];
let server: Server;
let base = '';
const inv: Record<string, string> = {};

before(async () => {
  const k = cfg.dataKey;
  const add = (code: string, name: string, category: 'RESIDENTIAL' | 'COMMERCIAL', rate: number, no: string) => {
    const p = store.addPayer({ code, nameEnc: encrypt(name, k), addressEnc: encrypt('99/1 หมู่ 2', k), phoneEnc: null, category, rateSatang: rate });
    inv[code] = store.addInvoice({ invoiceNo: no, payerId: p.id, period: P1, amountSatang: rate, dueDate: '2026-12-15' }).id;
  };
  add('A0001', 'นายสมชาย ใจดี', 'RESIDENTIAL', 4000, 'INV1');
  add('A0002', 'นางสมศรี ใจดี', 'RESIDENTIAL', 4000, 'INV2');
  add('B0001', 'ร้านสมชาย', 'COMMERCIAL', 20000, 'INV3');
  store.staff.set(sha256Hex('cashier-token'), { id: 's1', name: 'แคชเชียร์', role: 'CASHIER' });
  store.staff.set(sha256Hex('viewer-token'), { id: 's2', name: 'ดูอย่างเดียว', role: 'VIEWER' });
  const app = createApp({
    cfg, store,
    line: { push: async (to, m) => void pushed.push({ to, n: m.length }), reply: async () => {} },
    verifyIdToken: async (t) => (t.startsWith('ok-') ? t.slice(3) : null),
  });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const liff = (path: string, body?: object, user = 'U1', method?: string) =>
  fetch(base + path, {
    method: method ?? (body ? 'POST' : 'GET'), body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ok-${user}` },
  });
const bank = (body: object, secret = 'bs') => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(base + '/api/bank/callback', {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': hmacHex(secret, `${ts}.${raw}`) },
  });
};
const pay = (orderNo: string, amountSatang: number, txnId: string) =>
  bank({ txnId, billerId: cfg.billerId, ref1: orderNo, ref2: '', amount: (amountSatang / 100).toFixed(2), paidAt: new Date().toISOString() });
const staff = (path: string, body?: object, token = 'cashier-token') =>
  fetch(base + path, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

test('LIFF requires valid LINE token', async () => {
  const r = await fetch(base + '/api/liff/accounts', { headers: { authorization: 'Bearer bad' } });
  assert.equal(r.status, 401);
});

test('one LINE links many accounts (own house, other house, shop) — masked', async () => {
  assert.deepEqual((await (await liff('/api/liff/accounts')).json()).accounts, []);
  assert.equal((await liff('/api/liff/accounts', { payerCode: 'A0001', invoiceNo: 'WRONG', label: 'x', consent: true })).status, 404);
  assert.equal((await liff('/api/liff/accounts', { payerCode: 'A0001', invoiceNo: 'INV1', label: 'x', consent: false })).status, 400);
  await liff('/api/liff/accounts', { payerCode: 'a0001', invoiceNo: 'inv1', label: 'บ้านฉัน', consent: true });
  await liff('/api/liff/accounts', { payerCode: 'A0002', invoiceNo: 'INV2', label: 'บ้านแม่', consent: true });
  const j = await (await liff('/api/liff/accounts', { payerCode: 'B0001', invoiceNo: 'INV3', label: 'ร้านค้า', consent: true })).json();
  assert.equal(j.accounts.length, 3);
  assert.equal(j.currentFiscalYear, FY);
  assert.deepEqual(j.accounts.map((a: any) => a.label), ['บ้านฉัน', 'บ้านแม่', 'ร้านค้า']);
  assert.equal(j.accounts[2].category, 'COMMERCIAL');
  assert.ok(!JSON.stringify(j).includes('สมชาย'));
  // ผู้ร่วมเป็นเจ้าของร้าน (LINE อีกคน)
  await liff('/api/liff/accounts', { payerCode: 'B0001', invoiceNo: 'INV3', label: 'ร้าน', consent: true }, 'U3');
});

test('another LINE user cannot quote invoices not linked to them', async () => {
  assert.equal((await liff('/api/liff/quote', { invoiceIds: [inv.A0001], years: [] }, 'U2')).status, 404);
  assert.equal((await liff('/api/liff/quote', { invoiceIds: [], years: [{ payerCode: 'A0001', fiscalYear: FY }] }, 'U2')).status, 404);
});

test('fiscal year limited to current/next', async () => {
  assert.equal((await liff('/api/liff/quote', { invoiceIds: [], years: [{ payerCode: 'A0001', fiscalYear: FY - 1 }] })).status, 400);
  assert.equal((await liff('/api/liff/quote', { invoiceIds: [], years: [{ payerCode: 'A0001', fiscalYear: FY + 2 }] })).status, 400);
});

let order1 = { orderNo: '', amountSatang: 0 };
test('one QR: house month + shop whole fiscal year', async () => {
  const sel = { invoiceIds: [inv.A0001], years: [{ payerCode: 'B0001', fiscalYear: FY }] };
  const q = await (await liff('/api/liff/quote', sel)).json();
  assert.equal(q.items.length, 1 + 12);
  assert.equal(q.amountSatang, 4000 + 12 * 20000);
  assert.ok(q.items.every((i: any) => i.label));
  const o = await (await liff('/api/liff/orders', sel)).json();
  assert.equal(o.amountSatang, q.amountSatang);
  assert.match(o.orderNo, /^Q[A-Z2-9]{11}$/);
  assert.ok(o.payload.includes('0212' + o.orderNo));
  assert.match(o.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal((await liff(`/api/liff/orders/${o.orderNo}`, undefined, 'U2')).status, 404);
  order1 = o;
});

test('bank callback → all paid, receipt per account, pushed to every linked LINE; duplicate ignored', async () => {
  assert.equal((await bank({ txnId: 'X', billerId: cfg.billerId, ref1: order1.orderNo, ref2: '', amount: '1.00', paidAt: new Date().toISOString() }, 'wrong')).status, 401);
  const r = await (await pay(order1.orderNo, order1.amountSatang, 'T1')).json();
  assert.equal(r.result, 'PAID');
  assert.equal((await (await liff(`/api/liff/orders/${order1.orderNo}`)).json()).status, 'PAID');
  assert.equal(store.receipts.size, 2);
  assert.deepEqual(pushed.find((p) => p.to === 'U1'), { to: 'U1', n: 2 });
  assert.deepEqual(pushed.find((p) => p.to === 'U3'), { to: 'U3', n: 1 });
  const before = pushed.length;
  assert.equal((await (await pay(order1.orderNo, order1.amountSatang, 'T1')).json()).result, 'DUPLICATE');
  assert.equal(store.receipts.size, 2);
  assert.equal(pushed.length, before);

  const rc = await (await liff('/api/liff/receipts')).json();
  const shop = rc.receipts.find((x: any) => x.label === 'ร้านค้า');
  assert.equal(shop.periods.length, 12);
  const page = await fetch(shop.verifyUrl.replace('http://t', base));
  assert.match(await page.text(), /\(12 งวด\)/);
  assert.equal((await fetch(`${base}/r/${shop.receiptNo}?sig=0000`)).status, 404);
  assert.equal((await liff('/api/liff/quote', { invoiceIds: [inv.A0001], years: [] })).status, 409);
});

test('two QRs for same invoice → second payment flagged REFUND', async () => {
  const sel = { invoiceIds: [inv.A0002], years: [] };
  const a = await (await liff('/api/liff/orders', sel)).json();
  const b = await (await liff('/api/liff/orders', sel)).json();
  assert.equal((await (await pay(a.orderNo, a.amountSatang, 'T2')).json()).result, 'PAID');
  assert.equal((await (await pay(b.orderNo, b.amountSatang, 'T3')).json()).result, 'REFUND');
  assert.ok(store.audits.some((x) => x.action === 'PAYMENT_REFUND'));
});

test('wrong amount → MISMATCH, invoices stay unpaid', async () => {
  const o = await (await liff('/api/liff/orders', { invoiceIds: [], years: [{ payerCode: 'A0002', fiscalYear: FY + 1 }] })).json();
  assert.equal((await (await pay(o.orderNo, 100, 'T4')).json()).result, 'MISMATCH');
  const acc = (await (await liff('/api/liff/accounts')).json()).accounts.find((a: any) => a.code === 'A0002');
  assert.equal(acc.invoices.filter((i: any) => i.status === 'UNPAID').length, 12);
});

test('counter: shop pays next fiscal year in cash', async () => {
  assert.equal((await staff('/api/staff/payers/B0001', undefined, 'nope')).status, 401);
  const look = await (await staff('/api/staff/payers/B0001')).json();
  assert.equal(look.payer.category, 'COMMERCIAL');
  assert.equal(look.payer.name, 'ร้านสมชาย');
  assert.ok(store.audits.some((a) => a.action === 'VIEW_PAYER'));
  const sel = { invoiceIds: [], years: [{ payerCode: 'B0001', fiscalYear: FY + 1 }] };
  const q = await (await staff('/api/staff/quote', sel)).json();
  assert.equal(q.amountSatang, 12 * 20000);
  assert.equal((await staff('/api/staff/counter/pay', { ...sel, receivedSatang: 300000 }, 'viewer-token')).status, 403);
  assert.equal((await staff('/api/staff/counter/pay', { ...sel, receivedSatang: 100 })).status, 400);
  const r = await (await staff('/api/staff/counter/pay', { ...sel, receivedSatang: 250000 })).json();
  assert.equal(r.changeSatang, 10000);
  assert.equal(r.receipts.length, 1);
  assert.equal(r.receipts[0].periods.length, 12);
  assert.equal(r.lineNotified, true);
  assert.equal((await staff('/api/staff/counter/pay', { ...sel, receivedSatang: 250000 })).status, 400); // ไม่มีงวดค้างแล้ว
});

test('unlink one account keeps others', async () => {
  await liff('/api/liff/accounts/A0002', undefined, 'U1', 'DELETE');
  const j = await (await liff('/api/liff/accounts')).json();
  assert.deepEqual(j.accounts.map((a: any) => a.code), ['A0001', 'B0001']);
});

test('LINE webhook signature', async () => {
  const raw = JSON.stringify({ events: [] });
  const bad = await fetch(base + '/webhook/line', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-line-signature': 'x' } });
  assert.equal(bad.status, 401);
  const sig = createHmac('sha256', 'ls').update(raw).digest('base64');
  const ok = await fetch(base + '/webhook/line', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-line-signature': sig } });
  assert.equal(ok.status, 200);
});
