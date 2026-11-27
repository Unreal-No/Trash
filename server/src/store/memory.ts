// ใช้สำหรับ dev/test เท่านั้น (production ใช้ pg.ts)
import { randomUUID } from 'node:crypto';
import { fiscalYearBE, formatReceiptNo } from '../util.ts';
import type { Invoice, InvoiceStatus, Payer, PaymentInput, PaymentResult, Receipt, Staff, Store } from './types.ts';

export class MemoryStore implements Store {
  payers = new Map<string, Payer>();
  invoices = new Map<string, Invoice>();
  receipts = new Map<string, Receipt>();
  links = new Map<string, { payerId: string; consentVersion: string }>();
  payments = new Map<string, string | null>(); // bankTxnId -> receiptNo
  staff = new Map<string, Staff>(); // tokenHash -> staff
  audits: { actor: string; action: string; target: string; meta?: unknown }[] = [];
  private seq = 0;

  addPayer(p: Omit<Payer, 'id'>): Payer {
    const payer = { id: randomUUID(), ...p };
    this.payers.set(payer.id, payer);
    return payer;
  }
  addInvoice(i: Omit<Invoice, 'id' | 'status'> & { status?: InvoiceStatus }): Invoice {
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
  async findPayerByLineUser(u: string) {
    const l = this.links.get(u);
    return l ? (this.payers.get(l.payerId) ?? null) : null;
  }
  async linkLine(u: string, payerId: string, consentVersion: string) {
    this.links.set(u, { payerId, consentVersion });
  }
  async unlinkLine(u: string) {
    this.links.delete(u);
  }
  async lineUsersOfPayer(payerId: string) {
    return [...this.links].filter(([, l]) => l.payerId === payerId).map(([u]) => u);
  }
  async listInvoices(payerId: string) {
    return [...this.invoices.values()].filter((i) => i.payerId === payerId).sort((a, b) => a.period.localeCompare(b.period));
  }
  async getInvoice(id: string) {
    return this.invoices.get(id) ?? null;
  }
  async findInvoiceByRefs(code: string, no: string) {
    const p = await this.findPayerByCode(code);
    return [...this.invoices.values()].find((i) => i.payerId === p?.id && i.invoiceNo === no) ?? null;
  }
  async setInvoiceStatus(id: string, from: InvoiceStatus[], to: InvoiceStatus) {
    const i = this.invoices.get(id);
    if (!i || !from.includes(i.status)) return false;
    i.status = to;
    return true;
  }

  async recordPayment(p: PaymentInput): Promise<PaymentResult> {
    if (p.bankTxnId && this.payments.has(p.bankTxnId)) {
      const no = this.payments.get(p.bankTxnId);
      return { kind: 'DUPLICATE', receipt: no ? (this.receipts.get(no) ?? null) : null };
    }
    const inv = this.invoices.get(p.invoiceId);
    if (!inv) return { kind: 'NOT_FOUND' };
    if (inv.status === 'PAID') {
      if (p.bankTxnId) this.payments.set(p.bankTxnId, null);
      return { kind: 'ALREADY_PAID' };
    }
    if (inv.status === 'CANCELLED' || inv.amountSatang !== p.amountSatang) {
      if (p.bankTxnId) this.payments.set(p.bankTxnId, null);
      if (inv.status !== 'CANCELLED') inv.status = 'MISMATCH';
      return { kind: 'MISMATCH' };
    }
    inv.status = 'PAID';
    const receipt: Receipt = {
      receiptNo: formatReceiptNo(fiscalYearBE(p.paidAt), ++this.seq),
      invoiceId: inv.id,
      payerId: inv.payerId,
      amountSatang: p.amountSatang,
      method: p.method,
      paidAt: p.paidAt,
      staffId: p.staffId,
    };
    this.receipts.set(receipt.receiptNo, receipt);
    if (p.bankTxnId) this.payments.set(p.bankTxnId, receipt.receiptNo);
    return { kind: 'PAID', receipt };
  }
  async getReceipt(no: string) {
    return this.receipts.get(no) ?? null;
  }
  async listReceipts(payerId: string) {
    return [...this.receipts.values()].filter((r) => r.payerId === payerId).reverse();
  }
  async findStaffByTokenHash(h: string) {
    return this.staff.get(h) ?? null;
  }
  async audit(actor: string, action: string, target: string, meta?: unknown) {
    this.audits.push({ actor, action, target, meta });
  }
}
