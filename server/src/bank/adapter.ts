// Adapter ธนาคาร — รูปแบบกลาง (generic) ระหว่างรอ spec จริงจากธนาคาร (KTB/KBank/SCB)
// เปลี่ยนธนาคาร: แก้ parse/verify ในไฟล์นี้ไฟล์เดียว
import { bahtToSatang } from '../promptpay.ts';
import { hmacHex, safeEqual } from '../crypto.ts';

export interface BankPayment {
  txnId: string;
  billerId: string;
  ref1: string;
  ref2: string;
  amountSatang: number;
  paidAt: string; // ISO
  channel: 'QR' | 'BANK';
}

export class BankAuthError extends Error {}

const MAX_SKEW_MS = 5 * 60_000;

/**
 * ตรวจลายเซ็น: x-bank-signature = hex(HMAC-SHA256(secret, `${x-bank-timestamp}.${rawBody}`))
 * กัน replay ด้วย timestamp ±5 นาที
 */
export function verifyBankRequest(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  now = Date.now(),
): void {
  const ts = String(headers['x-bank-timestamp'] ?? '');
  const sig = String(headers['x-bank-signature'] ?? '');
  if (!/^\d+$/.test(ts) || !sig) throw new BankAuthError('missing signature');
  if (Math.abs(now - Number(ts) * 1000) > MAX_SKEW_MS) throw new BankAuthError('stale timestamp');
  if (!safeEqual(sig.toLowerCase(), hmacHex(secret, `${ts}.${rawBody}`))) throw new BankAuthError('bad signature');
}

export function parseBankPayment(body: unknown): BankPayment {
  const b = body as Record<string, unknown>;
  const s = (k: string) => {
    const v = b?.[k];
    if (typeof v !== 'string' || !v) throw new Error(`invalid field ${k}`);
    return v;
  };
  const paidAt = new Date(s('paidAt'));
  if (Number.isNaN(paidAt.getTime())) throw new Error('invalid paidAt');
  return {
    txnId: s('txnId'),
    billerId: s('billerId'),
    ref1: s('ref1').toUpperCase(),
    ref2: s('ref2').toUpperCase(),
    amountSatang: bahtToSatang(s('amount')),
    paidAt: paidAt.toISOString(),
    channel: b.channel === 'BANK' ? 'BANK' : 'QR',
  };
}
