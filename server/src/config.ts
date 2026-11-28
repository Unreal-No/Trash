function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env ${name}`);
  return v;
}

export interface Config {
  port: number;
  baseUrl: string;
  demo: boolean; // โหมดสาธิต: ข้อมูลตัวอย่าง + จำลอง LINE login
  databaseUrl?: string; // มี = ใช้ PostgreSQL, ไม่มี = PGlite ในโฟลเดอร์ dataDir
  dataDir: string;
  dataKey: Buffer; // AES-256 key (32 bytes)
  receiptSecret: string;
  billerId: string;
  qrTtlMinutes: number;
  bank: { callbackSecret: string; allowedIps: string[] };
  line: { channelSecret: string; channelAccessToken: string; loginChannelId: string; liffId: string };
}

export function loadConfig(): Config {
  const demo = process.env.STORE === 'memory' || process.argv.includes('--demo');
  const d = (v: string) => (demo ? v : undefined);
  const dataKey = Buffer.from(req('DATA_KEY', d('0'.repeat(64))), 'hex');
  if (dataKey.length !== 32) throw new Error('DATA_KEY must be 64 hex chars');
  const port = Number(process.env.PORT ?? 3000);
  return {
    port,
    baseUrl: req('BASE_URL', d(`http://localhost:${port}`)),
    demo,
    databaseUrl: process.env.DATABASE_URL || undefined,
    dataDir: process.env.DATA_DIR ?? (demo ? './demo-data' : './data'),
    dataKey,
    receiptSecret: req('RECEIPT_SECRET', d('dev-receipt-secret')),
    billerId: req('BILLER_ID', d('099400000000001')),
    qrTtlMinutes: Number(process.env.QR_TTL_MINUTES ?? 15),
    bank: {
      callbackSecret: req('BANK_CALLBACK_SECRET', d('dev-bank-secret')),
      allowedIps: (process.env.BANK_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    line: {
      channelSecret: req('LINE_CHANNEL_SECRET', d('dev-line-secret')),
      channelAccessToken: req('LINE_CHANNEL_ACCESS_TOKEN', d('dev')),
      loginChannelId: req('LINE_LOGIN_CHANNEL_ID', d('dev')),
      liffId: req('LIFF_ID', d('dev-liff')),
    },
  };
}
