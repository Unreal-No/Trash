import QRCode from 'qrcode';
import { decrypt, hmacHex, maskAddress, maskName, safeEqual } from './crypto.ts';
import { buildBillPaymentPayload } from './promptpay.ts';
import { receiptFlex, type LineClient } from './line.ts';
import { dueDateOf, fiscalYearBE, fiscalYearPeriods, periodsSummary, randomRef } from './util.ts';
import type { BankPayment } from './bank/adapter.ts';
import type { Config } from './config.ts';
import type { Invoice, Payer, Receipt, Staff, Store } from './store/types.ts';

export const CONSENT_VERSION = '1.0';
const MAX_LINKS = 20;

export class AppError extends Error {
  status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

/** สิ่งที่ผู้ใช้เลือกจ่าย: งวดที่ค้าง + ทั้งปีงบประมาณของบัญชีใดๆ */
export interface Selection {
  invoiceIds: string[];
  years: { payerCode: string; fiscalYear: number }[];
}

interface QuoteItem {
  invoiceId: string;
  payerId: string;
  payerCode: string;
  label?: string;
  period: string;
  amountSatang: number;
}

const publicInvoice = (i: Invoice) => ({
  id: i.id,
  invoiceNo: i.invoiceNo,
  period: i.period,
  amountSatang: i.amountSatang,
  status: i.status,
  dueDate: i.dueDate,
});
const publicItem = ({ payerId: _, ...i }: QuoteItem) => i;

export function parseSelection(body: unknown): Selection {
  const b = (body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.invoiceIds) ? b.invoiceIds : [];
  const years = Array.isArray(b.years) ? b.years : [];
  if (ids.length > 120 || years.length > 20) throw new AppError(400, 'เลือกรายการมากเกินไป');
  if (!ids.every((x) => typeof x === 'string')) throw new AppError(400, 'ข้อมูลไม่ถูกต้อง');
  return {
    invoiceIds: ids as string[],
    years: years.map((y) => {
      const { payerCode, fiscalYear } = (y ?? {}) as Record<string, unknown>;
      if (typeof payerCode !== 'string' || !Number.isInteger(fiscalYear)) throw new AppError(400, 'ข้อมูลไม่ถูกต้อง');
      return { payerCode: payerCode.trim().toUpperCase(), fiscalYear: fiscalYear as number };
    }),
  };
}

export class PaymentService {
  private store: Store;
  private cfg: Config;
  private line: LineClient;
  constructor(store: Store, cfg: Config, line: LineClient) {
    this.store = store;
    this.cfg = cfg;
    this.line = line;
  }

  // ---------- บัญชีที่ผูกกับ LINE ----------
  async accountsFor(lineUserId: string) {
    const k = this.cfg.dataKey;
    const linked = await this.store.listLinkedPayers(lineUserId);
    const accounts = await Promise.all(
      linked.map(async ({ payer, label }) => ({
        code: payer.code,
        label,
        category: payer.category,
        rateSatang: payer.rateSatang,
        nameMasked: maskName(decrypt(payer.nameEnc, k)),
        addressMasked: maskAddress(decrypt(payer.addressEnc, k)),
        invoices: (await this.store.listInvoices(payer.id)).map(publicInvoice),
      })),
    );
    return { accounts, currentFiscalYear: fiscalYearBE(new Date().toISOString()) };
  }

  async link(lineUserId: string, payerCode: string, invoiceNo: string, label: string, consent: boolean) {
    if (!consent) throw new AppError(400, 'ต้องยินยอมนโยบายความเป็นส่วนตัว');
    const code = payerCode.trim().toUpperCase();
    // ยืนยันด้วยเลขใบแจ้งหนี้ (สุ่ม เดาไม่ได้) — ผูกบ้านคนอื่นได้เมื่อมีใบแจ้งหนี้ของบ้านนั้น
    const inv = await this.store.findInvoiceByRefs(code, invoiceNo.trim().toUpperCase());
    if (!inv) throw new AppError(404, 'รหัสผู้ชำระหรือเลขที่ใบแจ้งหนี้ไม่ถูกต้อง');
    const linked = await this.store.listLinkedPayers(lineUserId);
    if (!linked.some((l) => l.payer.id === inv.payerId) && linked.length >= MAX_LINKS)
      throw new AppError(409, `ผูกได้สูงสุด ${MAX_LINKS} บัญชี`);
    const clean = label.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30) || `บัญชี ${code}`;
    await this.store.linkLine(lineUserId, inv.payerId, clean, CONSENT_VERSION);
    await this.store.audit(`line:${lineUserId}`, 'LINK', code, { consent: CONSENT_VERSION });
    return this.accountsFor(lineUserId);
  }

  async unlink(lineUserId: string, payerCode: string) {
    const payer = await this.store.findPayerByCode(payerCode.trim().toUpperCase());
    if (payer) {
      await this.store.unlinkLine(lineUserId, payer.id);
      await this.store.audit(`line:${lineUserId}`, 'UNLINK', payer.code);
    }
  }

  // ---------- คำนวณยอด / สร้างคำสั่งชำระ ----------
  /** allowed = null หมายถึงเจ้าหน้าที่ (เลือกได้ทุกบัญชี) */
  private async resolve(sel: Selection, allowed: Map<string, string> | null) {
    const current = fiscalYearBE(new Date().toISOString());
    const ids = new Set(sel.invoiceIds);
    const payers = new Map<string, Payer>();

    for (const y of sel.years) {
      const payer = await this.store.findPayerByCode(y.payerCode);
      if (!payer || (allowed && !allowed.has(payer.id))) throw new AppError(404, 'ไม่พบบัญชีผู้ชำระ');
      if (y.fiscalYear < current || y.fiscalYear > current + 1) throw new AppError(400, 'เลือกได้เฉพาะปีงบประมาณปัจจุบันหรือปีถัดไป');
      if (payer.rateSatang <= 0) throw new AppError(400, `บัญชี ${payer.code} ยังไม่กำหนดอัตราค่าธรรมเนียม`);
      const periods = fiscalYearPeriods(y.fiscalYear);
      await this.store.ensureInvoices(
        periods.map((period) => ({
          payerId: payer.id,
          period,
          amountSatang: payer.rateSatang,
          dueDate: dueDateOf(period),
          invoiceNo: period.replace('-', '').slice(2) + randomRef(8),
        })),
      );
      for (const i of await this.store.listInvoices(payer.id))
        if (i.status === 'UNPAID' && periods.includes(i.period)) ids.add(i.id);
    }

    const invoices = await this.store.getInvoices([...ids]);
    if (invoices.length !== ids.size) throw new AppError(404, 'ไม่พบใบแจ้งหนี้บางรายการ');
    if (!invoices.length) throw new AppError(400, 'กรุณาเลือกรายการที่ต้องการชำระ');
    const items: QuoteItem[] = [];
    for (const i of invoices) {
      if (allowed && !allowed.has(i.payerId)) throw new AppError(404, 'ไม่พบใบแจ้งหนี้');
      if (i.status !== 'UNPAID') throw new AppError(409, 'มีงวดที่ชำระแล้วหรือถูกยกเลิก กรุณาโหลดใหม่');
      let p = payers.get(i.payerId);
      if (!p) {
        p = (await this.store.findPayerById(i.payerId))!;
        payers.set(p.id, p);
      }
      items.push({
        invoiceId: i.id,
        payerId: i.payerId,
        payerCode: p.code,
        label: allowed?.get(i.payerId),
        period: i.period,
        amountSatang: i.amountSatang,
      });
    }
    items.sort((a, b) => a.payerCode.localeCompare(b.payerCode) || a.period.localeCompare(b.period));
    return { items, amountSatang: items.reduce((s, i) => s + i.amountSatang, 0) };
  }

  private async lineScope(lineUserId: string) {
    const linked = await this.store.listLinkedPayers(lineUserId);
    return new Map(linked.map((l) => [l.payer.id, l.label]));
  }

  async quoteForLine(lineUserId: string, sel: Selection) {
    const q = await this.resolve(sel, await this.lineScope(lineUserId));
    return { amountSatang: q.amountSatang, items: q.items.map(publicItem) };
  }

  async createQrOrder(lineUserId: string, sel: Selection) {
    const q = await this.resolve(sel, await this.lineScope(lineUserId));
    const order = await this.store.createOrder({
      orderNo: 'Q' + randomRef(11),
      createdBy: `line:${lineUserId}`,
      items: q.items.map((i) => ({ invoiceId: i.invoiceId, amountSatang: i.amountSatang })),
    });
    const payload = buildBillPaymentPayload({
      billerId: this.cfg.billerId,
      ref1: order.orderNo,
      amountSatang: order.amountSatang,
    });
    await this.store.audit(`line:${lineUserId}`, 'CREATE_ORDER', order.orderNo, { n: q.items.length });
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
    const o = await this.store.findOrderByNo(orderNo);
    if (!o || o.createdBy !== `line:${lineUserId}`) throw new AppError(404, 'ไม่พบรายการ');
    return { orderNo: o.orderNo, status: o.status, amountSatang: o.amountSatang };
  }

  async receiptsFor(lineUserId: string) {
    const scope = await this.lineScope(lineUserId);
    const codes = new Map<string, string>();
    for (const l of await this.store.listLinkedPayers(lineUserId)) codes.set(l.payer.id, l.payer.code);
    const list = await this.store.listReceipts([...scope.keys()]);
    return {
      receipts: list.map((r) => ({
        receiptNo: r.receiptNo,
        payerCode: codes.get(r.payerId) ?? '-',
        label: scope.get(r.payerId) ?? '',
        amountSatang: r.amountSatang,
        paidAt: r.paidAt,
        method: r.method,
        periods: r.items.map((i) => i.period),
        verifyUrl: this.verifyUrl(r.receiptNo),
      })),
    };
  }

  // ---------- ธนาคาร ----------
  async handleBankPayment(p: BankPayment) {
    if (p.billerId !== this.cfg.billerId) throw new AppError(400, 'unknown biller');
    const order = await this.store.findOrderByNo(p.ref1);
    if (!order) {
      await this.store.audit('bank', 'UNMATCHED_PAYMENT', p.txnId, p);
      return { kind: 'NOT_FOUND' as const };
    }
    const res = await this.store.recordPayment({
      orderId: order.id,
      method: p.channel,
      amountSatang: p.amountSatang,
      bankTxnId: p.txnId,
      staffId: null,
      paidAt: p.paidAt,
      raw: p,
    });
    if (res.kind === 'PAID') await this.notify(res.receipts);
    else if (res.kind !== 'DUPLICATE') await this.store.audit('bank', `PAYMENT_${res.kind}`, p.txnId, p); // ให้เจ้าหน้าที่ตรวจ/คืนเงิน
    return res;
  }

  // ---------- เจ้าหน้าที่ ----------
  async staffLookup(staff: Staff, code: string) {
    const payer = await this.store.findPayerByCode(code.trim().toUpperCase());
    if (!payer) throw new AppError(404, 'ไม่พบผู้ชำระ');
    await this.store.audit(`staff:${staff.id}`, 'VIEW_PAYER', payer.code);
    const k = this.cfg.dataKey;
    return {
      payer: {
        code: payer.code,
        name: decrypt(payer.nameEnc, k),
        address: decrypt(payer.addressEnc, k),
        category: payer.category,
        rateSatang: payer.rateSatang,
      },
      invoices: (await this.store.listInvoices(payer.id)).map(publicInvoice),
      currentFiscalYear: fiscalYearBE(new Date().toISOString()),
    };
  }

  async staffQuote(_staff: Staff, sel: Selection) {
    const q = await this.resolve(sel, null);
    return { amountSatang: q.amountSatang, items: q.items.map(publicItem) };
  }

  async counterPay(staff: Staff, sel: Selection, receivedSatang: number) {
    if (staff.role !== 'CASHIER' && staff.role !== 'ADMIN') throw new AppError(403, 'ไม่มีสิทธิ์รับชำระ');
    const q = await this.resolve(sel, null);
    if (!Number.isSafeInteger(receivedSatang) || receivedSatang < q.amountSatang)
      throw new AppError(400, 'จำนวนเงินที่รับไม่พอ');
    const order = await this.store.createOrder({
      orderNo: 'C' + randomRef(11),
      createdBy: `staff:${staff.id}`,
      items: q.items.map((i) => ({ invoiceId: i.invoiceId, amountSatang: i.amountSatang })),
    });
    const res = await this.store.recordPayment({
      orderId: order.id,
      method: 'CASH',
      amountSatang: order.amountSatang,
      bankTxnId: null,
      staffId: staff.id,
      paidAt: new Date().toISOString(),
    });
    if (res.kind !== 'PAID') throw new AppError(409, 'มีงวดที่ชำระแล้ว กรุณาค้นหาใหม่');
    await this.store.audit(`staff:${staff.id}`, 'CASH_PAYMENT', order.orderNo, { receipts: res.receipts.map((r) => r.receiptNo) });
    const lineNotified = await this.notify(res.receipts);
    const codes = new Map(q.items.map((i) => [i.payerId, i.payerCode]));
    return {
      receipts: res.receipts.map((r) => ({
        receiptNo: r.receiptNo,
        payerCode: codes.get(r.payerId) ?? '-',
        amountSatang: r.amountSatang,
        periods: r.items.map((i) => i.period),
        verifyUrl: this.verifyUrl(r.receiptNo),
      })),
      amountSatang: order.amountSatang,
      changeSatang: receivedSatang - order.amountSatang,
      lineNotified,
    };
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
    const r = await this.store.getReceipt(no);
    if (!r) return null;
    const payer = await this.store.findPayerById(r.payerId);
    return { ...r, payerCode: payer?.code ?? '-', periods: periodsSummary(r.items.map((i) => i.period)) };
  }

  /** ส่งใบเสร็จเข้า LINE ทุกคนที่ผูกกับบัญชีนั้น — ล้มเหลวไม่กระทบการชำระ */
  private async notify(receipts: Receipt[]): Promise<boolean> {
    const perUser = new Map<string, unknown[]>();
    for (const r of receipts) {
      const payer = await this.store.findPayerById(r.payerId);
      const msg = receiptFlex({
        municipality: this.cfg.municipalityName,
        receiptNo: r.receiptNo,
        payerCode: payer?.code ?? '-',
        address: payer ? maskAddress(decrypt(payer.addressEnc, this.cfg.dataKey)) : '-',
        periods: periodsSummary(r.items.map((i) => i.period)),
        amountSatang: r.amountSatang,
        method: r.method,
        paidAt: r.paidAt,
        verifyUrl: this.verifyUrl(r.receiptNo),
      });
      for (const u of await this.store.lineUsersOfPayer(r.payerId)) perUser.set(u, [...(perUser.get(u) ?? []), msg]);
    }
    const sends: Promise<void>[] = [];
    for (const [u, msgs] of perUser)
      for (let i = 0; i < msgs.length; i += 5) sends.push(this.line.push(u, msgs.slice(i, i + 5))); // LINE จำกัด 5 ข้อความ/ครั้ง
    const results = await Promise.allSettled(sends);
    results.forEach((x) => x.status === 'rejected' && console.error('LINE push failed', x.reason));
    return results.some((x) => x.status === 'fulfilled');
  }
}
