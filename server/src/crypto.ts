import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM สำหรับข้อมูลส่วนบุคคล (PDPA) — รูปแบบ v1:iv:tag:ciphertext (base64url) */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(token: string, key: Buffer): string {
  const [v, iv, tag, ct] = token.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export function hmacHex(secret: string | Buffer, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------- การปิดบังข้อมูลเมื่อแสดงใน LINE ----------
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const chars = [...w];
      return chars.length <= 1 ? w : chars[0] + '*'.repeat(Math.min(chars.length - 1, 3));
    })
    .join(' ');
}

export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length < 4 ? '****' : `${d.slice(0, 2)}x-xxx-${d.slice(-4)}`;
}

/** แสดงเฉพาะบ้านเลขที่ ซ่อนส่วนที่เหลือ */
export function maskAddress(address: string): string {
  const first = address.trim().split(/\s+/)[0] ?? '';
  return `${first} ***`;
}
