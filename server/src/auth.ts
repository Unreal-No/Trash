import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256Hex } from './crypto.ts';
import type { Db } from './db.ts';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'ADMIN' | 'SUPERVISOR' | 'CASHIER' | 'SURVEYOR' | 'VIEWER';
export const ROLES: Role[] = ['ADMIN', 'SUPERVISOR', 'CASHIER', 'SURVEYOR', 'VIEWER'];

const ALL: Role[] = ROLES;
export const PERMISSIONS = {
  'house.read': ALL,
  'house.write': ['ADMIN', 'SUPERVISOR', 'SURVEYOR'],
  'house.verify': ['ADMIN', 'SUPERVISOR'],
  'payment.cash': ['ADMIN', 'CASHIER'],
  'dashboard.read': ['ADMIN', 'SUPERVISOR', 'CASHIER', 'VIEWER'],
  'map.read': ALL,
  'report.read': ['ADMIN', 'SUPERVISOR', 'VIEWER'],
  'audit.read': ['ADMIN', 'SUPERVISOR'],
  'billing.manage': ['ADMIN'],
  'user.manage': ['ADMIN'],
  'settings.manage': ['ADMIN'],
} satisfies Record<string, Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, p: Permission) => (PERMISSIONS[p] as Role[]).includes(role);
export const permissionsOf = (role: Role) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));

export interface StaffUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const want = Buffer.from(k, 'base64');
  return key.length === want.length && timingSafeEqual(key, want);
}

const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MIN = 15;

export class AuthService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async login(username: string, password: string) {
    const r = await this.db.query(
      `SELECT id, username, name, role, password_hash, active, failed_attempts, locked_until FROM staff_users WHERE username=$1`,
      [username.trim().toLowerCase()],
    );
    const u = r.rows[0];
    // ตอบข้อความเดียวกันทุกกรณี ไม่บอกว่ามีผู้ใช้นี้หรือไม่
    const fail = { ok: false as const, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    if (!u || !u.active) {
      await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); // เวลาตอบใกล้เคียงกัน
      return fail;
    }
    if (u.locked_until && new Date(u.locked_until) > new Date())
      return { ok: false as const, error: `บัญชีถูกล็อกชั่วคราว ลองใหม่ใน ${LOCK_MIN} นาที` };
    if (!(await verifyPassword(password, u.password_hash))) {
      const n = u.failed_attempts + 1;
      await this.db.query(
        `UPDATE staff_users SET failed_attempts=$2, locked_until=CASE WHEN $2 >= ${MAX_FAILS} THEN now() + interval '${LOCK_MIN} minutes' ELSE NULL END WHERE id=$1`,
        [u.id, n],
      );
      return fail;
    }
    await this.db.query(`UPDATE staff_users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [u.id]);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
    await this.db.query(`INSERT INTO staff_sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)`, [sha256Hex(token), u.id, expiresAt]);
    await this.db.query(`DELETE FROM staff_sessions WHERE expires_at < now()`);
    const user: StaffUser = { id: u.id, username: u.username, name: u.name, role: u.role };
    return { ok: true as const, token, expiresAt, user };
  }

  async fromToken(token: string): Promise<StaffUser | null> {
    const r = await this.db.query<StaffUser>(
      `SELECT u.id, u.username, u.name, u.role FROM staff_sessions s JOIN staff_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`,
      [sha256Hex(token)],
    );
    return r.rows[0] ?? null;
  }

  async logout(token: string) {
    await this.db.query('DELETE FROM staff_sessions WHERE token_hash=$1', [sha256Hex(token)]);
  }

  // ---------- จัดการผู้ใช้ ----------
  async listUsers() {
    const r = await this.db.query(
      `SELECT id, username, name, role, active, last_login_at AS "lastLoginAt", (locked_until > now()) AS locked
       FROM staff_users ORDER BY role, username`,
    );
    return { items: r.rows.map((x) => ({ ...x, locked: !!x.locked })) };
  }

  async createUser(input: { username: string; name: string; role: Role; password: string }) {
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,50}$/.test(username)) throw new Error('ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 3–50 ตัว');
    if (!ROLES.includes(input.role)) throw new Error('สิทธิ์ไม่ถูกต้อง');
    if ((input.password ?? '').length < 8) throw new Error('รหัสผ่านอย่างน้อย 8 ตัว');
    const name = input.name.trim().slice(0, 100);
    if (!name) throw new Error('กรุณากรอกชื่อ');
    const r = await this.db.query(
      `INSERT INTO staff_users(username, name, role, password_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [username, name, input.role, await hashPassword(input.password)],
    );
    if (!r.rows[0]) throw new Error('ชื่อผู้ใช้นี้มีอยู่แล้ว');
    return { id: r.rows[0].id as string };
  }

  async updateUser(id: string, input: { name?: string; role?: Role; active?: boolean; password?: string }, actorId: string) {
    if (input.role && !ROLES.includes(input.role)) throw new Error('สิทธิ์ไม่ถูกต้อง');
    if (id === actorId && (input.active === false || (input.role && input.role !== 'ADMIN')))
      throw new Error('ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');
    if (input.password !== undefined && input.password.length < 8) throw new Error('รหัสผ่านอย่างน้อย 8 ตัว');
    const hash = input.password ? await hashPassword(input.password) : null;
    const r = await this.db.query(
      `UPDATE staff_users SET name=COALESCE($2,name), role=COALESCE($3,role), active=COALESCE($4,active),
         password_hash=COALESCE($5,password_hash), failed_attempts=CASE WHEN $5::text IS NULL THEN failed_attempts ELSE 0 END,
         locked_until=CASE WHEN $5::text IS NULL THEN locked_until ELSE NULL END
       WHERE id=$1`,
      [id, input.name?.trim().slice(0, 100) || null, input.role ?? null, input.active ?? null, hash],
    );
    if (!r.rowCount) throw new Error('ไม่พบผู้ใช้');
    if (input.active === false || hash) await this.db.query('DELETE FROM staff_sessions WHERE user_id=$1', [id]);
  }

  async countUsers() {
    return Number((await this.db.query('SELECT count(*)::int AS n FROM staff_users')).rows[0].n);
  }
}
