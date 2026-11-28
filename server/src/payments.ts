// การเงิน: บัญชี LINE, คำนวณยอด, คำสั่งชำระ + Thai QR, callback ธนาคาร, รับเงินสด, ใบเสร็จ
import QRCode from 'qrcode';
import { decrypt, hmacHex, maskName, safeEqual } from './crypto.ts';
import { buildBillPaymentPayload } from './promptpay.ts';
import { receiptFlex, type LineClient } from './line.ts';
import { can, type StaffUser } from './auth.ts';
import { HttpError } from './houses.ts';
import {
  currentPeriod, dueDateOf, fiscalYearBE, fiscalYearPeriods, formatAddress, formatReceiptNo, periodsSummary, randomRef,
} from './util.ts';
import type { BankPayment } from './bank/adapter.ts';
import type { Config } from './config.ts';
import type { Db, Q } from './db.ts';

export const CONSENT_VERSION = '1.0';
const MAX_LINKS = 20;

export interface Selection {
  invoiceIds: string[];
  years: { payerCode: string; fiscalYear: number }[];
}

const UUID = /^[0-9a-f-]{36}$/i;
export function parseSelection(body: unknown): Selection {
  const b = (body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.invoiceIds) ? b.invoiceIds : [];
  const years = Array.isArray(b.years) ? b.years : [];
  if (ids.length > 120 || years.length > 20) throw new HttpError(400, 'เลือกรายการมากเกินไป');
  if (!ids.every((x) => typeof x === 'string' && UUID.test(x))) throw new HttpError(400, 'ข้อมูลไม่ถูกต้อง');
  return {
    invoiceIds: ids as string[],
    years: years.map((y) => {
      const { payerCode, fiscalYear } = (y ?? {}) as Record<string, unknown>;
      if (typeof payerCode !== 'string' || !Number.isInteger(fiscalYear)) throw new HttpError(400, 'ข้อมูลไม่ถูกต้อง');
      return { payerCode: payerCode.trim().toUpperCase(), fiscalYear: fiscalYear as number };
    }),
  };
}

interface HouseLite { id: string; code: string; houseNo: string; moo: string | null; soi: string | null; road: string | null; community: string | null; subdistrict: string; ownerNameEnc: string | null; category: string; rateSatang: number }
const HOUSE_LITE = `id, code, house_no AS "houseNo", moo, soi, road, community, subdistrict, owner_name_enc AS "ownerNameEnc", category, rate_satang AS "rateSatang"`;
const INV_COLS = `id, invoice_no AS "invoiceNo", house_id AS "houseId", period, amount_satang AS "amountSatang", status, to_char(due_date,'YYYY-MM-DD') AS "dueDate"`;

interface QuoteItem { invoiceId: string; houseId: string; payerCode: string; label?: string; period: string; amountSatang: number }
const publicItem = ({ houseId: _, ...i }: QuoteItem) => i;
const publicInvoice = ({ houseId: _, ...i }: any) => i;

export class PaymentService {
  private db: Db;
  private cfg: Config;
  private line: LineClient;
  private municipalityName: () => Promise<string>;
  constructor(db: Db, cfg: Config, line: LineClient, municipalityName: () => Promise<string>) {
    this.db = db;
    this.cfg = cfg;
    this.line = line;
    this.municipalityName = municipalityName;
  }

  private dec = (v: string | null) => (v ? decrypt(v, this.cfg.dataKey) : '');
  private async audit(actor: string, action: string, target: string, meta?: unknown, q: Q = this.db) {
    await q.query('INSERT INTO audit_logs(actor, action, target, meta) VALUES ($1,$2,$3,$4::jsonb)', [actor, action, target, meta === undefined ? null : JSON.stringify(meta)]);
  }
  private async houseByCode(code: string) {
    return (await this.db.query<HouseLite>(`SELECT ${HOUSE_LITE} FROM houses WHERE code=$1 AND active`, [code.trim().toUpperCase()])).rows[0] ?? null;
  }
  private async linked(lineUserId: string) {
    const r = await this.db.query<HouseLite & { label: string }>(
      `SELECT ${HOUSE_LITE.replace(/(^|, )(?=\w)/g, '$1h.')}, l.label FROM line_links l JOIN houses h ON h.id=l.house_id WHERE l.line_user_id=$1 ORDER BY l.linked_at`,
      [lineUserId],
    );
    return r.rows;
  }
  /** ใบแจ้งหนี้ที่แสดง: งวดที่ถึงแล้ว + ที่ชำระแล้ว (ไม่แสดงงวดล่วงหน้าที่ยังไม่จ่าย) */
  private async visibleInvoices(houseId: string) {
    const r = await this.db.query(`SELECT ${INV_COLS} FROM invoices WHERE house_id=$1 AND status <> 'CANCELLED' AND (period <= $2 OR status='PAID') ORDER BY period DESC LIMIT 36`, [houseId, currentPeriod()]);
    return r.rows.reverse().map(publicInvoice);
  }

  // ---------- บัญชีที่ผูกกับ LINE ----------
  async accountsFor(lineUserId: string) {
    const accounts = await Promise.all(
      (await this.linked(lineUserId)).map(async (h) => {
        const address = formatAddress(h);
        return {
          code: h.code, label: h.label, category: h.category, rateSatang: h.rateSatang,
          nameMasked: h.ownerNameEnc ? maskName(this.dec(h.ownerNameEnc)) : '-',
          address, addressMasked: address,
          invoices: await this.visibleInvoices(h.id),
        };
      }),
    );
    return { accounts, currentFiscalYear: fiscalYearBE(new Date().toISOString()) };
  }

  async link(lineUserId: string, payerCode: string, invoiceNo: string, label: string, consent: boolean) {
    if (!consent) throw new HttpError(400, 'ต้องยินยอมนโยบายความเป็นส่วนตัว');
    const code = payerCode.trim().toUpperCase();
    // ยืนยันด้วยเลขใบแจ้งหนี้ (สุ่ม เดาไม่ได้) — ผูกบ้านคนอื่นได้เมื่อมีใบแจ้งหนี้ของบ้านนั้น
    const r = await this.db.query(`SELECT h.id FROM invoices i JOIN houses h ON h.id=i.house_id WHERE h.code=$1 AND h.active AND i.invoice_no=$2`, [code, invoiceNo.trim().toUpperCase()]);
    const houseId = r.rows[0]?.id;
    if (!houseId) throw new HttpError(404, 'รหัสผู้ชำระหรือเลขที่ใบแจ้งหนี้ไม่ถูกต้อง');
    const linked = await this.linked(lineUserId);
    if (!linked.some((l) => l.id === houseId) && linked.length >= MAX_LINKS) throw new HttpError(409, `ผูกได้สูงสุด ${MAX_LINKS} บัญชี`);
    const clean = label.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30) || `บัญชี ${code}`;
    await this.db.query(
      `INSERT INTO line_links(line_user_id, house_id, label, consent_version) VALUES ($1,$2,$3,$4)
       ON CONFLICT (line_user_id, house_id) DO UPDATE SET label=$3, consent_version=$4`,
      [lineUserId, houseId, clean, CONSENT_VERSION],
    );
    await this.audit(`line:${lineUserId}`, 'LINK', code, { consent: CONSENT_VERSION });
    return this.accountsFor(lineUserId);
  }

  async unlink(lineUserId: string, payerCode: string) {
    const r = await this.db.query(`DELETE FROM line_links l USING houses h WHERE h.id=l.house_id AND l.line_user_id=$1 AND h.code=$2`, [lineUserId, payerCode.trim().toUpperCase()]);
    if (r.rowCount) await this.audit(`line:${lineUserId}`, 'UNLINK', payerCode);
  }

  // ---------- คำนวณยอด ----------
  /** allowed = null หมายถึงเจ้าหน้าที่ (ทุกบ้าน) */
  private async resolve(sel: Selection, allowed: Map<string, string> | null) {
    const current = fiscalYearBE(new Date().toISOString());
    const ids = new Set(sel.invoiceIds);
    for (const y of sel.years) {
      const h = await this.houseByCode(y.payerCode);
      if (!h || (allowed && !allowed.has(h.id))) throw new HttpError(404, 'ไม่พบบัญชีผู้ชำระ');
      if (y.fiscalYear < current || y.fiscalYear > current + 1) throw new HttpError(400, 'เลือกได้เฉพาะปีงบประมาณปัจจุบันหรือปีถัดไป');
      if (h.rateSatang <= 0) throw new HttpError(400, `บัญชี ${h.code} ยังไม่กำหนดอัตราค่าธรรมเนียม`);
      const periods = fiscalYearPeriods(y.fiscalYear);
      for (const period of periods)
        await this.db.query(
          `INSERT INTO invoices(invoice_no, house_id, period, amount_satang, due_date) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (house_id, period) DO NOTHING`,
          [period.replace('-', '').slice(2) + randomRef(8), h.id, period, h.rateSatang, dueDateOf(period)],
        );
      const r = await this.db.query(`SELECT id FROM invoices WHERE house_id=$1 AND status='UNPAID' AND period = ANY($2::text[])`, [h.id, periods]);
      r.rows.forEach((x) => ids.add(x.id));
    }
    if (!ids.size) throw new HttpError(400, 'กรุณาเลือกรายการที่ต้องการชำระ');
    const r = await this.db.query(
      `SELECT i.id, i.house_id AS "houseId", i.period, i.amount_satang AS "amountSatang", i.status, h.code
       FROM invoices i JOIN houses h ON h.id=i.house_id WHERE i.id = ANY($1::uuid[])`, [[...ids]]);
    if (r.rows.length !== ids.size) throw new HttpError(404, 'ไม่พบใบแจ้งหนี้บางรายการ');
    const items: QuoteItem[] = r.rows.map((i) => {
      if (allowed && !allowed.has(i.houseId)) throw new HttpError(404, 'ไม่พบใบแจ้งหนี้');
      if (i.status !== 'UNPAID') throw new HttpError(409, 'มีงวดที่ชำระแล้วหรือถูกยกเลิก กรุณาโหลดใหม่');
      return { invoiceId: i.id, houseId: i.houseId, payerCode: i.code, label: allowed?.get(i.houseId), period: i.period, amountSatang: i.amountSatang };
    });
    items.sort((a, b) => a.payerCode.localeCompare(b.payerCode) || a.period.localeCompare(b.period));
    return { items, amountSatang: items.reduce((s, i) => s + i.amountSatang, 0) };
  }

  private async lineScope(lineUserId: string) {
    return new Map((await this.linked(lineUserId)).map((l) => [l.id, l.label]));
  }

  async quoteForLine(lineUserId: string, sel: Selection) {
    const q = await this.resolve(sel, await this.lineScope(lineUserId));
    return { amountSatang: q.amountSatang, items: q.items.map(publicItem) };
  }

  private async createOrder(prefix: string, createdBy: string, items: QuoteItem[]) {
    const orderNo = prefix + randomRef(11);
    const amount = items.reduce((s, i) => s + i.amountSatang, 0);
    const id = await this.db.tx(async (q) => {
      const r = await q.query(`INSERT INTO orders(order_no, created_by, amount_satang) VALUES ($1,$2,$3) RETURNING id`, [orderNo, createdBy, amount]);
      for (const it of items) await q.query('INSERT INTO order_items(order_id, invoice_id, amount_satang) VALUES ($1,$2,$3)', [r.rows[0].id, it.invoiceId, it.amountSatang]);
      return r.rows[0].id as string;
    });
    return { id, orderNo, amountSatang: amount };
  }

  async createQrOrder(lineUserId: string, sel: Selection) {
    const q = await this.resolve(sel, await this.lineScope(lineUserId));
    const order = await this.createOrder('Q', `line:${lineUserId}`, q.items);
    const payload = buildBillPaymentPayload({ billerId: this.cfg.billerId, ref1: order.orderNo, amountSatang: order.amountSatang });
    await this.audit(`line:${lineUserId}`, 'CREATE_ORDER', order.orderNo, { n: q.items.length });
    return {
      orderNo: order.orderNo,
      amountSatang: order.amountSatang,
      items: q.items.map(publicItem),
      payload,
      qrDataUrl: await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
      expiresAt: new Date(Date.now() + this.cfg.qrTtlMinutes * 60_000).toISOString(),
    };
  }

  async orderStatus(lineUserId: string, orderNo: string) {
    const o = (await this.db.query(`SELECT order_no AS "orderNo", status, amount_satang AS "amountSatang", created_by FROM orders WHERE order_no=$1`, [orderNo])).rows[0];
    if (!o || o.created_by !== `line:${lineUserId}`) throw new HttpError(404, 'ไม่พบรายการ');
    return { orderNo: o.orderNo, status: o.status, amountSatang: o.amountSatang };
  }

  private async receiptsOf(houseIds: string[]) {
    if (!houseIds.length) return [];
    const r = await this.db.query(
      `SELECT r.receipt_no AS "receiptNo", r.house_id AS "houseId", r.amount_satang AS "amountSatang", r.method, r.paid_at AS "paidAt",
         COALESCE(array_agg(i.period ORDER BY i.period) FILTER (WHERE i.period IS NOT NULL), '{}') AS periods
       FROM receipts r LEFT JOIN receipt_items i ON i.receipt_no=r.receipt_no
       WHERE r.house_id = ANY($1::uuid[]) AND r.voided_at IS NULL GROUP BY r.receipt_no ORDER BY r.paid_at DESC, r.receipt_no DESC LIMIT 50`, [houseIds]);
    return r.rows.map((x) => ({ ...x, paidAt: new Date(x.paidAt).toISOString() }));
  }

  async receiptsFor(lineUserId: string) {
    const linked = await this.linked(lineUserId);
    const by = new Map(linked.map((l) => [l.id, l]));
    return {
      receipts: (await this.receiptsOf(linked.map((l) => l.id))).map(({ houseId, ...r }) => ({
        ...r, payerCode: by.get(houseId)?.code ?? '-', label: by.get(houseId)?.label ?? '', verifyUrl: this.verifyUrl(r.receiptNo),
      })),
    };
  }

  // ---------- บันทึกการชำระ (atomic) ----------
  private async recordPayment(p: { orderId: string; method: 'QR' | 'BANK' | 'CASH'; amountSatang: number; bankTxnId: string | null; staffId: string | null; paidAt: string; raw?: unknown }) {
    try {
      return await this.db.tx(async (q) => {
        if (p.bankTxnId && (await q.query('SELECT 1 FROM payments WHERE bank_txn_id=$1', [p.bankTxnId])).rowCount) return { kind: 'DUPLICATE' as const };
        const order = (await q.query(`SELECT id, status, amount_satang FROM orders WHERE id=$1 FOR UPDATE`, [p.orderId])).rows[0];
        if (!order) return { kind: 'NOT_FOUND' as const };
        const invs = (await q.query(
          `SELECT i.id, i.house_id, i.period, i.amount_satang, i.status FROM invoices i JOIN order_items oi ON oi.invoice_id=i.id
           WHERE oi.order_id=$1 ORDER BY i.id FOR UPDATE OF i`, [order.id])).rows;
        const result = order.status === 'PAID' || invs.some((i) => i.status !== 'UNPAID') ? 'REFUND' : p.amountSatang !== order.amount_satang ? 'MISMATCH' : 'PAID';
        const pay = await q.query(
          `INSERT INTO payments(order_id, method, amount_satang, bank_txn_id, staff_id, result, raw, paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
          [order.id, p.method, p.amountSatang, p.bankTxnId, p.staffId, result, p.raw === undefined ? null : JSON.stringify(p.raw), p.paidAt]);
        if (result !== 'PAID') {
          if (order.status !== 'PAID') await q.query('UPDATE orders SET status=$2 WHERE id=$1', [order.id, result]);
          return { kind: result } as { kind: 'REFUND' | 'MISMATCH' };
        }
        await q.query(`UPDATE orders SET status='PAID' WHERE id=$1`, [order.id]);
        await q.query(`UPDATE invoices SET status='PAID' WHERE id = ANY($1::uuid[])`, [invs.map((i) => i.id)]);
        const byHouse = new Map<string, any[]>();
        for (const i of invs.sort((a, b) => a.period.localeCompare(b.period))) byHouse.set(i.house_id, [...(byHouse.get(i.house_id) ?? []), i]);
        const year = fiscalYearBE(p.paidAt);
        const receipts: { receiptNo: string; houseId: string; amountSatang: number; method: string; paidAt: string; periods: string[] }[] = [];
        for (const [houseId, list] of byHouse) {
          const seq = await q.query(
            `INSERT INTO receipt_counters(year, last) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last = receipt_counters.last + 1 RETURNING last`, [year]);
          const receiptNo = formatReceiptNo(year, seq.rows[0].last);
          const amount = list.reduce((s, i) => s + i.amount_satang, 0);
          await q.query(
            `INSERT INTO receipts(receipt_no, house_id, order_id, payment_id, amount_satang, method, staff_id, paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [receiptNo, houseId, order.id, pay.rows[0].id, amount, p.method, p.staffId, p.paidAt]);
          for (const i of list) await q.query('INSERT INTO receipt_items(receipt_no, invoice_id, period, amount_satang) VALUES ($1,$2,$3,$4)', [receiptNo, i.id, i.period, i.amount_satang]);
          receipts.push({ receiptNo, houseId, amountSatang: amount, method: p.method, paidAt: p.paidAt, periods: list.map((i) => i.period) });
        }
        return { kind: 'PAID' as const, receipts };
      });
    } catch (e) {
      // callback ซ้ำที่มาพร้อมกัน → unique violation บน bank_txn_id
      if ((e as { code?: string }).code === '23505' && p.bankTxnId) return { kind: 'DUPLICATE' as const };
      throw e;
    }
  }

  // ---------- ธนาคาร ----------
  async handleBankPayment(p: BankPayment) {
    if (p.billerId !== this.cfg.billerId) throw new HttpError(400, 'unknown biller');
    const order = (await this.db.query(`SELECT id FROM orders WHERE order_no=$1`, [p.ref1])).rows[0];
    if (!order) {
      await this.audit('bank', 'UNMATCHED_PAYMENT', p.txnId, p);
      return { kind: 'NOT_FOUND' as const };
    }
    const res = await this.recordPayment({ orderId: order.id, method: p.channel, amountSatang: p.amountSatang, bankTxnId: p.txnId, staffId: null, paidAt: p.paidAt, raw: p });
    if (res.kind === 'PAID') await this.notify(res.receipts);
    else if (res.kind !== 'DUPLICATE') await this.audit('bank', `PAYMENT_${res.kind}`, p.txnId, p); // ให้เจ้าหน้าที่ตรวจ/คืนเงิน
    return res;
  }

  // ---------- เคาน์เตอร์ ----------
  async staffLookup(staff: StaffUser, code: string) {
    const h = await this.houseByCode(code);
    if (!h) throw new HttpError(404, 'ไม่พบผู้ชำระ');
    await this.audit(`staff:${staff.id}`, 'VIEW_PAYER', h.code);
    return {
      payer: { code: h.code, name: this.dec(h.ownerNameEnc), address: formatAddress(h), category: h.category, rateSatang: h.rateSatang },
      invoices: await this.visibleInvoices(h.id),
      currentFiscalYear: fiscalYearBE(new Date().toISOString()),
    };
  }

  async staffQuote(_staff: StaffUser, sel: Selection) {
    const q = await this.resolve(sel, null);
    return { amountSatang: q.amountSatang, items: q.items.map(publicItem) };
  }

  async counterPay(staff: StaffUser, sel: Selection, receivedSatang: number) {
    if (!can(staff.role, 'payment.cash')) throw new HttpError(403, 'ไม่มีสิทธิ์รับชำระ');
    const q = await this.resolve(sel, null);
    if (!Number.isSafeInteger(receivedSatang) || receivedSatang < q.amountSatang) throw new HttpError(400, 'จำนวนเงินที่รับไม่พอ');
    const order = await this.createOrder('C', `staff:${staff.id}`, q.items);
    const res = await this.recordPayment({ orderId: order.id, method: 'CASH', amountSatang: order.amountSatang, bankTxnId: null, staffId: staff.id, paidAt: new Date().toISOString() });
    if (res.kind !== 'PAID') throw new HttpError(409, 'มีงวดที่ชำระแล้ว กรุณาค้นหาใหม่');
    await this.audit(`staff:${staff.id}`, 'CASH_PAYMENT', order.orderNo, { receipts: res.receipts.map((r) => r.receiptNo) });
    const lineNotified = await this.notify(res.receipts);
    const codes = new Map(q.items.map((i) => [i.houseId, i.payerCode]));
    return {
      receipts: res.receipts.map((r) => ({ receiptNo: r.receiptNo, payerCode: codes.get(r.houseId) ?? '-', amountSatang: r.amountSatang, periods: r.periods, verifyUrl: this.verifyUrl(r.receiptNo) })),
      amountSatang: order.amountSatang,
      changeSatang: receivedSatang - order.amountSatang,
      lineNotified,
    };
  }

  /** ออกใบแจ้งหนี้ประจำงวดให้ทุกบ้านที่ใช้งานและมีอัตรา */
  async generateBilling(staff: StaffUser, period: string) {
    if (!/^25\d\d-(0[1-9]|1[0-2])$/.test(period)) throw new HttpError(400, 'งวดต้องเป็นรูปแบบ 2569-11');
    const houses = (await this.db.query(`SELECT id, rate_satang FROM houses WHERE active AND rate_satang > 0`)).rows;
    let created = 0;
    await this.db.tx(async (q) => {
      for (const h of houses) {
        const r = await q.query(
          `INSERT INTO invoices(invoice_no, house_id, period, amount_satang, due_date) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (house_id, period) DO NOTHING RETURNING id`,
          [period.replace('-', '').slice(2) + randomRef(8), h.id, period, h.rate_satang, dueDateOf(period)]);
        created += r.rows.length;
      }
    });
    await this.audit(`staff:${staff.id}`, 'GENERATE_BILLING', period, { created });
    return { created, skipped: houses.length - created };
  }

  // ---------- ใบเสร็จ ----------
  private receiptSig(no: string) {
    return hmacHex(this.cfg.receiptSecret, no).slice(0, 20);
  }
  verifyUrl(no: string) {
    return `${this.cfg.baseUrl}/r/${encodeURIComponent(no)}?sig=${this.receiptSig(no)}`;
  }
  async verifyReceipt(no: string, sig: string) {
    if (!safeEqual(sig, this.receiptSig(no))) return null;
    const r = (await this.db.query(
      `SELECT r.receipt_no AS "receiptNo", r.amount_satang AS "amountSatang", r.method, r.paid_at AS "paidAt", h.code AS "payerCode",
         array_agg(i.period ORDER BY i.period) AS periods
       FROM receipts r JOIN houses h ON h.id=r.house_id JOIN receipt_items i ON i.receipt_no=r.receipt_no
       WHERE r.receipt_no=$1 AND r.voided_at IS NULL GROUP BY r.receipt_no, h.code`, [no])).rows[0];
    return r ? { ...r, paidAt: new Date(r.paidAt).toISOString(), periods: periodsSummary(r.periods) } : null;
  }

  /** ส่งใบเสร็จเข้า LINE ทุกคนที่ผูกกับบ้านนั้น — ล้มเหลวไม่กระทบการชำระ */
  private async notify(receipts: { receiptNo: string; houseId: string; amountSatang: number; method: string; paidAt: string; periods: string[] }[]) {
    const municipality = await this.municipalityName();
    const perUser = new Map<string, unknown[]>();
    for (const r of receipts) {
      const h = (await this.db.query<HouseLite>(`SELECT ${HOUSE_LITE} FROM houses WHERE id=$1`, [r.houseId])).rows[0];
      const msg = receiptFlex({
        municipality, receiptNo: r.receiptNo, payerCode: h?.code ?? '-', address: h ? formatAddress(h) : '-',
        periods: periodsSummary(r.periods), amountSatang: r.amountSatang, method: r.method as 'QR' | 'BANK' | 'CASH', paidAt: r.paidAt, verifyUrl: this.verifyUrl(r.receiptNo),
      });
      const users = await this.db.query(`SELECT line_user_id FROM line_links WHERE house_id=$1`, [r.houseId]);
      for (const { line_user_id: u } of users.rows) perUser.set(u, [...(perUser.get(u) ?? []), msg]);
    }
    const sends: Promise<void>[] = [];
    for (const [u, msgs] of perUser) for (let i = 0; i < msgs.length; i += 5) sends.push(this.line.push(u, msgs.slice(i, i + 5)));
    const results = await Promise.allSettled(sends);
    results.forEach((x) => x.status === 'rejected' && console.error('LINE push failed', x.reason));
    return results.some((x) => x.status === 'fulfilled');
  }
}
