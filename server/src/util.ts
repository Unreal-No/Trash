/** ปีงบประมาณ พ.ศ. (เริ่ม 1 ต.ค.) ตามเวลาไทย */
export function fiscalYearBE(iso: string): number {
  const t = new Date(new Date(iso).getTime() + 7 * 3600_000); // UTC+7
  const y = t.getUTCFullYear() + 543;
  return t.getUTCMonth() >= 9 ? y + 1 : y;
}

export function formatReceiptNo(yearBE: number, seq: number): string {
  return `R${yearBE}-${String(seq).padStart(6, '0')}`;
}
