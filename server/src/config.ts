function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env ${name}`);
  return v;
}

export interface Config {
  port: number;
  baseUrl: string;
  store: 'memory' | 'pg';
  databaseUrl?: string;
  dataKey: Buffer; // AES-256 key (32 bytes)
  receiptSecret: string;
  municipalityName: string;
  billerId: string;
  qrTtlMinutes: number;
  bank: { callbackSecret: string; allowedIps: string[] };
  line: { channelSecret: string; channelAccessToken: string; loginChannelId: string; liffId: string };
}

export function loadConfig(): Config {
  const dev = process.env.STORE === 'memory' || process.argv.includes('--demo');
  const dataKey = Buffer.from(req('DATA_KEY', dev ? '0'.repeat(64) : undefined), 'hex');
  if (dataKey.length !== 32) throw new Error('DATA_KEY must be 64 hex chars');
  return {
    port: Number(process.env.PORT ?? 3000),
    baseUrl: req('BASE_URL', dev ? 'http://localhost:3000' : undefined),
    store: dev ? 'memory' : 'pg',
    databaseUrl: process.env.DATABASE_URL,
    dataKey,
    receiptSecret: req('RECEIPT_SECRET', dev ? 'dev-receipt-secret' : undefined),
    municipalityName: process.env.MUNICIPALITY_NAME ?? 'เทศบาล',
    billerId: req('BILLER_ID', dev ? '099400000000001' : undefined),
    qrTtlMinutes: Number(process.env.QR_TTL_MINUTES ?? 15),
    bank: {
      callbackSecret: req('BANK_CALLBACK_SECRET', dev ? 'dev-bank-secret' : undefined),
      allowedIps: (process.env.BANK_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    line: {
      channelSecret: req('LINE_CHANNEL_SECRET', dev ? 'dev-line-secret' : undefined),
      channelAccessToken: req('LINE_CHANNEL_ACCESS_TOKEN', dev ? 'dev' : undefined),
      loginChannelId: req('LINE_LOGIN_CHANNEL_ID', dev ? 'dev' : undefined),
      liffId: req('LIFF_ID', dev ? 'dev-liff' : undefined),
    },
  };
}
