import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService, can, permissionsOf, type Permission, type Role, type StaffUser } from './auth.ts';
import { BankAuthError, parseBankPayment, verifyBankRequest } from './bank/adapter.ts';
import { DashboardService } from './dashboard.ts';
import { HouseService, HttpError } from './houses.ts';
import { verifyLineSignature, type IdTokenVerifier, type LineClient } from './line.ts';
import { PaymentService, parseSelection } from './payments.ts';
import { SettingsService } from './settings.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

type RawReq = Request & { rawBody?: string };
type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) => h(req, res).catch(next);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const bearer = (req: Request) => req.get('authorization')?.replace(/^Bearer /, '') || '';

/** rate limit แบบ fixed window ในหน่วยความจำ (หลายเครื่องใช้ Redis) */
function rateLimit(max: number, windowMs: number, key: (req: Request) => string) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const k = key(req);
    const now = Date.now();
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return void res.status(429).json({ error: 'ทำรายการบ่อยเกินไป กรุณาลองใหม่ภายหลัง' });
    if (hits.size > 10_000) for (const [kk, v] of hits) if (v.reset < now) hits.delete(kk);
    next();
  };
}

export interface Deps {
  cfg: Config;
  db: Db;
  line: LineClient;
  verifyIdToken: IdTokenVerifier;
}

export function createApp({ cfg, db, line, verifyIdToken }: Deps) {
  const settings = new SettingsService(db);
  const auth = new AuthService(db);
  const houses = new HouseService(db, cfg.dataKey, settings);
  const pay = new PaymentService(db, cfg, line, async () => (await settings.get()).municipality.name);
  const dash = new DashboardService(db, settings, houses);

  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => void ((req as RawReq).rawBody = buf.toString('utf8')) }));
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  app.use(express.static(path.join(root, 'public')));
  // ไลบรารีแผนที่/กราฟ เสิร์ฟจากเครื่องเอง (ใช้ได้แม้อินเทอร์เน็ตไม่เสถียร)
  app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
  app.use('/vendor/chart.js', express.static(path.join(root, 'node_modules/chart.js/dist'), { maxAge: '7d' }));
  app.get('/', (_req, res) => res.redirect('/admin/'));
  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  // ---------- Public ----------
  app.get('/api/config', wrap(async (_req, res) => {
    const s = await settings.get();
    const m = s.municipality;
    res.json({ liffId: cfg.line.liffId, demo: cfg.demo, municipality: { name: m.name, address: m.address, phone: m.phone, officeHours: m.officeHours }, features: { liffHouseSearch: s.features.liffHouseSearch } });
  }));
  app.get('/api/public/address-options', wrap(async (_req, res) => res.json(await houses.addressOptions(true))));

  // ---------- LINE webhook ----------
  app.post('/webhook/line', wrap(async (req, res) => {
    const raw = (req as RawReq).rawBody ?? '';
    if (!verifyLineSignature(raw, req.get('x-line-signature'), cfg.line.channelSecret)) return res.sendStatus(401);
    res.sendStatus(200); // ตอบ LINE ทันที
    const name = (await settings.get()).municipality.name;
    for (const ev of req.body?.events ?? []) {
      if (!ev.replyToken || (ev.type !== 'follow' && ev.type !== 'message')) continue;
      line.reply(ev.replyToken, [{
        type: 'template', altText: 'ชำระค่าขยะ',
        template: { type: 'buttons', text: `${name}\nตรวจสอบยอด/ชำระค่าขยะ/ดูใบเสร็จ`.slice(0, 160), actions: [{ type: 'uri', label: 'เปิดเมนูชำระค่าขยะ', uri: `https://liff.line.me/${cfg.line.liffId}` }] },
      }]).catch((e) => console.error('LINE reply failed', e));
    }
  }));

  // ---------- LIFF (ประชาชน) ----------
  const liff = express.Router();
  liff.use((req, res, next) => {
    const token = bearer(req);
    (token ? verifyIdToken(token) : Promise.resolve(null)).then((sub) => {
      if (!sub) return void res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ LINE ใหม่' });
      res.locals.lineUserId = sub;
      next();
    }).catch(next);
  });
  const perUser = (req: Request) => String(req.res?.locals.lineUserId);
  liff.get('/houses/search', rateLimit(30, 10 * 60_000, perUser), wrap(async (req, res) => res.json(await houses.publicSearch(req.query))));
  liff.get('/accounts', wrap(async (_req, res) => res.json(await pay.accountsFor(res.locals.lineUserId))));
  liff.post('/accounts', rateLimit(5, 10 * 60_000, perUser), wrap(async (req, res) => {
    const { payerCode, invoiceNo, label, consent } = req.body ?? {};
    if (typeof payerCode !== 'string' || typeof invoiceNo !== 'string') throw new HttpError(400, 'กรุณากรอกรหัสผู้ชำระและเลขที่ใบแจ้งหนี้');
    res.json(await pay.link(res.locals.lineUserId, payerCode, invoiceNo, String(label ?? ''), consent === true));
  }));
  liff.delete('/accounts/:code', wrap(async (req, res) => {
    await pay.unlink(res.locals.lineUserId, String(req.params.code));
    res.json({ ok: true });
  }));
  liff.post('/quote', rateLimit(60, 10 * 60_000, perUser), wrap(async (req, res) => res.json(await pay.quoteForLine(res.locals.lineUserId, parseSelection(req.body)))));
  liff.post('/orders', rateLimit(20, 10 * 60_000, perUser), wrap(async (req, res) => res.json(await pay.createQrOrder(res.locals.lineUserId, parseSelection(req.body)))));
  liff.get('/orders/:no', wrap(async (req, res) => res.json(await pay.orderStatus(res.locals.lineUserId, String(req.params.no)))));
  liff.get('/receipts', wrap(async (_req, res) => res.json(await pay.receiptsFor(res.locals.lineUserId))));
  app.use('/api/liff', liff);

  // ---------- ธนาคาร ----------
  app.post('/api/bank/callback', wrap(async (req, res) => {
    if (cfg.bank.allowedIps.length && !cfg.bank.allowedIps.includes(req.ip ?? '')) return res.status(403).json({ status: 'FORBIDDEN' });
    try {
      verifyBankRequest((req as RawReq).rawBody ?? '', req.headers, cfg.bank.callbackSecret);
    } catch (e) {
      if (e instanceof BankAuthError) return res.status(401).json({ status: 'UNAUTHORIZED' });
      throw e;
    }
    let p;
    try {
      p = parseBankPayment(req.body);
    } catch (e) {
      return res.status(400).json({ status: 'INVALID', message: (e as Error).message });
    }
    const r = await pay.handleBankPayment(p);
    res.json({ status: 'OK', result: r.kind }); // ตอบ OK เมื่อบันทึกแล้ว (รวมซ้ำ/ยอดไม่ตรง) ไม่ให้ธนาคารส่งซ้ำไม่รู้จบ
  }));

  // ---------- เจ้าหน้าที่ ----------
  app.post('/api/staff/login', rateLimit(20, 10 * 60_000, (req) => req.ip ?? ''), wrap(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
    const r = await auth.login(username, password);
    await db.query(`INSERT INTO audit_logs(actor, action, target) VALUES ($1,$2,$3)`, [r.ok ? `staff:${r.user.id}` : `ip:${req.ip}`, r.ok ? 'LOGIN' : 'LOGIN_FAILED', username.slice(0, 50)]);
    if (!r.ok) throw new HttpError(401, r.error);
    res.json({ token: r.token, expiresAt: r.expiresAt, user: { ...r.user, permissions: permissionsOf(r.user.role) } });
  }));

  const staff = express.Router();
  staff.use((req, res, next) => {
    const token = bearer(req);
    (token ? auth.fromToken(token) : Promise.resolve(null)).then((u) => {
      if (!u) return void res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
      res.locals.staff = u;
      next();
    }).catch(next);
  });
  const need = (p: Permission) => (_req: Request, res: Response, next: NextFunction) =>
    can((res.locals.staff as StaffUser).role, p) ? next() : void res.status(403).json({ error: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' });
  const me = (res: Response) => res.locals.staff as StaffUser;

  staff.post('/logout', wrap(async (req, res) => {
    await auth.logout(bearer(req));
    res.json({ ok: true });
  }));
  staff.get('/me', wrap(async (_req, res) => {
    const s = await settings.get();
    res.json({ user: { ...me(res), permissions: permissionsOf(me(res).role) }, settings: { municipality: s.municipality, features: s.features, map: s.map } });
  }));

  // ทะเบียนบ้าน
  staff.get('/houses', need('house.read'), wrap(async (req, res) => res.json(await houses.search(req.query, me(res)))));
  staff.get('/houses/:id', need('house.read'), wrap(async (req, res) => res.json(await houses.detail(String(req.params.id), me(res)))));
  staff.post('/houses', need('house.write'), wrap(async (req, res) => res.json(await houses.create(req.body ?? {}, me(res)))));
  staff.put('/houses/:id', need('house.write'), wrap(async (req, res) => res.json(await houses.update(String(req.params.id), req.body ?? {}, me(res)))));
  staff.get('/address-options', need('house.read'), wrap(async (_req, res) => res.json(await houses.addressOptions())));
  staff.get('/reviews', need('house.verify'), wrap(async (_req, res) => res.json(await houses.pendingReviews())));
  staff.post('/reviews/:id', need('house.verify'), wrap(async (req, res) => res.json(await houses.review(Number(req.params.id), req.body?.decision, req.body?.note, me(res)))));

  // การเงิน
  staff.get('/payers/:code', need('house.read'), wrap(async (req, res) => res.json(await pay.staffLookup(me(res), String(req.params.code)))));
  staff.post('/quote', need('payment.cash'), wrap(async (req, res) => res.json(await pay.staffQuote(me(res), parseSelection(req.body)))));
  staff.post('/counter/pay', need('payment.cash'), wrap(async (req, res) => {
    const { receivedSatang } = req.body ?? {};
    if (typeof receivedSatang !== 'number') throw new HttpError(400, 'ข้อมูลไม่ครบ');
    res.json(await pay.counterPay(me(res), parseSelection(req.body), receivedSatang));
  }));
  staff.post('/billing/generate', need('billing.manage'), wrap(async (req, res) => res.json(await pay.generateBilling(me(res), String(req.body?.period ?? '')))));

  // Dashboard / แผนที่ / รายงาน
  staff.get('/dashboard', need('dashboard.read'), wrap(async (req, res) => res.json(await dash.dashboard(req.query.fy))));
  staff.get('/map', need('map.read'), wrap(async (req, res) => res.json(await dash.map(req.query))));
  staff.get('/reports/outstanding.csv', need('report.read'), wrap(async (_req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="outstanding.csv"', 'Cache-Control': 'no-store' });
    res.send(await dash.outstandingCsv(me(res)));
  }));
  staff.get('/audit', need('audit.read'), wrap(async (req, res) => res.json(await dash.audit(req.query.limit))));

  // ผู้ใช้ / ตั้งค่า
  const userErr = (e: unknown) => (e instanceof HttpError ? e : new HttpError(400, (e as Error).message));
  staff.get('/users', need('user.manage'), wrap(async (_req, res) => res.json(await auth.listUsers())));
  staff.post('/users', need('user.manage'), wrap(async (req, res) => {
    const b = req.body ?? {};
    const r = await auth.createUser({ username: String(b.username ?? ''), name: String(b.name ?? ''), role: b.role as Role, password: String(b.password ?? '') }).catch((e) => { throw userErr(e); });
    await db.query(`INSERT INTO audit_logs(actor, action, target) VALUES ($1,'CREATE_USER',$2)`, [`staff:${me(res).id}`, String(b.username)]);
    res.json(r);
  }));
  staff.put('/users/:id', need('user.manage'), wrap(async (req, res) => {
    const b = req.body ?? {};
    await auth.updateUser(String(req.params.id), {
      name: typeof b.name === 'string' ? b.name : undefined, role: b.role, active: typeof b.active === 'boolean' ? b.active : undefined,
      password: typeof b.password === 'string' && b.password ? b.password : undefined,
    }, me(res).id).catch((e) => { throw userErr(e); });
    await db.query(`INSERT INTO audit_logs(actor, action, target, meta) VALUES ($1,'UPDATE_USER',$2,$3::jsonb)`, [`staff:${me(res).id}`, String(req.params.id), JSON.stringify({ role: b.role, active: b.active, password: b.password ? 'changed' : undefined })]);
    res.json({ ok: true });
  }));
  staff.get('/settings', need('settings.manage'), wrap(async (_req, res) => res.json(await settings.get())));
  staff.put('/settings', need('settings.manage'), wrap(async (req, res) => {
    const s = await settings.update(req.body ?? {}, me(res).name).catch((e) => { throw userErr(e); });
    await db.query(`INSERT INTO audit_logs(actor, action, target) VALUES ($1,'UPDATE_SETTINGS',$2)`, [`staff:${me(res).id}`, Object.keys(req.body ?? {}).join(',')]);
    res.json(s);
  }));
  app.use('/api/staff', staff);

  // ---------- ตรวจสอบใบเสร็จ ----------
  app.get('/r/:no', wrap(async (req, res) => {
    const r = await pay.verifyReceipt(String(req.params.no), String(req.query.sig ?? ''));
    res.set('Cache-Control', 'no-store');
    if (!r) return res.status(404).send('<meta charset="utf-8"><p>ไม่พบใบเสร็จ หรือลิงก์ไม่ถูกต้อง</p>');
    const name = (await settings.get()).municipality.name;
    const date = new Date(r.paidAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const method = ({ QR: 'QR พร้อมเพย์', BANK: 'โอนผ่านธนาคาร', CASH: 'เงินสด' } as Record<string, string>)[r.method] ?? r.method;
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ใบเสร็จ ${esc(r.receiptNo)}</title>
<style>body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px;color:#222}
h1{color:#1B7F3B;font-size:20px}.ok{background:#e6f4ea;padding:8px 12px;border-radius:8px}td{padding:4px 8px}</style>
<h1>${esc(name)}</h1><p class="ok">✔ ใบเสร็จถูกต้อง ออกโดยระบบ</p><table>
<tr><td>เลขที่</td><td>${esc(r.receiptNo)}</td></tr><tr><td>รหัสผู้ชำระ</td><td>${esc(r.payerCode)}</td></tr>
<tr><td>งวด</td><td>${esc(r.periods)}</td></tr><tr><td>จำนวนเงิน</td><td>${(r.amountSatang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท</td></tr>
<tr><td>ช่องทาง</td><td>${esc(method)}</td></tr><tr><td>วันที่</td><td>${esc(date)}</td></tr></table>`);
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if ((err as { type?: string }).type === 'entity.parse.failed') return void res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    console.error(err);
    res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่' });
  });
  return app;
}
