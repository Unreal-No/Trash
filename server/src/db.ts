// ชั้นฐานข้อมูลเดียว ใช้ได้ทั้ง PostgreSQL จริง (pg) และ PGlite (PostgreSQL ฝังในโปรแกรม ไม่ต้องติดตั้ง DB)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryResult } from 'pg';

export interface Q {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}
export interface Db extends Q {
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<QueryResult> }): Q => ({
    async query(sql, params) {
      const r = await c.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrap(c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

/** dataDir = undefined → ในหน่วยความจำ (ทดสอบ) */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): Q => ({
    async query(sql, params) {
      const r = await c.query(sql, params);
      return { rows: r.rows as any[], rowCount: r.affectedRows || r.rows.length };
    },
  });
  return { ...wrap(db), tx: (fn) => db.transaction((t) => fn(wrap(t))), close: () => db.close() };
}

/** รัน migration ที่ยังไม่เคยรัน ตามลำดับชื่อไฟล์ */
export async function migrate(db: Db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await db.tx(async (q) => {
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
  }
}
