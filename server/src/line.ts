import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.ts';
import { satangToBaht } from './promptpay.ts';

export function verifyLineSignature(rawBody: string, signature: string | undefined, channelSecret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return safeEqual(expected, signature);
}

/** ตรวจ LIFF ID token ฝั่ง server — ไม่เชื่อ userId ที่ client ส่งมาเอง */
export type IdTokenVerifier = (idToken: string) => Promise<string | null>;

export function lineIdTokenVerifier(loginChannelId: string): IdTokenVerifier {
  return async (idToken) => {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      body: new URLSearchParams({ id_token: idToken, client_id: loginChannelId }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { sub?: string };
    return j.sub ?? null;
  };
}

export interface LineClient {
  push(to: string, messages: unknown[]): Promise<void>;
  reply(replyToken: string, messages: unknown[]): Promise<void>;
}

export function lineClient(accessToken: string): LineClient {
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LINE ${path} ${res.status}`);
  };
  return {
    push: (to, messages) => call('push', { to, messages }),
    reply: (replyToken, messages) => call('reply', { replyToken, messages }),
  };
}

const METHOD_TH = { QR: 'QR พร้อมเพย์', BANK: 'โอนผ่านธนาคาร', CASH: 'เงินสด (เคาน์เตอร์)' } as const;

export interface ReceiptView {
  municipality: string;
  receiptNo: string;
  payerCode: string;
  period: string;
  amountSatang: number;
  method: keyof typeof METHOD_TH;
  paidAt: string;
  verifyUrl: string;
}

const row = (label: string, value: string) => ({
  type: 'box',
  layout: 'baseline',
  contents: [
    { type: 'text', text: label, size: 'sm', color: '#888888', flex: 3 },
    { type: 'text', text: value, size: 'sm', wrap: true, flex: 5 },
  ],
});

/** Flex Message ใบเสร็จ — ไม่มีชื่อ/ที่อยู่เต็ม (PDPA) */
export function receiptFlex(r: ReceiptView) {
  const date = new Date(r.paidAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  return {
    type: 'flex',
    altText: `ใบเสร็จค่าขยะ ${r.receiptNo} ${satangToBaht(r.amountSatang)} บาท`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1B7F3B',
        contents: [
          { type: 'text', text: 'ใบเสร็จรับเงิน (ดิจิทัล)', color: '#FFFFFF', weight: 'bold' },
          { type: 'text', text: r.municipality, color: '#FFFFFF', size: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `${satangToBaht(r.amountSatang)} บาท`, size: 'xxl', weight: 'bold', color: '#1B7F3B' },
          row('เลขที่', r.receiptNo),
          row('รหัสผู้ชำระ', r.payerCode),
          row('งวด', r.period),
          row('ช่องทาง', METHOD_TH[r.method]),
          row('วันที่', date),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'button', style: 'link', action: { type: 'uri', label: 'ดู/ตรวจสอบใบเสร็จ', uri: r.verifyUrl } }],
      },
    },
  };
}
