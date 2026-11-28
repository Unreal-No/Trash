import { randomBytes } from 'node:crypto';

const pad = (n: number) => String(n).padStart(2, '0');

/** ปีงบประมาณ พ.ศ. (เริ่ม 1 ต.ค.) ตามเวลาไทย */
export function fiscalYearBE(iso: string): number {
  const t = new Date(new Date(iso).getTime() + 7 * 3600_000); // UTC+7
  const y = t.getUTCFullYear() + 543;
  return t.getUTCMonth() >= 9 ? y + 1 : y;
}

/** งวดทั้ง 12 เดือนของปีงบประมาณ เช่น 2570 → 2569-10 … 2570-09 */
export function fiscalYearPeriods(fy: number): string[] {
  return [10, 11, 12].map((m) => `${fy - 1}-${pad(m)}`).concat([1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => `${fy}-${pad(m)}`));
}

/** วันครบกำหนด = 15 ของเดือนถัดไป (ค.ศ.) */
export function dueDateOf(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y - 543 + 1}-01-15` : `${y - 543}-${pad(m + 1)}-15`;
}

export function formatReceiptNo(yearBE: number, seq: number): string {
  return `R${yearBE}-${String(seq).padStart(6, '0')}`;
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ไม่มี 0/O/1/I กันอ่านผิด
/** รหัสสุ่มเดาไม่ได้ (ใช้เป็น Ref/เลขใบแจ้งหนี้) */
export function randomRef(len: number): string {
  return [...randomBytes(len)].map((b) => ALPHA[b % 32]).join('');
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export function periodTh(period: string): string {
  const [y, m] = period.split('-');
  return `${TH_MONTHS[Number(m) - 1] ?? m} ${y}`;
}
export function periodsSummary(periods: string[]): string {
  const s = [...periods].sort();
  if (s.length === 0) return '-';
  if (s.length === 1) return periodTh(s[0]!);
  return `${periodTh(s[0]!)} – ${periodTh(s[s.length - 1]!)} (${s.length} งวด)`;
}

/** งวดปัจจุบัน (พ.ศ.) ตามเวลาไทย เช่น 2569-11 */
export function currentPeriod(now = new Date()): string {
  const t = new Date(now.getTime() + 7 * 3600_000);
  return `${t.getUTCFullYear() + 543}-${pad(t.getUTCMonth() + 1)}`;
}
/** วันที่วันนี้ (ค.ศ.) ตามเวลาไทย YYYY-MM-DD */
export function todayBangkok(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

const TH_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
/** บ้านเลขที่มาตรฐาน: เลขไทย→อารบิก, ตัดช่องว่าง/คำว่า "เลขที่" */
export function normalizeHouseNo(s: string): string {
  return s
    .replace(/[๐-๙]/g, (d) => String(TH_DIGITS.indexOf(d)))
    .replace(/^\s*(บ้าน)?เลขที่\s*/, '')
    .replace(/\s+/g, '')
    .slice(0, 20);
}

export interface AddressParts {
  houseNo: string;
  moo?: string | null;
  soi?: string | null;
  road?: string | null;
  community?: string | null;
  subdistrict?: string | null;
}
export function formatAddress(a: AddressParts): string {
  return [
    a.houseNo,
    a.moo && `ม.${a.moo}`,
    a.soi && `ซ.${a.soi}`,
    a.road && `ถ.${a.road}`,
    a.community && (a.community.startsWith('ชุมชน') ? a.community : `ชุมชน${a.community}`),
    a.subdistrict && `ต.${a.subdistrict}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** ข้อความอิสระจากผู้ใช้: ตัด control char/แท็ก และจำกัดความยาว */
export function cleanText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  return s || null;
}
