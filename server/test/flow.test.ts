import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { AuthService } from '../src/auth.ts';
import { encrypt, hmacHex } from '../src/crypto.ts';
import { migrate, openPglite, type Db } from '../src/db.ts';
import { currentPeriod, dueDateOf, fiscalYearBE, fiscalYearPeriods } from '../src/util.ts';
import type { Config } from '../src/config.ts';

const cfg: Config = {
  port: 0, baseUrl: 'http://t', demo: false, dataDir: 'memory://', dataKey: Buffer.alloc(32, 1), receiptSecret: 'rs',
  billerId: '099400016550100', qrTtlMinutes: 15,
  bank: { callbackSecret: 'bs', allowedIps: [] },
  line: { channelSecret: 'ls', channelAccessToken: 'x', loginChannelId: 'x', liffId: 'liff' },
};
const FY = fiscalYearBE(new Date().toISOString());
const NOW = currentPeriod();
const PAST_FY = fiscalYearPeriods(FY).filter((p) => p <= NOW).length; // งวดของปีงบนี้ที่ถึงแล้ว
let db: Db;
let server: Server;
let base = '';
const pushed: { to: string; n: number }[] = [];
const inv: Record<string, string> = {};
const tok: Record<string, string> = {};

async function house(code: string, houseNo: string, community: string, category: string, rate: number, invNo: string, name: string, lat: number | null = 15.81) {
  const r = await db.query(
    `INSERT INTO houses(code, house_no, soi, road, community, subdistrict, owner_name_enc, category, rate_satang, lat, lng, verified)
     VALUES ($1,$2,'ศรีสุข','มิตรภาพ',$3,'เมืองพล',$4,$5,$6,$7,102.59,true) RETURNING id`,
    [code, houseNo, community, encrypt(name, cfg.dataKey), category, rate, lat]);
  inv[code] = (await db.query(`INSERT INTO invoices(invoice_no, house_id, period, amount_satang, due_date) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [invNo, r.rows[0].id, NOW, rate, dueDateOf(NOW)])).rows[0].id;
  return r.rows[0].id as string;
}

before(async () => {
  db = await openPglite('memory://');
  await migrate(db);
  await house('A0001', '3', 'หนองแวง 1', 'RESIDENTIAL', 4000, 'INV1', 'นายสมชาย ใจดี');
  await house('A0002', '13', 'หนองแวง 1', 'RESIDENTIAL', 4000, 'INV2', 'นางสมศรี ใจดี');
  await house('B0001', '3/1', 'หนองแวง 2', 'COMMERCIAL', 20000, 'INV3', 'ร้านสมชาย');
  await house('A0003', '3', 'หนองแวง 2', 'RESIDENTIAL', 4000, 'INV4', 'นายบุญมี ศรีสุข', null);
  const auth = new AuthService(db);
  for (const [u, role] of [['admin', 'ADMIN'], ['super', 'SUPERVISOR'], ['cashier', 'CASHIER'], ['survey', 'SURVEYOR'], ['viewer', 'VIEWER']] as const)
    await auth.createUser({ username: u, name: u, role, password: 'password-' + u });
  const app = createApp({
    cfg, db,
    line: { push: async (to, m) => void pushed.push({ to, n: m.length }), reply: async () => {} },
    verifyIdToken: async (t) => (t.startsWith('ok-') ? t.slice(3) : null),
  });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server.close();
  await db.close();
});

const call = (method: string, path: string, body?: object, auth?: string) =>
  fetch(base + path, { method, body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } });
const liff = (path: string, body?: object, user = 'U1', method?: string) => call(method ?? (body ? 'POST' : 'GET'), path, body, `ok-${user}`);
const staff = (who: string, path: string, body?: object, method?: string) => call(method ?? (body ? 'POST' : 'GET'), path, body, tok[who]);
const json = async (r: Response | Promise<Response>) => (await r).json();
const pay = (orderNo: string, amountSatang: number, txnId: string, secret = 'bs') => {
  const raw = JSON.stringify({ txnId, billerId: cfg.billerId, ref1: orderNo, amount: (amountSatang / 100).toFixed(2), paidAt: new Date().toISOString() });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(base + '/api/bank/callback', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': hmacHex(secret, `${ts}.${raw}`) } });
};

// ---------- เจ้าหน้าที่: เข้าสู่ระบบ / สิทธิ์ ----------
test('staff login, wrong password, lockout after 5 fails', async () => {
  for (const u of ['admin', 'super', 'cashier', 'survey', 'viewer']) {
    const r = await json(call('POST', '/api/staff/login', { username: u, password: 'password-' + u }));
    assert.ok(r.token, u);
    tok[u] = r.token;
  }
  assert.ok((await json(staff('admin', '/api/staff/me'))).user.permissions.includes('settings.manage'));
  assert.equal((await call('POST', '/api/staff/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await call('GET', '/api/staff/me', undefined, 'bad')).status, 401);
  await json(staff('admin', '/api/staff/users', { username: 'temp', name: 'ชั่วคราว', role: 'VIEWER', password: 'temp-pass1' }));
  for (let i = 0; i < 5; i++) await call('POST', '/api/staff/login', { username: 'temp', password: 'x' });
  const locked = await json(call('POST', '/api/staff/login', { username: 'temp', password: 'temp-pass1' }));
  assert.match(locked.error, /ล็อก/);
});

test('role permissions enforced', async () => {
  assert.equal((await staff('viewer', '/api/staff/quote', {})).status, 403);
  assert.equal((await staff('cashier', '/api/staff/houses', { houseNo: '9', subdistrict: 'เมืองพล' })).status, 403);
  assert.equal((await staff('survey', '/api/staff/settings')).status, 403);
  assert.equal((await staff('survey', '/api/staff/reviews')).status, 403);
  assert.equal((await staff('cashier', '/api/staff/users')).status, 403);
  assert.equal((await staff('viewer', '/api/staff/dashboard')).status, 200);
});

// ---------- ทะเบียนบ้าน ----------
test('house search: house number is exact (3 ≠ 13, 3/1), Thai digits ok, filters', async () => {
  const r = await json(staff('cashier', '/api/staff/houses?houseNo=3'));
  assert.deepEqual(r.items.map((h: any) => h.code).sort(), ['A0001', 'A0003']);
  const t = await json(staff('cashier', '/api/staff/houses?houseNo=' + encodeURIComponent('๓') + '&community=' + encodeURIComponent('หนองแวง 2')));
  assert.deepEqual(t.items.map((h: any) => h.code), ['A0003']);
  assert.equal((await json(staff('cashier', '/api/staff/houses?houseNo=3%2F1'))).items[0].code, 'B0001');
  const q = await json(staff('viewer', '/api/staff/houses?q=' + encodeURIComponent('บุญมี')));
  assert.deepEqual(q.items.map((h: any) => h.code), ['A0003']);
  assert.equal(q.items[0].ownerName, 'นายบุญมี ศรีสุข');
});

let newId = '';
test('surveyor adds/edits house → pending review; supervisor approves/rejects', async () => {
  const c = await json(staff('survey', '/api/staff/houses', { houseNo: ' 45/2 ', subdistrict: 'เมืองพล', community: 'หนองแวง 3', ownerName: 'นายใหม่ มาแล้ว', category: 'COMMERCIAL', lat: 15.812, lng: 102.6 }));
  assert.equal(c.changeStatus, 'PENDING');
  assert.equal(c.house.houseNo, '45/2');
  assert.equal(c.house.rateSatang, 20000); // อัตราเริ่มต้นร้านค้า
  assert.equal(c.house.verified, false);
  newId = c.house.id;
  const u = await json(staff('survey', `/api/staff/houses/${newId}`, { phone: '0812345678', road: 'ใหม่' }, 'PUT'));
  assert.equal(u.house.phone, '0812345678');
  const rv = await json(staff('super', '/api/staff/reviews'));
  assert.equal(rv.items.length, 2);
  const upd = rv.items.find((x: any) => x.action === 'UPDATE');
  assert.ok(upd.diff.some((d: any) => d.field === 'ถนน' && d.after === 'ใหม่'));
  await json(staff('super', `/api/staff/reviews/${upd.id}`, { decision: 'REJECT', note: 'ข้อมูลไม่ถูก' }));
  await json(staff('super', `/api/staff/reviews/${rv.items.find((x: any) => x.action === 'CREATE').id}`, { decision: 'APPROVE' }));
  const d = await json(staff('viewer', `/api/staff/houses/${newId}`));
  assert.equal(d.house.road, null); // ย้อนกลับแล้ว
  assert.equal(d.house.phone, '');
  assert.equal(d.house.verified, true);
  assert.equal(d.changes.length, 2);
  // หัวหน้าแก้เอง → อนุมัติอัตโนมัติ
  assert.equal((await json(staff('super', `/api/staff/houses/${newId}`, { note: 'ok' }, 'PUT'))).changeStatus, 'AUTO');
  assert.equal((await staff('survey', '/api/staff/houses', { houseNo: 'abc', subdistrict: 'x' })).status, 400);
});

test('billing generate creates invoices for active houses only once', async () => {
  const period = NOW;
  const r = await json(staff('admin', '/api/staff/billing/generate', { period }));
  assert.equal(r.created, 1); // เฉพาะบ้านใหม่ (บ้านอื่นมีงวดนี้แล้ว)
  assert.equal((await json(staff('admin', '/api/staff/billing/generate', { period }))).created, 0);
  assert.equal((await staff('super', '/api/staff/billing/generate', { period })).status, 403);
});

// ---------- ประชาชน ----------
test('LIFF house search: exact number, masked owner, requires house number', async () => {
  assert.equal((await liff('/api/liff/houses/search')).status, 400);
  const r = await json(liff('/api/liff/houses/search?houseNo=3'));
  assert.equal(r.items.length, 2);
  assert.ok(r.items.every((h: any) => h.houseNo === '3'));
  assert.ok(!JSON.stringify(r).includes('สมชาย'));
  assert.match(r.items[0].ownerMasked, /\*/);
  await json(staff('admin', '/api/staff/settings', { features: { liffHouseSearch: false } }, 'PUT'));
  assert.equal((await liff('/api/liff/houses/search?houseNo=3')).status, 403);
  await json(staff('admin', '/api/staff/settings', { features: { liffHouseSearch: true } }, 'PUT'));
});

let order1 = { orderNo: '', amountSatang: 0 };
test('LINE links many houses; one QR for house month + shop whole year', async () => {
  assert.equal((await liff('/api/liff/accounts', { payerCode: 'A0001', invoiceNo: 'WRONG', label: 'x', consent: true })).status, 404);
  await liff('/api/liff/accounts', { payerCode: 'a0001', invoiceNo: 'inv1', label: 'บ้านฉัน', consent: true });
  const j = await json(liff('/api/liff/accounts', { payerCode: 'B0001', invoiceNo: 'INV3', label: 'ร้านค้า', consent: true }));
  assert.deepEqual(j.accounts.map((a: any) => a.label), ['บ้านฉัน', 'ร้านค้า']);
  assert.match(j.accounts[0].address, /^3 ซ\.ศรีสุข/);
  assert.ok(!JSON.stringify(j).includes('สมชาย'));
  await liff('/api/liff/accounts', { payerCode: 'B0001', invoiceNo: 'INV3', label: 'ร้าน', consent: true }, 'U3');
  assert.equal((await liff('/api/liff/quote', { invoiceIds: [inv.A0001], years: [] }, 'U2')).status, 404);
  const sel = { invoiceIds: [inv.A0001], years: [{ payerCode: 'B0001', fiscalYear: FY }] };
  const q = await json(liff('/api/liff/quote', sel));
  assert.equal(q.items.length, 13);
  const o = await json(liff('/api/liff/orders', sel));
  assert.equal(o.amountSatang, 4000 + 12 * 20000);
  assert.ok(o.payload.includes('0212' + o.orderNo));
  order1 = o;
});

test('advance invoices are not counted as outstanding', async () => {
  const shop = (await json(staff('viewer', '/api/staff/houses?houseNo=3%2F1'))).items[0];
  assert.equal(shop.outstandingSatang, 20000 * PAST_FY); // เฉพาะงวดที่ถึงแล้ว ไม่รวมงวดล่วงหน้าที่สร้างจากการเลือกทั้งปี
});

test('bank callback → paid, receipt per house, LINE push; duplicate/mismatch/refund', async () => {
  assert.equal((await pay(order1.orderNo, order1.amountSatang, 'X', 'wrong')).status, 401);
  assert.equal((await json(pay(order1.orderNo, order1.amountSatang, 'T1'))).result, 'PAID');
  assert.equal((await json(liff(`/api/liff/orders/${order1.orderNo}`))).status, 'PAID');
  assert.deepEqual(pushed.find((p) => p.to === 'U1'), { to: 'U1', n: 2 });
  assert.deepEqual(pushed.find((p) => p.to === 'U3'), { to: 'U3', n: 1 });
  assert.equal((await json(pay(order1.orderNo, order1.amountSatang, 'T1'))).result, 'DUPLICATE');
  const rc = await json(liff('/api/liff/receipts'));
  const shop = rc.receipts.find((x: any) => x.label === 'ร้านค้า');
  assert.equal(shop.periods.length, 12);
  assert.match(await (await fetch(shop.verifyUrl.replace('http://t', base))).text(), /\(12 งวด\)/);
  assert.equal((await fetch(`${base}/r/${shop.receiptNo}?sig=0000`)).status, 404);

  await liff('/api/liff/accounts', { payerCode: 'A0002', invoiceNo: 'INV2', label: 'บ้านแม่', consent: true });
  const a = await json(liff('/api/liff/orders', { invoiceIds: [inv.A0002], years: [] }));
  const b = await json(liff('/api/liff/orders', { invoiceIds: [inv.A0002], years: [] }));
  assert.equal((await json(pay(a.orderNo, 100, 'T2'))).result, 'MISMATCH');
  assert.equal((await json(pay(b.orderNo, b.amountSatang, 'T3'))).result, 'PAID');
  assert.equal((await json(pay(a.orderNo, a.amountSatang, 'T4'))).result, 'REFUND');
});

test('counter: cashier takes cash for next fiscal year', async () => {
  const look = await json(staff('cashier', '/api/staff/payers/A0003'));
  assert.equal(look.payer.name, 'นายบุญมี ศรีสุข');
  const sel = { invoiceIds: [inv.A0003], years: [{ payerCode: 'A0003', fiscalYear: FY + 1 }] };
  assert.equal((await json(staff('cashier', '/api/staff/quote', sel))).amountSatang, 13 * 4000);
  assert.equal((await staff('cashier', '/api/staff/counter/pay', { ...sel, receivedSatang: 100 })).status, 400);
  const r = await json(staff('cashier', '/api/staff/counter/pay', { ...sel, receivedSatang: 60000 }));
  assert.equal(r.changeSatang, 8000);
  assert.equal(r.receipts[0].periods.length, 13);
});

// ---------- Dashboard / แผนที่ / รายงาน ----------
test('dashboard numbers', async () => {
  const d = await json(staff('viewer', '/api/staff/dashboard'));
  assert.equal(d.houses.active, 5);
  assert.equal(d.houses.commercial, 2);
  assert.equal(d.billing.invoicedSatang, 4000 * 3 + 20000 * 2 + 20000 * (PAST_FY - 1)); // งวดที่ถึงแล้วเท่านั้น
  assert.equal(d.billing.outstandingSatang, 20000); // บ้านใหม่ยังไม่จ่าย
  assert.equal(d.byMethod.CASH, 13 * 4000);
  assert.equal(d.topDebtors[0].outstandingSatang, 20000);
  assert.ok(d.recentPayments.length >= 3);
});

test('map: pins with pay status, no owner names, can be disabled in settings', async () => {
  const m = await json(staff('survey', '/api/staff/map'));
  assert.equal(m.points.length, 4); // A0003 ไม่มีพิกัด
  assert.ok(m.points.every((p: any) => p.payStatus));
  assert.ok(!JSON.stringify(m).includes('สมชาย'));
  await json(staff('admin', '/api/staff/settings', { features: { mapShowStatus: false } }, 'PUT'));
  assert.ok((await json(staff('survey', '/api/staff/map'))).points.every((p: any) => p.payStatus === undefined));
  await json(staff('admin', '/api/staff/settings', { features: { mapEnabled: false } }, 'PUT'));
  const off = await staff('survey', '/api/staff/map');
  assert.equal(off.status, 403);
  assert.equal((await off.json()).error, 'MAP_DISABLED');
  assert.equal((await json(staff('survey', '/api/staff/me'))).settings.features.mapEnabled, false);
});

test('CSV export (Excel-safe) and audit log', async () => {
  const buf = Buffer.from(await (await staff('viewer', '/api/staff/reports/outstanding.csv')).arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // BOM ให้ Excel อ่านไทยได้
  const csv = buf.toString('utf8');
  assert.ok(csv.includes('รหัสผู้ชำระ'));
  assert.equal(csv.trim().split('\r\n').length, 2);
  const a = await json(staff('super', '/api/staff/audit'));
  const acts = new Set(a.items.map((x: any) => x.action));
  for (const act of ['LOGIN', 'VIEW_HOUSE', 'REVIEW_REJECT', 'EXPORT_OUTSTANDING', 'UPDATE_SETTINGS', 'CASH_PAYMENT']) assert.ok(acts.has(act), `${act} not in ${[...acts]}`);
});

test('users: admin cannot demote self; password reset unlocks', async () => {
  const me = (await json(staff('admin', '/api/staff/me'))).user;
  assert.equal((await staff('admin', `/api/staff/users/${me.id}`, { role: 'VIEWER' }, 'PUT')).status, 400);
  const temp = (await json(staff('admin', '/api/staff/users'))).items.find((u: any) => u.username === 'temp');
  assert.equal(temp.locked, true);
  await json(staff('admin', `/api/staff/users/${temp.id}`, { password: 'new-pass-123' }, 'PUT'));
  assert.ok((await json(call('POST', '/api/staff/login', { username: 'temp', password: 'new-pass-123' }))).token);
});

test('LINE webhook signature', async () => {
  const raw = JSON.stringify({ events: [] });
  assert.equal((await fetch(base + '/webhook/line', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-line-signature': 'x' } })).status, 401);
  const sig = createHmac('sha256', 'ls').update(raw).digest('base64');
  assert.equal((await fetch(base + '/webhook/line', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-line-signature': sig } })).status, 200);
});
