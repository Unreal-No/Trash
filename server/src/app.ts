import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BankAuthError, parseBankPayment, verifyBankRequest } from './bank/adapter.ts';
import { sha256Hex } from './crypto.ts';
import { verifyLineSignature, type IdTokenVerifier, type LineClient } from './line.ts';
import { satangToBaht } from './promptpay.ts';
import { AppError, PaymentService } from './service.ts';
import type { Config } from './config.ts';
import type { Staff, Store } from './store/types.ts';

type RawReq = Request & { rawBody?: string };
type Handler = (req: Request, res: Response) => Promise<unknown>;

const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) => h(req, res).catch(next);

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** rate limit แบบ fixed window ในหน่วยความจำ (ระบบใหญ่ใช้ Redis) */
function rateLimit(max: number, windowMs: number, key: (req: Request) => string) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const k = key(req);
    const now = Date.now();
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return void res.status(429).json({ error: 'ทำรายการบ่อยเกินไป กรุณาลองใหม่ภายหลัง' });
    next();
  };
}

export interface Deps {
  cfg: Config;
  store: Store;
  line: LineClient;
  verifyIdToken: IdTokenVerifier;
}

export function createApp({ cfg, store, line, verifyIdToken }: Deps) {
  const svc = new PaymentService(store, cfg, line);
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
    });
    next();
  });
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, _res, buf) => {
        (req as RawReq).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public')));

  app.get('/api/config', (_req, res) => void res.json({ liffId: cfg.line.liffId }));
  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  // ---------- LINE webhook ----------
  app.post(
    '/webhook/line',
    wrap(async (req, res) => {
      const raw = (req as RawReq).rawBody ?? '';
      if (!verifyLineSignature(raw, req.get('x-line-signature'), cfg.line.channelSecret)) return res.sendStatus(401);
      res.sendStatus(200); // ตอบ LINE ทันที
      const liffUrl = `https://liff.line.me/${cfg.line.liffId}`;
      for (const ev of req.body?.events ?? []) {
        if (!ev.replyToken) continue;
        if (ev.type === 'follow' || ev.type === 'message') {
          line
            .reply(ev.replyToken, [
              {
                type: 'template',
                altText: 'ชำระค่าขยะ',
                template: {
                  type: 'buttons',
                  text: `${cfg.municipalityName}\nตรวจสอบยอด/ชำระค่าขยะ/ดูใบเสร็จ`,
                  actions: [{ type: 'uri', label: 'เปิดเมนูชำระค่าขยะ', uri: liffUrl }],
                },
              },
            ])
            .catch((e) => console.error('LINE reply failed', e));
        }
      }
    }),
  );

  // ---------- LIFF (ประชาชน) ----------
  const liff = express.Router();
  liff.use((req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer /, '');
    (token ? verifyIdToken(token) : Promise.resolve(null))
      .then((sub) => {
        if (!sub) return void res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ LINE ใหม่' });
        res.locals.lineUserId = sub;
        next();
      })
      .catch(next);
  });
  liff.post(
    '/link',
    rateLimit(5, 10 * 60_000, (req) => String(req.res?.locals.lineUserId)),
    wrap(async (req, res) => {
      const { payerCode, invoiceNo, consent } = req.body ?? {};
      if (typeof payerCode !== 'string' || typeof invoiceNo !== 'string')
        throw new AppError(400, 'กรุณากรอกรหัสผู้ชำระและเลขที่ใบแจ้งหนี้');
      res.json(await svc.link(res.locals.lineUserId, payerCode, invoiceNo, consent === true));
    }),
  );
  liff.delete(
    '/link',
    wrap(async (_req, res) => {
      await svc.unlink(res.locals.lineUserId);
      res.json({ ok: true });
    }),
  );
  liff.get('/invoices', wrap(async (_req, res) => res.json(await svc.invoicesFor(res.locals.lineUserId))));
  liff.get('/receipts', wrap(async (_req, res) => res.json(await svc.receiptsFor(res.locals.lineUserId))));
  liff.post(
    '/invoices/:id/qr',
    rateLimit(20, 10 * 60_000, (req) => String(req.res?.locals.lineUserId)),
    wrap(async (req, res) => res.json(await svc.createQr(res.locals.lineUserId, String(req.params.id)))),
  );
  app.use('/api/liff', liff);

  // ---------- ธนาคาร ----------
  app.post(
    '/api/bank/callback',
    wrap(async (req, res) => {
      if (cfg.bank.allowedIps.length && !cfg.bank.allowedIps.includes(req.ip ?? ''))
        return res.status(403).json({ status: 'FORBIDDEN' });
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
      const r = await svc.handleBankPayment(p);
      // ตอบ OK เสมอเมื่อบันทึกแล้ว (รวมซ้ำ/ยอดไม่ตรง) เพื่อไม่ให้ธนาคารส่งซ้ำไม่รู้จบ
      res.json({ status: 'OK', result: r.kind });
    }),
  );

  // ---------- เจ้าหน้าที่ ----------
  const staffApp = express.Router();
  staffApp.use((req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer /, '');
    (token ? store.findStaffByTokenHash(sha256Hex(token)) : Promise.resolve(null))
      .then((staff) => {
        if (!staff) return void res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
        res.locals.staff = staff;
        next();
      })
      .catch(next);
  });
  staffApp.get(
    '/payers/:code/invoices',
    rateLimit(60, 60_000, (req) => String((req.res?.locals.staff as Staff | undefined)?.id)),
    wrap(async (req, res) => res.json(await svc.staffLookup(res.locals.staff, String(req.params.code)))),
  );
  staffApp.post(
    '/counter/pay',
    wrap(async (req, res) => {
      const { invoiceId, receivedSatang } = req.body ?? {};
      if (typeof invoiceId !== 'string' || typeof receivedSatang !== 'number')
        throw new AppError(400, 'ข้อมูลไม่ครบ');
      res.json(await svc.counterPay(res.locals.staff, invoiceId, receivedSatang));
    }),
  );
  app.use('/api/staff', staffApp);

  // ---------- ตรวจสอบใบเสร็จ ----------
  app.get(
    '/r/:no',
    wrap(async (req, res) => {
      const r = await svc.verifyReceipt(String(req.params.no), String(req.query.sig ?? ''));
      res.set('Cache-Control', 'no-store');
      if (!r) return res.status(404).send('<meta charset="utf-8"><p>ไม่พบใบเสร็จ หรือลิงก์ไม่ถูกต้อง</p>');
      const date = new Date(r.paidAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
      res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ใบเสร็จ ${esc(r.receiptNo)}</title>
<style>body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px;color:#222}
h1{color:#1B7F3B;font-size:20px}.ok{background:#e6f4ea;padding:8px 12px;border-radius:8px}td{padding:4px 8px}</style>
<h1>${esc(cfg.municipalityName)}</h1><p class="ok">✔ ใบเสร็จถูกต้อง ออกโดยระบบ</p><table>
<tr><td>เลขที่</td><td>${esc(r.receiptNo)}</td></tr><tr><td>รหัสผู้ชำระ</td><td>${esc(r.payerCode)}</td></tr>
<tr><td>งวด</td><td>${esc(r.period)}</td></tr><tr><td>จำนวนเงิน</td><td>${satangToBaht(r.amountSatang)} บาท</td></tr>
<tr><td>ช่องทาง</td><td>${esc(r.method)}</td></tr><tr><td>วันที่</td><td>${esc(date)}</td></tr></table>`);
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return void res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่' });
  });
  return app;
}
