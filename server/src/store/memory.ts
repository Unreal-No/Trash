// ใช้สำหรับ dev/test เท่านั้น (production ใช้ pg.ts)
import { randomUUID } from 'node:crypto';
import { fiscalYearBE, formatReceiptNo } from '../util.ts';
import type {
  Invoice, InvoiceStatus, LinkedPayer, NewInvoice, Order, Payer, PaymentInput, PaymentResult, Receipt, Staff, Store,
} from './types.ts';

export class MemoryStore implements Store {
  payers = new Map<string, Payer>();
  invoices = new Map<string, Invoice>();
  orders = new Map<string, Order>();
  receipts = new Map<string, Receipt>();
  links = new Map<string, { lineUserId: string; payerId: string; label: string; consentVersion: string }>();
  bankTxns = new Set<string>();
  staff = new Map<string, Staff>(); // tokenHash -> staff
  audits: { actor: string; action: string; target: string; meta?: unknown }[] = [];
  private seq = 0;

  addPayer(p: Omit<Payer, 'id'>): Payer {
    const payer = { id: randomUUID(), ...p };
    this.payers.set(payer.id, payer);
    return payer;
  }
  addInvoice(i: NewInvoice & { status?: InvoiceStatus }): Invoice {
    const inv: Invoice = { id: randomUUID(), status: 'UNPAID', ...i };
    this.invoices.set(inv.id, inv);
    return inv;
  }

  async findPayerByCode(code: string) {
    return [...this.payers.values()].find((p) => p.code === code) ?? null;
  }
  async findPayerById(id: string) {
    return this.payers.get(id) ?? null;
  }
  async listLinkedPayers(u: string): Promise<LinkedPayer[]> {
    return [...this.links.values()]
      .filter((l) => l.lineUserId === u)
      .map((l) => ({ payer: this.payers.get(l.payerId)!, label: l.label }));
  }
  async linkLine(u: string, payerId: string, label: string, consentVersion: string) {
    this.links.set(`${u}|${payerId}`, { lineUserId: u, payerId, label, consentVersion });
  }
  async unlinkLine(u: string, payerId: string) {
    this.links.delete(`${u}|${payerId}`);
  }
  async lineUsersOfPayer(payerId: string) {
    return [...this.links.values()].filter((l) => l.payerId === payerId).map((l) => l.lineUserId);
  }

  async listInvoices(payerId: string) {
    return [...this.invoices.values()].filter((i) => i.payerId === payerId).sort((a, b) => a.period.localeCompare(b.period));
  }
  async getInvoices(ids: string[]) {
    return ids.map((id) => this.invoices.get(id)).filter((x): x is Invoice => !!x);
  }
  async findInvoiceByRefs(code: string, no: string) {
    const p = await this.findPayerByCode(code);
    return [...this.invoices.values()].find((i) => i.payerId === p?.id && i.invoiceNo === no) ?? null;
  }
  async ensureInvoices(list: NewInvoice[]) {
    for (const n of list) {
      const exists = [...this.invoices.values()].some((i) => i.payerId === n.payerId && i.period === n.period);
      if (!exists) this.addInvoice(n);
    }
  }

  async createOrder(o: { orderNo: string; createdBy: string; items: { invoiceId: string; amountSatang: number }[] }) {
    const order: Order = {
      id: randomUUID(),
      orderNo: o.orderNo,
      createdBy: o.createdBy,
      items: o.items,
      amountSatang: o.items.reduce((s, i) => s + i.amountSatang, 0),
      status: 'OPEN',
    };
    this.orders.set(order.id, order);
    return order;
  }
  async findOrderByNo(no: string) {
    return [...this.orders.values()].find((o) => o.orderNo === no) ?? null;
  }

  async recordPayment(p: PaymentInput): Promise<PaymentResult> {
    if (p.bankTxnId) {
      if (this.bankTxns.has(p.bankTxnId)) return { kind: 'DUPLICATE' };
      this.bankTxns.add(p.bankTxnId);
    }
    const order = this.orders.get(p.orderId);
    if (!order) return { kind: 'NOT_FOUND' };
    const invs = order.items.map((it) => this.invoices.get(it.invoiceId)!);
    if (order.status === 'PAID' || invs.some((i) => i.status !== 'UNPAID')) {
      if (order.status !== 'PAID') order.status = 'REFUND';
      return { kind: 'REFUND' };
    }
    if (p.amountSatang !== order.amountSatang) {
      order.status = 'MISMATCH';
      return { kind: 'MISMATCH' };
    }
    order.status = 'PAID';
    const byPayer = new Map<string, Invoice[]>();
    for (const i of invs) byPayer.set(i.payerId, [...(byPayer.get(i.payerId) ?? []), i]);
    const receipts: Receipt[] = [];
    for (const [payerId, list] of byPayer) {
      list.forEach((i) => (i.status = 'PAID'));
      const r: Receipt = {
        receiptNo: formatReceiptNo(fiscalYearBE(p.paidAt), ++this.seq),
        payerId,
        orderId: order.id,
        amountSatang: list.reduce((s, i) => s + i.amountSatang, 0),
        method: p.method,
        paidAt: p.paidAt,
        staffId: p.staffId,
        items: list.map((i) => ({ invoiceId: i.id, period: i.period, amountSatang: i.amountSatang })),
      };
      this.receipts.set(r.receiptNo, r);
      receipts.push(r);
    }
    return { kind: 'PAID', receipts };
  }
  async getReceipt(no: string) {
    return this.receipts.get(no) ?? null;
  }
  async listReceipts(payerIds: string[]) {
    return [...this.receipts.values()].filter((r) => payerIds.includes(r.payerId)).reverse();
  }
  async findStaffByTokenHash(h: string) {
    return this.staff.get(h) ?? null;
  }
  async audit(actor: string, action: string, target: string, meta?: unknown) {
    this.audits.push({ actor, action, target, meta });
  }
}
