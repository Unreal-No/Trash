// Thai QR Payment (EMVCo) — Bill Payment (Tag 30) ทำให้ธนาคารส่ง callback พร้อม Ref1/Ref2 ได้
const BILL_PAYMENT_AID = 'A000000677010112';

function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, '0') + value;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) ตามมาตรฐาน EMVCo */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(data, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const REF_RE = /^[A-Z0-9]{1,20}$/;

export interface BillPaymentInput {
  billerId: string; // เลขผู้เสียภาษี 13 หลัก + suffix 2 หลัก (ได้จากธนาคาร)
  ref1: string;
  ref2?: string;
  amountSatang: number;
  merchantName?: string;
}

export function satangToBaht(satang: number): string {
  if (!Number.isSafeInteger(satang) || satang < 0) throw new Error('invalid amount');
  return `${Math.trunc(satang / 100)}.${String(satang % 100).padStart(2, '0')}`;
}

export function buildBillPaymentPayload(input: BillPaymentInput): string {
  if (!/^\d{15}$/.test(input.billerId)) throw new Error('billerId must be 15 digits');
  if (!REF_RE.test(input.ref1)) throw new Error('ref1 must be A-Z0-9, max 20');
  if (input.ref2 !== undefined && !REF_RE.test(input.ref2)) throw new Error('ref2 must be A-Z0-9, max 20');
  if (input.amountSatang <= 0) throw new Error('amount must be > 0');

  const merchant =
    tlv('00', BILL_PAYMENT_AID) +
    tlv('01', input.billerId) +
    tlv('02', input.ref1) +
    (input.ref2 ? tlv('03', input.ref2) : '');

  let payload =
    tlv('00', '01') +
    tlv('01', '12') + // dynamic QR (ใช้ครั้งเดียว/ระบุยอด)
    tlv('30', merchant) +
    tlv('53', '764') + // THB
    tlv('54', satangToBaht(input.amountSatang)) +
    tlv('58', 'TH') +
    (input.merchantName ? tlv('59', input.merchantName.slice(0, 25)) : '');
  payload += '6304';
  return payload + crc16(payload);
}

/** แปลง "123.45" → 12345 สตางค์ โดยไม่ผ่าน float */
export function bahtToSatang(amount: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error('invalid amount format');
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
