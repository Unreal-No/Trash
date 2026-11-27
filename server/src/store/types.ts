export type InvoiceStatus = 'UNPAID' | 'PAID' | 'CANCELLED';
export type PayMethod = 'QR' | 'BANK' | 'CASH';
export type StaffRole = 'ADMIN' | 'CASHIER' | 'VIEWER';
export type PayerCategory = 'RESIDENTIAL' | 'COMMERCIAL';
export type OrderStatus = 'OPEN' | 'PAID' | 'MISMATCH' | 'REFUND';

/** 1 บัญชีผู้ชำระ = 1 สถานที่จัดเก็บ (บ้าน/ร้านค้า) */
export interface Payer {
  id: string;
  code: string;
  nameEnc: string;
  addressEnc: string;
  phoneEnc: string | null;
  category: PayerCategory;
  rateSatang: number; // อัตรารายเดือน
}

export interface Invoice {
  id: string;
  invoiceNo: string; // เลขสุ่มพิมพ์บนใบแจ้งหนี้ ใช้ยืนยันตอนผูกบัญชี
  payerId: string;
  period: string; // 2569-11 (พ.ศ.)
  amountSatang: number;
  status: InvoiceStatus;
  dueDate: string;
}
export type NewInvoice = Omit<Invoice, 'id' | 'status'>;

export interface LinkedPayer {
  payer: Payer;
  label: string; // ชื่อที่ผู้ใช้ตั้ง เช่น บ้านแม่, ร้านค้า
}

/** คำสั่งชำระ: รวมหลายงวด/หลายบัญชี ใน QR เดียว (orderNo = Ref1) */
export interface Order {
  id: string;
  orderNo: string;
  createdBy: string; // line:<uid> | staff:<id>
  amountSatang: number;
  status: OrderStatus;
  items: { invoiceId: string; amountSatang: number }[];
}

export interface ReceiptItem {
  invoiceId: string;
  period: string;
  amountSatang: number;
}

/** ใบเสร็จออกแยกตามบัญชีผู้ชำระ (1 order อาจได้หลายใบ) */
export interface Receipt {
  receiptNo: string;
  payerId: string;
  orderId: string;
  amountSatang: number;
  method: PayMethod;
  paidAt: string;
  staffId: string | null;
  items: ReceiptItem[];
}

export interface Staff {
  id: string;
  name: string;
  role: StaffRole;
}

export interface PaymentInput {
  orderId: string;
  method: PayMethod;
  amountSatang: number;
  bankTxnId: string | null; // unique — กัน callback ซ้ำ
  staffId: string | null;
  paidAt: string;
  raw?: unknown;
}

export type PaymentResult =
  | { kind: 'PAID'; receipts: Receipt[] }
  | { kind: 'DUPLICATE' }
  | { kind: 'MISMATCH' } // ยอดไม่ตรง
  | { kind: 'REFUND' } // มีงวดที่ถูกชำระไปแล้ว → ต้องคืนเงิน
  | { kind: 'NOT_FOUND' };

export interface Store {
  findPayerByCode(code: string): Promise<Payer | null>;
  findPayerById(id: string): Promise<Payer | null>;
  listLinkedPayers(lineUserId: string): Promise<LinkedPayer[]>;
  linkLine(lineUserId: string, payerId: string, label: string, consentVersion: string): Promise<void>;
  unlinkLine(lineUserId: string, payerId: string): Promise<void>;
  lineUsersOfPayer(payerId: string): Promise<string[]>;

  listInvoices(payerId: string): Promise<Invoice[]>;
  getInvoices(ids: string[]): Promise<Invoice[]>;
  findInvoiceByRefs(payerCode: string, invoiceNo: string): Promise<Invoice | null>;
  /** สร้างใบแจ้งหนี้ที่ยังไม่มี (ข้ามงวดที่มีอยู่แล้ว) */
  ensureInvoices(list: NewInvoice[]): Promise<void>;

  createOrder(o: { orderNo: string; createdBy: string; items: { invoiceId: string; amountSatang: number }[] }): Promise<Order>;
  findOrderByNo(orderNo: string): Promise<Order | null>;

  /** atomic: บันทึก payment + ปิดใบแจ้งหนี้ทุกงวด + ออกใบเสร็จแยกตามบัญชี */
  recordPayment(p: PaymentInput): Promise<PaymentResult>;
  getReceipt(receiptNo: string): Promise<Receipt | null>;
  listReceipts(payerIds: string[]): Promise<Receipt[]>;

  findStaffByTokenHash(hash: string): Promise<Staff | null>;
  audit(actor: string, action: string, target: string, meta?: unknown): Promise<void>;
}
