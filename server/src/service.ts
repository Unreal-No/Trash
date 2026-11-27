import QRCode from 'qrcode';
import { decrypt, hmacHex, maskAddress, maskName, safeEqual } from './crypto.ts';
import { buildBillPaymentPayload } from './promptpay.ts';
import { receiptFlex, type LineClient } from './line.ts';
import type { BankPayment } from './bank/adapter.ts';
import type { Config } from './config.ts';
import type { Invoice, Receipt, Staff, Store } from './store/types.ts';

export const CONSENT_VERSION = '1.0';

export class AppError extends Error {
  status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

const OPEN: Invoice['status'][] = ['UNPAID', 'PENDING'];
const publicInvoice = (i: Invoice) => ({
  id: i.id,
  invoiceNo: i.invoiceNo,
  period: i.period,
  amountSatang: i.amountSatang,
  status: i.status,
  dueDate: i.dueDate,
});

export class PaymentService {
  private store: Store;
  private cfg: Config;
  private line: LineClient;
  constructor(store: Store, cfg: Config, line: LineClient) {
    this.store = store;
    this.cfg = cfg;
    this.line = line;
  }

  // ---------- ประชาชน (LIFF) ----------
  async link(lineUserId: string, payerCode: string, invoiceNo: string, consent: boolean) {
    if (!consent) throw new AppError(400, 'ต้องยินยอมนโยบายความเป็นส่วนตัว');
    const code = payerCode.trim().toUpperCase();
    const inv = await this.store.findInvoiceByRefs(code, invoiceNo.trim().toUpperCase());
    if (!inv) throw new AppError(404, 'รหัสผู้ชำระหรือเลขที่ใบแจ้งหนี้ไม่ถูกต้อง');
    await this.store.linkLine(lineUserId, inv.payerId, CONSENT_VERSION);
    await this.store.audit(`line:${lineUserId}`, 'LINK', code, { consent: CONSENT_VERSION });
    return this.invoicesFor(lineUserId);
  }

  async unlink(lineUserId: string) {
    await this.store.unlinkLine(lineUserId);
    await this.store.audit(`line:${lineUserId}`, 'UNLINK', lineUserId);
  }

  async invoicesFor(lineUserId: string) {
    const payer = await this.store.findPayerByLineUser(lineUserId);
    if (!payer) throw new AppError(404, 'NOT_LINKED');
    const k = this.cfg.dataKey;
    return {
      payer: {
        code: payer.code,
        nameMasked: maskName(decrypt(payer.nameEnc, k)),
        addressMasked: maskAddress(decrypt(payer.addressEnc, k)),
      },
      invoices: (await this.store.listInvoices(payer.id)).map(publicInvoice),
    };
  }

  async receiptsFor(lineUserId: string) {
    const payer = await this.store.findPayerByLineUser(lineUserId);
    if (!payer) throw new AppError(404, 'NOT_LINKED');
    const list = await this.store.listReceipts(payer.id);
    return {
      receipts: list.map((r) => ({
        receiptNo: r.receiptNo,
        amountSatang: r.amountSatang,
        paidAt: r.paidAt,
        method: r.method,
        verifyUrl: this.verifyUrl(r.receiptNo),
      })),
    };
  }

  async createQr(lineUserId: string, invoiceId: string) {
    const payer = await this.store.findPayerByLineUser(lineUserId);
    const inv = await this.store.getInvoice(invoiceId);
    if (!payer || !inv || inv.payerId !== payer.id) throw new AppError(404, 'ไม่พบใบแจ้งหนี้');
    if (!OPEN.includes(inv.status)) throw new AppError(409, 'ใบแจ้งหนี้นี้ไม่อยู่ในสถานะรอชำระ');
    const payload = buildBillPaymentPayload({
      billerId: this.cfg.billerId,
      ref1: payer.code,
      ref2: inv.invoiceNo,
      amountSatang: inv.amountSatang,
    });
    await this.store.setInvoiceStatus(inv.id, ['UNPAID'], 'PENDING');
    return {
      payload,
      qrDataUrl: await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
      amountSatang: inv.amountSatang,
      expiresAt: new Date(Date.now() + this.cfg.qrTtlMinutes * 60_000).toISOString(),
    };
  }

  // ---------- ธนาคาร ----------
  async handleBankPayment(p: BankPayment) {
    if (p.billerId !== this.cfg.billerId) throw new AppError(400, 'unknown biller');
    const inv = await this.store.findInvoiceByRefs(p.ref1, p.ref2);
    if (!inv) {
      await this.store.audit('bank', 'UNMATCHED_PAYMENT', p.txnId, p);
      return { kind: 'NOT_FOUND' as const };
    }
    const res = await this.store.recordPayment({
      invoiceId: inv.id,
      method: p.channel,
      amountSatang: p.amountSatang,
      bankTxnId: p.txnId,
      staffId: null,
      paidAt: p.paidAt,
      raw: p,
    });
    if (res.kind === 'PAID') await this.notify(res.receipt);
    else if (res.kind !== 'DUPLICATE') await this.store.audit('bank', `PAYMENT_${res.kind}`, p.txnId, p);
    return res;
  }

  // ---------- เจ้าหน้าที่ ----------
  async staffLookup(staff: Staff, code: string) {
    const payer = await this.store.findPayerByCode(code.trim().toUpperCase());
    if (!payer) throw new AppError(404, 'ไม่พบผู้ชำระ');
    await this.store.audit(`staff:${staff.id}`, 'VIEW_PAYER', payer.code);
    const k = this.cfg.dataKey;
    return {
      payer: { code: payer.code, name: decrypt(payer.nameEnc, k), address: decrypt(payer.addressEnc, k) },
      invoices: (await this.store.listInvoices(payer.id)).map(publicInvoice),
    };
  }

  async counterPay(staff: Staff, invoiceId: string, receivedSatang: number) {
    if (staff.role !== 'CASHIER' && staff.role !== 'ADMIN') throw new AppError(403, 'ไม่มีสิทธิ์รับชำระ');
    const inv = await this.store.getInvoice(invoiceId);
    if (!inv) throw new AppError(404, 'ไม่พบใบแจ้งหนี้');
    if (!Number.isSafeInteger(receivedSatang) || receivedSatang < inv.amountSatang)
      throw new AppError(400, 'จำนวนเงินที่รับไม่พอ');
    const res = await this.store.recordPayment({
      invoiceId,
      method: 'CASH',
      amountSatang: inv.amountSatang,
      bankTxnId: null,
      staffId: staff.id,
      paidAt: new Date().toISOString(),
    });
    if (res.kind !== 'PAID') throw new AppError(409, 'ใบแจ้งหนี้นี้ชำระแล้วหรือถูกยกเลิก');
    await this.store.audit(`staff:${staff.id}`, 'CASH_PAYMENT', res.receipt.receiptNo);
    const lineNotified = await this.notify(res.receipt);
    return {
      receipt: {
        receiptNo: res.receipt.receiptNo,
        amountSatang: res.receipt.amountSatang,
        changeSatang: receivedSatang - inv.amountSatang,
        verifyUrl: this.verifyUrl(res.receipt.receiptNo),
      },
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
    const [payer, inv] = await Promise.all([this.store.findPayerById(r.payerId), this.store.getInvoice(r.invoiceId)]);
    return { ...r, payerCode: payer?.code ?? '-', period: inv?.period ?? '-' };
  }

  /** ส่งใบเสร็จเข้า LINE — ล้มเหลวไม่กระทบการชำระ (ดูย้อนหลังได้ในเมนูใบเสร็จ) */
  private async notify(r: Receipt): Promise<boolean> {
    const users = await this.store.lineUsersOfPayer(r.payerId);
    if (!users.length) return false;
    const [payer, inv] = await Promise.all([this.store.findPayerById(r.payerId), this.store.getInvoice(r.invoiceId)]);
    const msg = receiptFlex({
      municipality: this.cfg.municipalityName,
      receiptNo: r.receiptNo,
      payerCode: payer?.code ?? '-',
      period: inv?.period ?? '-',
      amountSatang: r.amountSatang,
      method: r.method,
      paidAt: r.paidAt,
      verifyUrl: this.verifyUrl(r.receiptNo),
    });
    const results = await Promise.allSettled(users.map((u) => this.line.push(u, [msg])));
    results.forEach((x) => x.status === 'rejected' && console.error('LINE push failed', r.receiptNo, x.reason));
    return results.some((x) => x.status === 'fulfilled');
  }
}
