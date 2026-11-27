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
  const p = m.addPayer({
    code: 'A0001',
    nameEnc: encrypt('นายสมชาย ใจดี', k),
    addressEnc: encrypt('99/1 หมู่ 2 ต.ตัวอย่าง', k),
    phoneEnc: encrypt('0812345678', k),
  });
  m.addInvoice({ invoiceNo: 'INV256911001', payerId: p.id, period: '2569-11', amountSatang: 4000, dueDate: '2026-12-15' });
  m.addInvoice({ invoiceNo: 'INV256912001', payerId: p.id, period: '2569-12', amountSatang: 4000, dueDate: '2027-01-15' });
  m.staff.set(sha256Hex('demo-cashier'), { id: '00000000-0000-0000-0000-000000000001', name: 'เจ้าหน้าที่ทดสอบ', role: 'CASHIER' });
  store = m;
  verifyIdToken = async (t) => (t.startsWith('demo-') ? t.slice(5) : null);
  line = { push: async (to) => console.log('[demo] LINE push →', to), reply: async () => {} };
  console.log('DEMO mode: payer A0001 / INV256911001, staff token demo-cashier');
} else {
  if (!cfg.databaseUrl) throw new Error('Missing env DATABASE_URL');
  store = new PgStore(cfg.databaseUrl);
}

createApp({ cfg, store, line, verifyIdToken }).listen(cfg.port, () => console.log(`listening on :${cfg.port}`));
