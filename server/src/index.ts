import { createApp } from './app.ts';
import { AuthService } from './auth.ts';
import { loadConfig } from './config.ts';
import { migrate, openPg, openPglite } from './db.ts';
import { lineClient, lineIdTokenVerifier, type IdTokenVerifier, type LineClient } from './line.ts';
import { DEMO_USERS, isEmpty, seedDemo } from './seed.ts';

const cfg = loadConfig();
const db = cfg.databaseUrl ? await openPg(cfg.databaseUrl) : await openPglite(cfg.dataDir);
await migrate(db);

let line: LineClient = lineClient(cfg.line.channelAccessToken);
let verifyIdToken: IdTokenVerifier = lineIdTokenVerifier(cfg.line.loginChannelId);

if (cfg.demo) {
  if (await isEmpty(db)) {
    console.log('กำลังสร้างข้อมูลสาธิต...');
    console.log(`สร้างแล้ว ${(await seedDemo(db, cfg)).houses} หลัง`);
  }
  // จำลอง LINE: token "demo-<userId>"
  verifyIdToken = async (t) => (t.startsWith('demo-') ? t.slice(5) : null);
  line = { push: async (to) => console.log('[demo] LINE push →', to), reply: async () => {} };
  console.log('\n=== โหมดสาธิต (ข้อมูลสมมติ) ===');
  console.log(`หลังบ้าน:  ${cfg.baseUrl}/admin/`);
  for (const u of DEMO_USERS) console.log(`  ${u.username.padEnd(8)} / ${u.password.padEnd(11)} ${u.name}`);
  console.log(`ประชาชน:  ${cfg.baseUrl}/liff/  (ผูกด้วย A0001 / INV256911001)`);
} else {
  // ผู้ดูแลคนแรก: ตั้ง ADMIN_USERNAME / ADMIN_PASSWORD ตอนเริ่มระบบครั้งแรก
  const auth = new AuthService(db);
  if ((await auth.countUsers()) === 0) {
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;
    if (!u || !p) throw new Error('ยังไม่มีผู้ใช้ในระบบ: ตั้ง ADMIN_USERNAME และ ADMIN_PASSWORD เพื่อสร้างผู้ดูแลคนแรก');
    await auth.createUser({ username: u, password: p, name: 'ผู้ดูแลระบบ', role: 'ADMIN' });
    console.log(`สร้างผู้ดูแลระบบ ${u} แล้ว — เปลี่ยนรหัสผ่านหลังเข้าใช้งาน`);
  }
}

const server = createApp({ cfg, db, line, verifyIdToken }).listen(cfg.port, () => console.log(`\nพร้อมใช้งาน: ${cfg.baseUrl}`));
const stop = async () => {
  server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
