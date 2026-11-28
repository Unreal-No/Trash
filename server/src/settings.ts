import type { Db } from './db.ts';

export interface Settings {
  municipality: {
    name: string;
    nameEn: string;
    address: string;
    district: string;
    province: string;
    postcode: string;
    phone: string;
    email: string;
    website: string;
    officeHours: string;
  };
  features: { mapEnabled: boolean; mapShowStatus: boolean; liffHouseSearch: boolean };
  map: { lat: number; lng: number; zoom: number };
  rates: { RESIDENTIAL: number; COMMERCIAL: number };
  areas: { subdistricts: string[]; communities: string[]; roads: string[]; sois: string[] };
}

// ค่าเริ่มต้น: เทศบาลเมืองเมืองพล อ.พล จ.ขอนแก่น — ตรวจสอบ/แก้ไขได้ในหน้าตั้งค่า
export const DEFAULT_SETTINGS: Settings = {
  municipality: {
    name: 'เทศบาลเมืองเมืองพล',
    nameEn: 'Muang Phon Town Municipality',
    address: 'อ.พล จ.ขอนแก่น 40120',
    district: 'พล',
    province: 'ขอนแก่น',
    postcode: '40120',
    phone: '',
    email: '',
    website: 'http://www.muangphon.go.th',
    officeHours: 'จันทร์–ศุกร์ 08:30–16:30',
  },
  features: { mapEnabled: true, mapShowStatus: true, liffHouseSearch: true },
  map: { lat: 15.8139, lng: 102.5978, zoom: 15 },
  rates: { RESIDENTIAL: 4000, COMMERCIAL: 20000 },
  areas: { subdistricts: ['เมืองพล'], communities: [], roads: [], sois: [] },
};

type Section = keyof Settings;
const SECTIONS = Object.keys(DEFAULT_SETTINGS) as Section[];

const str = (v: unknown, max = 200) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const list = (v: unknown) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, 100)).filter(Boolean))].slice(0, 500);

/** ตรวจ/ทำความสะอาดค่าที่ส่งมา ตามชนิดของค่าเริ่มต้น */
function sanitize(section: Section, value: any, current: any): any {
  if (section === 'areas') {
    return Object.fromEntries(Object.keys(current).map((k) => [k, k in (value ?? {}) ? list(value[k]) : current[k]]));
  }
  const out: any = { ...current };
  for (const k of Object.keys(current)) {
    if (!(k in (value ?? {}))) continue;
    const v = value[k];
    const t = typeof current[k];
    if (t === 'boolean') out[k] = v === true;
    else if (t === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`ค่า ${k} ไม่ถูกต้อง`);
      out[k] = section === 'rates' ? Math.max(0, Math.round(n)) : n;
    } else out[k] = str(v);
  }
  return out;
}

export class SettingsService {
  private db: Db;
  private cache: Settings | null = null;
  constructor(db: Db) {
    this.db = db;
  }

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const r = await this.db.query<{ key: Section; value: any }>('SELECT key, value FROM settings');
    const s = structuredClone(DEFAULT_SETTINGS);
    for (const { key, value } of r.rows) if (SECTIONS.includes(key)) (s as any)[key] = { ...(s as any)[key], ...value };
    return (this.cache = s);
  }

  async update(patch: Partial<Record<Section, unknown>>, actor: string) {
    const cur = await this.get();
    for (const section of SECTIONS) {
      if (!(section in patch)) continue;
      const next = sanitize(section, patch[section], cur[section]);
      await this.db.query(
        `INSERT INTO settings(key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=now(), updated_by=$3`,
        [section, JSON.stringify(next), actor],
      );
    }
    this.cache = null;
    return this.get();
  }
}
