// Dashboard สรุปผล, แผนที่สถานะการชำระ, รายงานส่งออก
import { HOUSE_SELECT, HttpError, statusParams, type HouseService } from './houses.ts';
import { currentPeriod, fiscalYearBE, fiscalYearPeriods, formatAddress } from './util.ts';
import type { StaffUser } from './auth.ts';
import type { Db } from './db.ts';
import type { SettingsService } from './settings.ts';

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export class DashboardService {
  private db: Db;
  private settings: SettingsService;
  private houses: HouseService;
  constructor(db: Db, settings: SettingsService, houses: HouseService) {
    this.db = db;
    this.settings = settings;
    this.houses = houses;
  }

  async dashboard(fyParam: unknown) {
    const current = fiscalYearBE(new Date().toISOString());
    const fy = Number(fyParam) || current;
    if (fy < current - 5 || fy > current + 1) throw new HttpError(400, 'ปีงบประมาณไม่ถูกต้อง');
    const now = currentPeriod();
    const periods = fiscalYearPeriods(fy).filter((p) => p <= now); // เฉพาะงวดที่ถึงแล้ว
    const fyStart = `${fy - 1 - 543}-10-01T00:00:00+07:00`;
    const fyEnd = `${fy - 543}-10-01T00:00:00+07:00`;

    const houses = (await this.db.query(`SELECT * FROM (${HOUSE_SELECT}) x WHERE active`, statusParams())).rows;
    const all = (await this.db.query(`SELECT count(*)::int AS n FROM houses`)).rows[0].n;
    const pending = (await this.db.query(`SELECT count(DISTINCT house_id)::int AS n FROM house_changes WHERE status='PENDING'`)).rows[0].n;

    const monthly = (await this.db.query(
      `SELECT period, sum(amount_satang)::int AS inv, COALESCE(sum(amount_satang) FILTER (WHERE status='PAID'),0)::int AS paid
       FROM invoices WHERE status <> 'CANCELLED' AND period = ANY($1::text[]) GROUP BY period`, [periods])).rows;
    const byPeriod = new Map(monthly.map((m) => [m.period, m]));
    const invoiced = monthly.reduce((s, m) => s + m.inv, 0);
    const paid = monthly.reduce((s, m) => s + m.paid, 0);

    const methods = (await this.db.query(
      `SELECT method, sum(amount_satang)::int AS s FROM receipts WHERE voided_at IS NULL AND paid_at >= $1 AND paid_at < $2 GROUP BY method`, [fyStart, fyEnd])).rows;

    const payStatus = { PAID: 0, DUE: 0, OVERDUE: 0, NONE: 0 } as Record<string, number>;
    const comm = new Map<string, { community: string; houses: number; paid: number; due: number; overdue: number; none: number; outstandingSatang: number }>();
    for (const h of houses) {
      payStatus[h.payStatus]!++;
      const k = h.community ?? '(ไม่ระบุชุมชน)';
      const c = comm.get(k) ?? { community: k, houses: 0, paid: 0, due: 0, overdue: 0, none: 0, outstandingSatang: 0 };
      c.houses++;
      c[({ PAID: 'paid', DUE: 'due', OVERDUE: 'overdue', NONE: 'none' } as const)[h.payStatus as 'PAID']]++;
      c.outstandingSatang += h.outstandingSatang;
      comm.set(k, c);
    }

    const recent = (await this.db.query(
      `SELECT r.receipt_no AS "receiptNo", h.code, h.house_no AS "houseNo", h.moo, h.soi, h.road, h.community, h.subdistrict,
         r.amount_satang AS "amountSatang", r.method, r.paid_at AS "paidAt"
       FROM receipts r JOIN houses h ON h.id=r.house_id WHERE r.voided_at IS NULL ORDER BY r.paid_at DESC, r.receipt_no DESC LIMIT 10`)).rows;

    return {
      fy,
      houses: {
        total: all,
        active: houses.length,
        residential: houses.filter((h) => h.category === 'RESIDENTIAL').length,
        commercial: houses.filter((h) => h.category === 'COMMERCIAL').length,
        verified: houses.filter((h) => h.verified).length,
        pendingReview: pending,
        withLocation: houses.filter((h) => h.lat != null && h.lng != null).length,
      },
      billing: { invoicedSatang: invoiced, paidSatang: paid, outstandingSatang: invoiced - paid, collectionRate: pct(paid, invoiced) },
      payStatus,
      monthly: fiscalYearPeriods(fy).map((p) => ({ period: p, invoicedSatang: byPeriod.get(p)?.inv ?? 0, paidSatang: byPeriod.get(p)?.paid ?? 0 })),
      byMethod: { QR: 0, BANK: 0, CASH: 0, ...Object.fromEntries(methods.map((m) => [m.method, m.s])) },
      byCommunity: [...comm.values()].sort((a, b) => b.outstandingSatang - a.outstandingSatang),
      topDebtors: houses
        .filter((h) => h.outstandingSatang > 0)
        .sort((a, b) => b.outstandingSatang - a.outstandingSatang)
        .slice(0, 10)
        .map((h) => ({ id: h.id, code: h.code, address: formatAddress(h), outstandingSatang: h.outstandingSatang, overdueCount: h.overdueCount })),
      recentPayments: recent.map((r) => ({ receiptNo: r.receiptNo, code: r.code, address: formatAddress(r), amountSatang: r.amountSatang, method: r.method, paidAt: new Date(r.paidAt).toISOString() })),
    };
  }

  /** แผนที่ — ปิดได้ในตั้งค่า · ไม่ส่งชื่อเจ้าของ (PDPA) */
  async map(f: Record<string, unknown>) {
    const s = await this.settings.get();
    if (!s.features.mapEnabled) throw new HttpError(403, 'MAP_DISABLED');
    const rows = (await this.db.query(`SELECT * FROM (${HOUSE_SELECT}) x WHERE active AND lat IS NOT NULL AND lng IS NOT NULL`, statusParams())).rows;
    const show = s.features.mapShowStatus;
    return {
      center: s.map,
      showStatus: show,
      points: rows
        .filter((h) => !f.community || h.community === f.community)
        .filter((h) => !show || !f.payStatus || h.payStatus === f.payStatus)
        .map((h) => ({
          id: h.id, code: h.code, address: formatAddress(h), community: h.community, category: h.category, lat: h.lat, lng: h.lng,
          ...(show ? { payStatus: h.payStatus, outstandingSatang: h.outstandingSatang } : {}),
        })),
    };
  }

  /** รายงานยอดค้าง (CSV, UTF-8 BOM ให้ Excel อ่านภาษาไทยได้) */
  async outstandingCsv(staff: StaffUser) {
    const rows = (await this.db.query(`SELECT * FROM (${HOUSE_SELECT}) x WHERE active AND "outstandingSatang" > 0 ORDER BY community NULLS LAST, "outstandingSatang" DESC`, statusParams())).rows.map((r) => this.houses.toStaffView(r));
    const cell = (v: unknown) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = "'" + s; // กัน CSV/formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['รหัสผู้ชำระ', 'ที่อยู่', 'ชุมชน', 'ชื่อผู้ชำระ', 'ประเภท', 'ยอดค้าง (บาท)', 'งวดที่เลยกำหนด', 'สถานะ'];
    const lines = rows.map((r) => [r.code, r.address, r.community, r.ownerName, r.category === 'COMMERCIAL' ? 'ร้านค้า/กิจการ' : 'ที่อยู่อาศัย', (r.outstandingSatang / 100).toFixed(2), r.overdueCount, r.payStatus === 'OVERDUE' ? 'ค้างชำระ' : 'รอชำระ'].map(cell).join(','));
    await this.db.query(`INSERT INTO audit_logs(actor, action, target) VALUES ($1,'EXPORT_OUTSTANDING',$2)`, [`staff:${staff.id}`, String(rows.length)]);
    return '﻿' + [head.join(','), ...lines].join('\r\n');
  }

  async audit(limit: unknown) {
    const n = Math.min(1000, Math.max(1, Number(limit) || 200));
    const r = await this.db.query(
      `SELECT a.at, COALESCE(u.name || ' (' || u.role || ')', a.actor) AS actor, a.action, a.target
       FROM audit_logs a LEFT JOIN staff_users u ON a.actor = 'staff:' || u.id::text ORDER BY a.at DESC, a.id DESC LIMIT $1`, [n]);
    return { items: r.rows.map((x) => ({ ...x, at: new Date(x.at).toISOString() })) };
  }
}
