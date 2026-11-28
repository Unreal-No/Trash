// ทะเบียนบ้าน: ค้นหา, เพิ่ม/แก้ไข (สำรวจ), คิวตรวจสอบ, ค้นหาสำหรับประชาชน
import { decrypt, encrypt, maskName } from './crypto.ts';
import { can, type StaffUser } from './auth.ts';
import { cleanText, currentPeriod, formatAddress, normalizeHouseNo, randomRef, todayBangkok } from './util.ts';
import type { Db, Q } from './db.ts';
import type { SettingsService } from './settings.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export type PayStatus = 'PAID' | 'DUE' | 'OVERDUE' | 'NONE';

/** คอลัมน์บ้าน + สถานะการชำระ (นับเฉพาะงวดที่ถึงแล้ว ไม่นับงวดล่วงหน้า) — $1=งวดปัจจุบัน, $2=วันนี้ */
export const HOUSE_SELECT = `
  WITH s AS (
    SELECT house_id,
      COALESCE(sum(amount_satang) FILTER (WHERE status='UNPAID'), 0)::int AS outstanding,
      count(*) FILTER (WHERE status='UNPAID' AND due_date < $2::date)::int AS overdue,
      count(*)::int AS n
    FROM invoices WHERE status <> 'CANCELLED' AND period <= $1 GROUP BY house_id)
  SELECT h.id, h.code, h.house_no AS "houseNo", h.moo, h.soi, h.road, h.community, h.subdistrict,
    h.owner_name_enc AS "ownerNameEnc", h.phone_enc AS "phoneEnc", h.category, h.rate_satang AS "rateSatang",
    h.lat, h.lng, h.active, h.verified, h.note, h.updated_at AS "updatedAt", h.updated_by AS "updatedBy",
    COALESCE(s.outstanding, 0) AS "outstandingSatang", COALESCE(s.overdue, 0) AS "overdueCount",
    CASE WHEN s.n IS NULL THEN 'NONE' WHEN s.overdue > 0 THEN 'OVERDUE' WHEN s.outstanding > 0 THEN 'DUE' ELSE 'PAID' END AS "payStatus"
  FROM houses h LEFT JOIN s ON s.house_id = h.id`;
export const statusParams = () => [currentPeriod(), todayBangkok()];

const EDITABLE = ['houseNo', 'moo', 'soi', 'road', 'community', 'subdistrict', 'ownerName', 'phone', 'category', 'rateSatang', 'lat', 'lng', 'note', 'active'] as const;
type Editable = (typeof EDITABLE)[number];
type HouseInput = Partial<Record<Editable, unknown>> & { code?: unknown };

const COL: Record<Editable, string> = {
  houseNo: 'house_no', moo: 'moo', soi: 'soi', road: 'road', community: 'community', subdistrict: 'subdistrict',
  ownerName: 'owner_name_enc', phone: 'phone_enc', category: 'category', rateSatang: 'rate_satang', lat: 'lat', lng: 'lng',
  note: 'note', active: 'active',
};
const LABEL: Record<Editable, string> = {
  houseNo: 'บ้านเลขที่', moo: 'หมู่', soi: 'ซอย', road: 'ถนน', community: 'ชุมชน', subdistrict: 'ตำบล', ownerName: 'ชื่อเจ้าของ/ผู้ชำระ',
  phone: 'โทรศัพท์', category: 'ประเภท', rateSatang: 'อัตรา/เดือน (สตางค์)', lat: 'ละติจูด', lng: 'ลองจิจูด', note: 'หมายเหตุ', active: 'ใช้งาน',
};

export class HouseService {
  private db: Db;
  private key: Buffer;
  private settings: SettingsService;
  constructor(db: Db, key: Buffer, settings: SettingsService) {
    this.db = db;
    this.key = key;
    this.settings = settings;
  }

  private dec = (v: string | null) => (v ? decrypt(v, this.key) : '');

  /** แถวจาก HOUSE_SELECT → ข้อมูลสำหรับเจ้าหน้าที่ (ถอดรหัสชื่อ/โทร) */
  toStaffView(r: any) {
    const { ownerNameEnc, phoneEnc, ...h } = r;
    return { ...h, address: formatAddress(h), ownerName: this.dec(ownerNameEnc), phone: this.dec(phoneEnc), updatedAt: r.updatedAt && new Date(r.updatedAt).toISOString() };
  }

  /** ตัวกรองการค้นหา — บ้านเลขที่ "ตรงตัว" เท่านั้น */
  private where(f: Record<string, unknown>, params: unknown[]) {
    const w: string[] = [];
    const eq = (col: string, v: unknown) => {
      const s = cleanText(v, 100);
      if (s) {
        params.push(s);
        w.push(`${col} = $${params.length}`);
      }
    };
    if (f.houseNo) eq('h.house_no', normalizeHouseNo(String(f.houseNo)));
    eq('h.moo', f.moo);
    eq('h.soi', f.soi);
    eq('h.road', f.road);
    eq('h.community', f.community);
    eq('h.subdistrict', f.subdistrict);
    if (f.category === 'RESIDENTIAL' || f.category === 'COMMERCIAL') eq('h.category', f.category);
    return w;
  }

  async search(f: Record<string, unknown>, staff: StaffUser) {
    const params: unknown[] = statusParams();
    const w = this.where(f, params);
    const q = cleanText(f.q, 50);
    let rows = (await this.db.query(`SELECT * FROM (${HOUSE_SELECT}${w.length ? ' WHERE ' + w.join(' AND ') : ''}) x ORDER BY community NULLS LAST, road NULLS LAST, soi NULLS LAST, length("houseNo"), "houseNo"`, params)).rows.map((r) => this.toStaffView(r));
    // ชื่อเจ้าของถูกเข้ารหัส → กรองคำค้นหลังถอดรหัส
    if (q) rows = rows.filter((r) => r.code.includes(q.toUpperCase()) || r.ownerName.includes(q) || r.address.includes(q));
    if (['PAID', 'DUE', 'OVERDUE', 'NONE'].includes(String(f.payStatus))) rows = rows.filter((r) => r.payStatus === f.payStatus);
    if (f.verified === 'true' || f.verified === 'false') rows = rows.filter((r) => String(r.verified) === f.verified);
    const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 50));
    const page = Math.max(1, Number(f.page) || 1);
    await this.audit(`staff:${staff.id}`, 'SEARCH_HOUSES', JSON.stringify(f).slice(0, 200));
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  }

  async getRow(id: string, q: Q = this.db) {
    const r = await q.query(`SELECT * FROM (${HOUSE_SELECT}) x WHERE id = $3`, [...statusParams(), id]);
    return r.rows[0] ?? null;
  }

  async detail(id: string, staff: StaffUser) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'ไม่พบบ้าน');
    const row = await this.getRow(id);
    if (!row) throw new HttpError(404, 'ไม่พบบ้าน');
    const [inv, rc, links, ch] = await Promise.all([
      this.db.query(
        `SELECT id, invoice_no AS "invoiceNo", period, amount_satang AS "amountSatang", status, to_char(due_date,'YYYY-MM-DD') AS "dueDate"
         FROM invoices WHERE house_id=$1 ORDER BY period DESC LIMIT 48`, [id]),
      this.db.query(
        `SELECT r.receipt_no AS "receiptNo", r.amount_satang AS "amountSatang", r.method, r.paid_at AS "paidAt",
           COALESCE(array_agg(i.period ORDER BY i.period) FILTER (WHERE i.period IS NOT NULL), '{}') AS periods
         FROM receipts r LEFT JOIN receipt_items i ON i.receipt_no=r.receipt_no
         WHERE r.house_id=$1 AND r.voided_at IS NULL GROUP BY r.receipt_no ORDER BY r.paid_at DESC LIMIT 50`, [id]),
      this.db.query('SELECT count(*)::int AS n FROM line_links WHERE house_id=$1', [id]),
      this.db.query(
        `SELECT c.id, c.at, c.action, c.status, c.before, c.after, u.name AS "staffName", c.review_note AS "reviewNote"
         FROM house_changes c LEFT JOIN staff_users u ON u.id=c.staff_id WHERE c.house_id=$1 ORDER BY c.at DESC LIMIT 50`, [id]),
    ]);
    await this.audit(`staff:${staff.id}`, 'VIEW_HOUSE', row.code);
    return {
      house: this.toStaffView(row),
      invoices: inv.rows,
      receipts: rc.rows.map((r) => ({ ...r, paidAt: new Date(r.paidAt).toISOString() })),
      lineLinks: links.rows[0].n,
      changes: ch.rows.map((c) => ({ id: Number(c.id), at: new Date(c.at).toISOString(), action: c.action, status: c.status, staffName: c.staffName ?? '-', reviewNote: c.reviewNote, diff: this.diff(c.before, c.after) })),
    };
  }

  /** snapshot ที่เก็บใน house_changes (ชื่อ/โทรยังเข้ารหัสอยู่) */
  private snapshot(r: any) {
    return Object.fromEntries(EDITABLE.map((k) => [k, k === 'ownerName' ? r.ownerNameEnc ?? null : k === 'phone' ? r.phoneEnc ?? null : r[k] ?? null]));
  }
  private diff(before: any, after: any) {
    const show = (k: string, v: any) => (v == null || v === '' ? '' : k === 'ownerName' || k === 'phone' ? this.dec(v) : String(v));
    return EDITABLE.filter((k) => show(k, before?.[k]) !== show(k, after?.[k])).map((k) => ({ field: LABEL[k], before: show(k, before?.[k]), after: show(k, after?.[k]) }));
  }

  /** ตรวจข้อมูลที่รับเข้ามา → ค่าที่จะเขียนลง DB */
  private async parse(input: HouseInput, creating: boolean) {
    const out: Partial<Record<Editable, unknown>> = {};
    const has = (k: Editable) => creating || k in input;
    if (has('houseNo')) {
      const h = normalizeHouseNo(String(input.houseNo ?? ''));
      if (!/^[0-9]+[0-9/\-ก-ฮA-Za-z]*$/.test(h)) throw new HttpError(400, 'บ้านเลขที่ไม่ถูกต้อง');
      out.houseNo = h;
    }
    if (has('subdistrict')) {
      const s = cleanText(input.subdistrict, 100);
      if (!s) throw new HttpError(400, 'กรุณาระบุตำบล');
      out.subdistrict = s;
    }
    for (const k of ['moo', 'soi', 'road', 'community'] as const) if (has(k)) out[k] = cleanText(input[k], k === 'moo' ? 10 : 100);
    if (has('note')) out.note = cleanText(input.note, 500);
    if (has('ownerName')) { const n = cleanText(input.ownerName, 150); out.ownerName = n ? encrypt(n, this.key) : null; }
    if (has('phone')) { const p = cleanText(input.phone, 20); out.phone = p ? encrypt(p, this.key) : null; }
    if (has('category')) out.category = input.category === 'COMMERCIAL' ? 'COMMERCIAL' : 'RESIDENTIAL';
    if (has('rateSatang')) {
      if (input.rateSatang === undefined || input.rateSatang === null || input.rateSatang === '') {
        if (creating) out.rateSatang = (await this.settings.get()).rates[out.category as 'RESIDENTIAL' | 'COMMERCIAL'];
      } else {
        const n = Number(input.rateSatang);
        if (!Number.isSafeInteger(n) || n < 0 || n > 100_000_00) throw new HttpError(400, 'อัตราไม่ถูกต้อง');
        out.rateSatang = n;
      }
    }
    for (const k of ['lat', 'lng'] as const) {
      if (!has(k)) continue;
      const v = input[k];
      if (v === null || v === undefined || v === '') out[k] = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || Math.abs(n) > (k === 'lat' ? 90 : 180)) throw new HttpError(400, 'พิกัดไม่ถูกต้อง');
        out[k] = n;
      }
    }
    if (has('active')) out.active = input.active !== false;
    return out;
  }

  async create(input: HouseInput, staff: StaffUser) {
    const v = await this.parse(input, true);
    let code = cleanText(input.code, 20)?.toUpperCase() ?? null;
    if (code && !/^[A-Z0-9]{3,20}$/.test(code)) throw new HttpError(400, 'รหัสผู้ชำระต้องเป็น A-Z 0-9');
    const auto = can(staff.role, 'house.verify');
    return this.db.tx(async (q) => {
      if (!code) {
        const n = (await q.query(`SELECT count(*)::int AS n FROM houses`)).rows[0].n;
        code = 'H' + String(n + 1).padStart(5, '0');
        while ((await q.query('SELECT 1 FROM houses WHERE code=$1', [code])).rowCount) code = 'H' + randomRef(6);
      } else if ((await q.query('SELECT 1 FROM houses WHERE code=$1', [code])).rowCount) throw new HttpError(409, 'รหัสผู้ชำระนี้มีอยู่แล้ว');
      const cols = (Object.keys(v) as Editable[]).map((k) => COL[k]);
      const r = await q.query(
        `INSERT INTO houses(code, verified, updated_by, ${cols.join(', ')}) VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
        [code, auto, staff.name, ...Object.values(v)],
      );
      const id = r.rows[0].id;
      const row = await this.getRow(id, q);
      await q.query(`INSERT INTO house_changes(house_id, staff_id, action, after, status) VALUES ($1,$2,'CREATE',$3::jsonb,$4)`, [id, staff.id, JSON.stringify(this.snapshot(row)), auto ? 'AUTO' : 'PENDING']);
      await this.audit(`staff:${staff.id}`, 'CREATE_HOUSE', code!, undefined, q);
      return { house: this.toStaffView(row), changeStatus: auto ? 'AUTO' : 'PENDING' };
    });
  }

  async update(id: string, input: HouseInput, staff: StaffUser) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'ไม่พบบ้าน');
    const v = await this.parse(input, false);
    if (!Object.keys(v).length) throw new HttpError(400, 'ไม่มีข้อมูลที่แก้ไข');
    const auto = can(staff.role, 'house.verify');
    return this.db.tx(async (q) => {
      const before = await this.getRow(id, q);
      if (!before) throw new HttpError(404, 'ไม่พบบ้าน');
      const keys = Object.keys(v) as Editable[];
      await q.query(
        `UPDATE houses SET ${keys.map((k, i) => `${COL[k]} = $${i + 2}`).join(', ')}, updated_at=now(), updated_by=$${keys.length + 2},
           verified = CASE WHEN $${keys.length + 3}::boolean THEN verified ELSE false END WHERE id=$1`,
        [id, ...Object.values(v), staff.name, auto],
      );
      const after = await this.getRow(id, q);
      const b = this.snapshot(before), a = this.snapshot(after);
      if (this.diff(b, a).length)
        await q.query(`INSERT INTO house_changes(house_id, staff_id, action, before, after, status) VALUES ($1,$2,'UPDATE',$3::jsonb,$4::jsonb,$5)`, [id, staff.id, JSON.stringify(b), JSON.stringify(a), auto ? 'AUTO' : 'PENDING']);
      await this.audit(`staff:${staff.id}`, 'UPDATE_HOUSE', before.code, undefined, q);
      return { house: this.toStaffView(after), changeStatus: auto ? 'AUTO' : 'PENDING' };
    });
  }

  async pendingReviews() {
    const r = await this.db.query(
      `SELECT c.id, c.house_id AS "houseId", h.code, h.house_no AS "houseNo", h.moo, h.soi, h.road, h.community, h.subdistrict,
         c.action, c.at, u.name AS "staffName", c.before, c.after
       FROM house_changes c JOIN houses h ON h.id=c.house_id LEFT JOIN staff_users u ON u.id=c.staff_id
       WHERE c.status='PENDING' ORDER BY c.at`);
    return { items: r.rows.map((c) => ({ id: Number(c.id), houseId: c.houseId, code: c.code, houseNo: c.houseNo, address: formatAddress(c), action: c.action, at: new Date(c.at).toISOString(), staffName: c.staffName ?? '-', diff: this.diff(c.before, c.after) })) };
  }

  /** อนุมัติ = ยืนยันข้อมูล · ปฏิเสธ = ย้อนบ้านกลับเป็นข้อมูลก่อนแก้ (การสร้างใหม่ที่ถูกปฏิเสธ → ปิดใช้งาน) */
  async review(changeId: number, decision: string, note: unknown, staff: StaffUser) {
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new HttpError(400, 'decision ต้องเป็น APPROVE หรือ REJECT');
    return this.db.tx(async (q) => {
      const c = (await q.query(`SELECT * FROM house_changes WHERE id=$1 AND status='PENDING' FOR UPDATE`, [changeId])).rows[0];
      if (!c) throw new HttpError(404, 'ไม่พบรายการรอตรวจสอบ');
      await q.query(`UPDATE house_changes SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1`, [changeId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', staff.id, cleanText(note, 300)]);
      if (decision === 'REJECT') {
        if (c.action === 'CREATE') await q.query(`UPDATE houses SET active=false WHERE id=$1`, [c.house_id]);
        else {
          const keys = EDITABLE.filter((k) => c.before && k in c.before); // ย้อนเฉพาะฟิลด์ที่มีใน snapshot
          if (keys.length) await q.query(`UPDATE houses SET ${keys.map((k, i) => `${COL[k]} = $${i + 2}`).join(', ')}, updated_at=now(), updated_by=$${keys.length + 2} WHERE id=$1`, [c.house_id, ...keys.map((k) => c.before[k]), staff.name]);
        }
      }
      const left = (await q.query(`SELECT count(*)::int AS n FROM house_changes WHERE house_id=$1 AND status='PENDING'`, [c.house_id])).rows[0].n;
      if (left === 0) await q.query(`UPDATE houses SET verified=true WHERE id=$1`, [c.house_id]);
      await this.audit(`staff:${staff.id}`, `REVIEW_${decision}`, String(changeId), undefined, q);
      return { ok: true };
    });
  }

  async addressOptions(publicOnly = false) {
    const s = await this.settings.get();
    const r = await this.db.query(
      `SELECT array_agg(DISTINCT subdistrict) AS sd, array_agg(DISTINCT community) FILTER (WHERE community IS NOT NULL) AS cm,
         array_agg(DISTINCT road) FILTER (WHERE road IS NOT NULL) AS rd, array_agg(DISTINCT soi) FILTER (WHERE soi IS NOT NULL) AS so,
         array_agg(DISTINCT moo) FILTER (WHERE moo IS NOT NULL) AS mo
       FROM houses WHERE active`);
    const x = r.rows[0] ?? {};
    const merge = (a: string[], b: string[] | null) => [...new Set([...a, ...(b ?? [])])].sort((p, q) => p.localeCompare(q, 'th'));
    const out = { subdistricts: merge(s.areas.subdistricts, x.sd), communities: merge(s.areas.communities, x.cm), roads: merge(s.areas.roads, x.rd), sois: merge(s.areas.sois, x.so) };
    return publicOnly ? out : { ...out, moos: merge([], x.mo) };
  }

  /** ประชาชนค้นหาบ้านตัวเอง: ต้องระบุบ้านเลขที่ (ตรงตัว) · แสดงชื่อแบบปิดบัง · สูงสุด 20 */
  async publicSearch(f: Record<string, unknown>) {
    if (!(await this.settings.get()).features.liffHouseSearch) throw new HttpError(403, 'ปิดการค้นหาบ้าน');
    const houseNo = normalizeHouseNo(String(f.houseNo ?? ''));
    if (!houseNo) throw new HttpError(400, 'กรุณาระบุบ้านเลขที่');
    const params: unknown[] = [];
    const w = this.where({ ...f, houseNo }, params);
    const r = await this.db.query(
      `SELECT code, house_no AS "houseNo", moo, soi, road, community, subdistrict, owner_name_enc, category
       FROM houses h WHERE active AND ${w.join(' AND ')} ORDER BY community, road, soi LIMIT 20`, params);
    return {
      items: r.rows.map(({ owner_name_enc, ...h }) => ({ ...h, address: formatAddress(h), ownerMasked: owner_name_enc ? maskName(this.dec(owner_name_enc)) : '-' })),
    };
  }

  private async audit(actor: string, action: string, target: string, meta?: unknown, q: Q = this.db) {
    await q.query('INSERT INTO audit_logs(actor, action, target, meta) VALUES ($1,$2,$3,$4::jsonb)', [actor, action, target, meta === undefined ? null : JSON.stringify(meta)]);
  }
}
