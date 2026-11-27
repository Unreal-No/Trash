export type InvoiceStatus = 'UNPAID' | 'PENDING' | 'PAID' | 'MISMATCH' | 'CANCELLED';
export type PayMethod = 'QR' | 'BANK' | 'CASH';
export type StaffRole = 'ADMIN' | 'CASHIER' | 'VIEWER';

export interface Payer {
  id: string;
  code: string; // รหัสผู้ชำระ = Ref1
  nameEnc: string;
  addressEnc: string;
  phoneEnc: string | null;
}

export interface Invoice {
  id: string;
  invoiceNo: string; // = Ref2
  payerId: string;
  period: string; // เช่น 2569-11
  amountSatang: number;
  status: InvoiceStatus;
  dueDate: string;
}

export interface Receipt {
  receiptNo: string;
  invoiceId: string;
  payerId: string;
  amountSatang: number;
  method: PayMethod;
  paidAt: string;
  staffId: string | null;
}

export interface Staff {
  id: string;
  name: string;
  role: StaffRole;
}

export interface PaymentInput {
  invoiceId: string;
  method: PayMethod;
  amountSatang: number;
  bankTxnId: string | null; // unique — กัน callback ซ้ำ
  staffId: string | null;
  paidAt: string;
  raw?: unknown;
}

export type PaymentResult =
  | { kind: 'PAID'; receipt: Receipt }
  | { kind: 'DUPLICATE'; receipt: Receipt | null }
  | { kind: 'ALREADY_PAID' }
  | { kind: 'MISMATCH' }
  | { kind: 'NOT_FOUND' };

export interface Store {
  findPayerByCode(code: string): Promise<Payer | null>;
  findPayerById(id: string): Promise<Payer | null>;
  findPayerByLineUser(lineUserId: string): Promise<Payer | null>;
  linkLine(lineUserId: string, payerId: string, consentVersion: string): Promise<void>;
  unlinkLine(lineUserId: string): Promise<void>;
  lineUsersOfPayer(payerId: string): Promise<string[]>;

  listInvoices(payerId: string): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | null>;
  findInvoiceByRefs(payerCode: string, invoiceNo: string): Promise<Invoice | null>;
  setInvoiceStatus(id: string, from: InvoiceStatus[], to: InvoiceStatus): Promise<boolean>;

  /** atomic: บันทึก payment + ปิดใบแจ้งหนี้ + ออกเลขใบเสร็จ ใน transaction เดียว */
  recordPayment(p: PaymentInput): Promise<PaymentResult>;
  getReceipt(receiptNo: string): Promise<Receipt | null>;
  listReceipts(payerId: string): Promise<Receipt[]>;

  findStaffByTokenHash(hash: string): Promise<Staff | null>;
  audit(actor: string, action: string, target: string, meta?: unknown): Promise<void>;
}
