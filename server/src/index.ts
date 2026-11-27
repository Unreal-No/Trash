import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { encrypt, sha256Hex } from './crypto.ts';
import { lineClient, lineIdTokenVerifier, type LineClient } from './line.ts';
import { MemoryStore } from './store/memory.ts';
import { PgStore } from './store/pg.ts';
import type { Store } from './store/types.ts';

const cfg = loadConfig();
let store: Store;
let line: LineClient = lineClient(cfg.line.channelAccessToken);
let verifyIdToken = lineIdTokenVerifier(cfg.line.loginChannelId);

if (cfg.store === 'memory') {
  // โหมดสาธิต: ข้อมูลตัวอย่าง, LIFF token = "demo-<userId>", staff token = "demo-cashier"
  const m = new MemoryStore();
  const k = cfg.dataKey;
  const seed = (code: string, name: string, addr: string, category: 'RESIDENTIAL' | 'COMMERCIAL', rate: number, invNo: string) => {
    const p = m.addPayer({ code, nameEnc: encrypt(name, k), addressEnc: encrypt(addr, k), phoneEnc: null, category, rateSatang: rate });
    m.addInvoice({ invoiceNo: invNo, payerId: p.id, period: '2569-11', amountSatang: rate, dueDate: '2026-12-15' });
  };
  seed('A0001', 'นายสมชาย ใจดี', '99/1 หมู่ 2 ต.ตัวอย่าง', 'RESIDENTIAL', 4000, 'INV256911001');
  seed('A0002', 'นางสมศรี ใจดี', '12 หมู่ 3 ต.ตัวอย่าง', 'RESIDENTIAL', 4000, 'INV256911002');
  seed('B0001', 'ร้านสมชายพาณิชย์', '5/7 ถ.ตลาด ต.ตัวอย่าง', 'COMMERCIAL', 20000, 'INV256911003');
  m.staff.set(sha256Hex('demo-cashier'), { id: '00000000-0000-0000-0000-000000000001', name: 'เจ้าหน้าที่ทดสอบ', role: 'CASHIER' });
  store = m;
  verifyIdToken = async (t) => (t.startsWith('demo-') ? t.slice(5) : null);
  line = { push: async (to) => console.log('[demo] LINE push →', to), reply: async () => {} };
  console.log('DEMO: A0001/INV256911001, A0002/INV256911002, B0001/INV256911003 (ร้านค้า), staff token demo-cashier');
} else {
  if (!cfg.databaseUrl) throw new Error('Missing env DATABASE_URL');
  store = new PgStore(cfg.databaseUrl);
}

createApp({ cfg, store, line, verifyIdToken }).listen(cfg.port, () => console.log(`listening on :${cfg.port}`));
