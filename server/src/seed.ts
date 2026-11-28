// ข้อมูลสาธิต (สมมติทั้งหมด) สำหรับเทศบาลเมืองเมืองพล — ใช้กับ `npm run demo` เท่านั้น
import { encrypt } from './crypto.ts';
import { AuthService } from './auth.ts';
import { PaymentService } from './payments.ts';
import { SettingsService } from './settings.ts';
import { currentPeriod, dueDateOf, randomRef } from './util.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

export const DEMO_USERS = [
  { username: 'admin', password: 'admin1234', name: 'ผู้ดูแลระบบ', role: 'ADMIN' },
  { username: 'super', password: 'super1234', name: 'หัวหน้างานจัดเก็บ', role: 'SUPERVISOR' },
  { username: 'cashier', password: 'cash1234', name: 'เจ้าหน้าที่การเงิน', role: 'CASHIER' },
  { username: 'survey', password: 'survey1234', name: 'เจ้าหน้าที่สำรวจ', role: 'SURVEYOR' },
  { username: 'viewer', password: 'view1234', name: 'ผู้บริหาร', role: 'VIEWER' },
] as const;

// สุ่มแบบกำหนดผลได้ (ข้อมูลเหมือนเดิมทุกครั้ง)
let seed = 20261128;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;

const FIRST = ['สมชาย', 'สมศรี', 'บุญมี', 'ประเสริฐ', 'วิไล', 'สุนทร', 'มาลี', 'ทองดี', 'จันทร์เพ็ญ', 'อำนวย', 'คำปุ่น', 'สมพร', 'บัวผัน', 'ณัฐพล', 'ศิริพร', 'อนุชา', 'พิมพ์ใจ', 'ชัยวัฒน์'];
const LAST = ['ใจดี', 'ศรีสุข', 'มั่นคง', 'พลศักดิ์', 'แสนดี', 'บุญเรือง', 'คำแพง', 'ทองสุข', 'วงศ์ไทย', 'สีหาราช', 'ภูมิพล', 'แก้วมณี'];
const SHOPS = ['ร้านขายของชำ', 'ร้านอาหารตามสั่ง', 'ร้านกาแฟ', 'ร้านซ่อมรถ', 'ร้านเสริมสวย', 'ร้านวัสดุก่อสร้าง', 'ร้านยา'];

// ชุมชนหนองแวง 1–4 อ้างอิงจากข่าวกิจกรรมเทศบาล ถนน/ซอยเป็นชื่อสมมติ — แก้ในหน้าตั้งค่า
const AREAS = [
  { community: 'หนองแวง 1', road: 'เทศบาล 1', sois: ['เทศบาล 1/1', 'เทศบาล 1/2'], lat: 15.8172, lng: 102.5951 },
  { community: 'หนองแวง 2', road: 'เทศบาล 2', sois: ['เทศบาล 2/1', null], lat: 15.8168, lng: 102.6012 },
  { community: 'หนองแวง 3', road: 'สถานีรถไฟ', sois: ['สถานี 1', 'สถานี 2'], lat: 15.8106, lng: 102.5949 },
  { community: 'หนองแวง 4', road: 'เทศบาล 3', sois: [null, 'เทศบาล 3/1'], lat: 15.8109, lng: 102.6008 },
];

export async function isEmpty(db: Db) {
  return (await db.query('SELECT count(*)::int AS n FROM houses')).rows[0].n === 0;
}

export async function seedDemo(db: Db, cfg: Config) {
  const k = cfg.dataKey;
  const auth = new AuthService(db);
  const ids: Record<string, string> = {};
  for (const u of DEMO_USERS) ids[u.username] = (await auth.createUser({ ...u })).id;

  const settings = new SettingsService(db);
  await settings.update({ areas: { subdistricts: ['เมืองพล'], communities: AREAS.map((a) => a.community), roads: AREAS.map((a) => a.road), sois: AREAS.flatMap((a) => a.sois).filter(Boolean) } }, 'seed');

  const now = currentPeriod();
  const [y, m] = now.split('-').map(Number) as [number, number];
  const periods = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(Date.UTC(y - 543, m - 1 - (4 - i), 1));
    return `${d.getUTCFullYear() + 543}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });

  type H = { id: string; code: string; rate: number; inv: { id: string; period: string }[] };
  const houses: H[] = [];
  const add = async (code: string, houseNo: string, a: (typeof AREAS)[number], soi: string | null, commercial: boolean, fixedInvoiceNo?: string) => {
    const name = commercial ? `${pick(SHOPS)} ${pick(FIRST)}` : `${pick(['นาย', 'นาง', 'นางสาว'])}${pick(FIRST)} ${pick(LAST)}`;
    const rate = commercial ? pick([10000, 20000, 30000]) : 4000;
    const noLocation = rnd() < 0.08;
    const r = await db.query(
      `INSERT INTO houses(code, house_no, moo, soi, road, community, subdistrict, owner_name_enc, phone_enc, category, rate_satang, lat, lng, verified, updated_by)
       VALUES ($1,$2,NULL,$3,$4,$5,'เมืองพล',$6,$7,$8,$9,$10,$11,true,'seed') RETURNING id`,
      [code, houseNo, soi, a.road, a.community, encrypt(name, k), encrypt(`08${Math.floor(rnd() * 1e8).toString().padStart(8, '0')}`, k),
        commercial ? 'COMMERCIAL' : 'RESIDENTIAL', rate, noLocation ? null : a.lat + (rnd() - 0.5) * 0.004, noLocation ? null : a.lng + (rnd() - 0.5) * 0.004]);
    const h: H = { id: r.rows[0].id, code, rate, inv: [] };
    for (const p of periods) {
      const no = fixedInvoiceNo && p === now ? fixedInvoiceNo : p.replace('-', '').slice(2) + randomRef(8);
      const i = await db.query(`INSERT INTO invoices(invoice_no, house_id, period, amount_satang, due_date) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [no, h.id, p, rate, dueDateOf(p)]);
      h.inv.push({ id: i.rows[0].id, period: p });
    }
    houses.push(h);
    return h;
  };

  // บ้านสำหรับทดลองผูก LINE (เลขใบแจ้งหนี้ที่รู้ค่า)
  await add('A0001', '99/1', AREAS[0]!, 'เทศบาล 1/1', false, 'INV256911001');
  await add('A0002', '12', AREAS[1]!, null, false, 'INV256911002');
  await add('B0001', '5/7', AREAS[2]!, 'สถานี 1', true, 'INV256911003');

  let n = 1;
  for (const a of AREAS) {
    // มีบ้านเลขที่ 3, 13, 30, 3/1 เพื่อสาธิตการค้นหาแบบตรงตัว
    const nos = ['3', '13', '30', '3/1', ...Array.from({ length: 30 }, (_, i) => String(i + 31 + Math.floor(rnd() * 3) * 100))];
    for (const no of nos) await add('H' + String(n++).padStart(5, '0'), no, a, pick(a.sois), rnd() < 0.12);
  }

  // ประวัติการชำระ: ส่วนใหญ่จ่ายครบ บางส่วนค้าง
  const pay = new PaymentService(db, cfg, { push: async () => {}, reply: async () => {} }, async () => '');
  const methods = ['QR', 'QR', 'QR', 'BANK', 'CASH'] as const;
  for (const h of houses.slice(3)) {
    const r = rnd();
    const paidUpTo = r < 0.6 ? 5 : r < 0.8 ? 4 : r < 0.92 ? 2 : 0; // จำนวนงวดที่จ่ายแล้ว
    if (!paidUpTo) continue;
    const items = h.inv.slice(0, paidUpTo).map((i) => ({ invoiceId: i.id, houseId: h.id, payerCode: h.code, period: i.period, amountSatang: h.rate }));
    const method = pick(methods);
    const order = await (pay as any).createOrder(method === 'CASH' ? 'C' : 'Q', 'seed', items);
    const last = items[items.length - 1]!.period;
    const [py, pm] = last.split('-').map(Number) as [number, number];
    const paidAt = new Date(Date.UTC(py - 543, pm - 1, 5 + Math.floor(rnd() * 20), 2 + Math.floor(rnd() * 8))).toISOString();
    await (pay as any).recordPayment({ orderId: order.id, method, amountSatang: order.amountSatang, bankTxnId: method === 'CASH' ? null : 'SEED' + randomRef(10), staffId: method === 'CASH' ? ids.cashier : null, paidAt: paidAt > new Date().toISOString() ? new Date().toISOString() : paidAt });
  }

  // งานสำรวจที่รอหัวหน้าตรวจสอบ
  for (const h of houses.slice(10, 13)) {
    await db.query(`UPDATE houses SET verified=false, note='สำรวจพบเปิดร้านค้าเพิ่ม' WHERE id=$1`, [h.id]);
    await db.query(`INSERT INTO house_changes(house_id, staff_id, action, before, after, status) VALUES ($1,$2,'UPDATE',$3::jsonb,$4::jsonb,'PENDING')`,
      [h.id, ids.survey, JSON.stringify({ note: null }), JSON.stringify({ note: 'สำรวจพบเปิดร้านค้าเพิ่ม' })]);
  }
  return { houses: houses.length };
}
