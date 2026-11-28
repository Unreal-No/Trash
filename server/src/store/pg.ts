import pg from 'pg';
import { fiscalYearBE, formatReceiptNo } from '../util.ts';
import type {
  Invoice, LinkedPayer, NewInvoice, Order, Payer, PaymentInput, PaymentResult, Receipt, ReceiptItem, Staff, Store,
} from './types.ts';

const payerCols = (t = '') =>
  `${t}id, ${t}code, ${t}name_enc AS "nameEnc", ${t}address_enc AS "addressEnc", ${t}phone_enc AS "phoneEnc", ${t}category, ${t}rate_satang AS "rateSatang"`;
const invCols = (t = '') =>
  `${t}id, ${t}invoice_no AS "invoiceNo", ${t}payer_id AS "payerId", ${t}period, ${t}amount_satang AS "amountSatang", ${t}status, to_char(${t}due_date, 'YYYY-MM-DD') AS "dueDate"`;
const rcpCols =
  'receipt_no AS "receiptNo", payer_id AS "payerId", order_id AS "orderId", amount_satang AS "amountSatang", method, paid_at AS "paidAt", staff_id AS "staffId"';

type Q = pg.Pool | pg.PoolClient;

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }

  private async one<T>(sql: string, params: unknown[], q: Q = this.pool): Promise<T | null> {
    const r = await q.query(sql, params);
    return (r.rows[0] as T) ?? null;
  }

  findPayerByCode(code: string) {
    return this.one<Payer>(`SELECT ${payerCols()} FROM payers WHERE code=$1 AND active`, [code]);
  }
  findPayerById(id: string) {
    return this.one<Payer>(`SELECT ${payerCols()} FROM payers WHERE id=$1`, [id]);
  }
  async listLinkedPayers(u: string): Promise<LinkedPayer[]> {
    const r = await this.pool.query(
      `SELECT ${payerCols('p.')}, l.label FROM line_links l JOIN payers p ON p.id=l.payer_id
       WHERE l.line_user_id=$1 ORDER BY l.linked_at`,
      [u],
    );
    return r.rows.map(({ label, ...payer }) => ({ payer: payer as Payer, label }));
  }
  async linkLine(u: string, payerId: string, label: string, consentVersion: string) {
    await this.pool.query(
      `INSERT INTO line_links(line_user_id, payer_id, label, consent_version) VALUES ($1,$2,$3,$4)
       ON CONFLICT (line_user_id, payer_id) DO UPDATE SET label=$3, consent_version=$4`,
      [u, payerId, label, consentVersion],
    );
  }
  async unlinkLine(u: string, payerId: string) {
    await this.pool.query('DELETE FROM line_links WHERE line_user_id=$1 AND payer_id=$2', [u, payerId]);
  }
  async lineUsersOfPayer(payerId: string) {
    const r = await this.pool.query('SELECT line_user_id FROM line_links WHERE payer_id=$1', [payerId]);
    return r.rows.map((x) => x.line_user_id as string);
  }

  async listInvoices(payerId: string) {
    const r = await this.pool.query(
      `SELECT ${invCols()} FROM invoices WHERE payer_id=$1 ORDER BY period DESC LIMIT 36`,
      [payerId],
    );
    return (r.rows as Invoice[]).reverse();
  }
  async getInvoices(ids: string[]) {
    if (!ids.length) return [];
    const r = await this.pool.query(`SELECT ${invCols()} FROM invoices WHERE id = ANY($1::uuid[])`, [ids]);
    return r.rows as Invoice[];
  }
  findInvoiceByRefs(code: string, no: string) {
    return this.one<Invoice>(
      `SELECT ${invCols('i.')} FROM invoices i JOIN payers p ON p.id=i.payer_id WHERE p.code=$1 AND i.invoice_no=$2`,
      [code, no],
    );
  }
  async ensureInvoices(list: NewInvoice[]) {
    for (const n of list) {
      await this.pool.query(
        `INSERT INTO invoices(invoice_no, payer_id, period, amount_satang, due_date) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (payer_id, period) DO NOTHING`,
        [n.invoiceNo, n.payerId, n.period, n.amountSatang, n.dueDate],
      );
    }
  }

  async createOrder(o: { orderNo: string; createdBy: string; items: { invoiceId: string; amountSatang: number }[] }) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const amount = o.items.reduce((s, i) => s + i.amountSatang, 0);
      const r = await c.query(
        `INSERT INTO orders(order_no, created_by, amount_satang) VALUES ($1,$2,$3) RETURNING id`,
        [o.orderNo, o.createdBy, amount],
      );
      for (const it of o.items)
        await c.query('INSERT INTO order_items(order_id, invoice_id, amount_satang) VALUES ($1,$2,$3)', [
          r.rows[0].id,
          it.invoiceId,
          it.amountSatang,
        ]);
      await c.query('COMMIT');
      return { id: r.rows[0].id, orderNo: o.orderNo, createdBy: o.createdBy, amountSatang: amount, status: 'OPEN', items: o.items } as Order;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  private async loadOrder(where: string, param: string, q: Q = this.pool, lock = false): Promise<Order | null> {
    const o = await this.one<Omit<Order, 'items'>>(
      `SELECT id, order_no AS "orderNo", created_by AS "createdBy", amount_satang AS "amountSatang", status
       FROM orders WHERE ${where}=$1${lock ? ' FOR UPDATE' : ''}`,
      [param],
      q,
    );
    if (!o) return null;
    const it = await q.query(
      'SELECT invoice_id AS "invoiceId", amount_satang AS "amountSatang" FROM order_items WHERE order_id=$1',
      [o.id],
    );
    return { ...o, items: it.rows };
  }
  findOrderByNo(no: string) {
    return this.loadOrder('order_no', no);
  }

  async recordPayment(p: PaymentInput): Promise<PaymentResult> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      if (p.bankTxnId) {
        const dup = await c.query('SELECT 1 FROM payments WHERE bank_txn_id=$1', [p.bankTxnId]);
        if (dup.rowCount) {
          await c.query('ROLLBACK');
          return { kind: 'DUPLICATE' };
        }
      }
      const order = await this.loadOrder('id', p.orderId, c, true);
      if (!order) {
        await c.query('ROLLBACK');
        return { kind: 'NOT_FOUND' };
      }
      // ล็อกทุกงวดตามลำดับ id กัน deadlock
      const invs = (
        await c.query(`SELECT ${invCols()} FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [
          order.items.map((i) => i.invoiceId),
        ])
      ).rows as Invoice[];
      const result =
        order.status === 'PAID' || invs.some((i) => i.status !== 'UNPAID')
          ? 'REFUND'
          : p.amountSatang !== order.amountSatang
            ? 'MISMATCH'
            : 'PAID';
      const pay = await c.query(
        `INSERT INTO payments(order_id, method, amount_satang, bank_txn_id, staff_id, result, raw, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [order.id, p.method, p.amountSatang, p.bankTxnId, p.staffId, result, p.raw ?? null, p.paidAt],
      );
      if (result !== 'PAID') {
        if (order.status !== 'PAID') await c.query('UPDATE orders SET status=$2 WHERE id=$1', [order.id, result]);
        await c.query('COMMIT');
        return { kind: result };
      }
      await c.query(`UPDATE orders SET status='PAID' WHERE id=$1`, [order.id]);
      await c.query(`UPDATE invoices SET status='PAID' WHERE id = ANY($1::uuid[])`, [invs.map((i) => i.id)]);

      const byPayer = new Map<string, Invoice[]>();
      for (const i of invs.sort((a, b) => a.period.localeCompare(b.period)))
        byPayer.set(i.payerId, [...(byPayer.get(i.payerId) ?? []), i]);
      const year = fiscalYearBE(p.paidAt);
      const receipts: Receipt[] = [];
      for (const [payerId, list] of byPayer) {
        const seq = await c.query(
          `INSERT INTO receipt_counters(year, last) VALUES ($1, 1)
           ON CONFLICT (year) DO UPDATE SET last = receipt_counters.last + 1 RETURNING last`,
          [year],
        );
        const receiptNo = formatReceiptNo(year, seq.rows[0].last);
        const amount = list.reduce((s, i) => s + i.amountSatang, 0);
        await c.query(
          `INSERT INTO receipts(receipt_no, payer_id, order_id, payment_id, amount_satang, method, staff_id, paid_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [receiptNo, payerId, order.id, pay.rows[0].id, amount, p.method, p.staffId, p.paidAt],
        );
        const items: ReceiptItem[] = [];
        for (const i of list) {
          await c.query('INSERT INTO receipt_items(receipt_no, invoice_id, period, amount_satang) VALUES ($1,$2,$3,$4)', [
            receiptNo,
            i.id,
            i.period,
            i.amountSatang,
          ]);
          items.push({ invoiceId: i.id, period: i.period, amountSatang: i.amountSatang });
        }
        receipts.push({ receiptNo, payerId, orderId: order.id, amountSatang: amount, method: p.method, paidAt: p.paidAt, staffId: p.staffId, items });
      }
      await c.query('COMMIT');
      return { kind: 'PAID', receipts };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      // unique violation บน bank_txn_id จาก callback ที่มาพร้อมกัน → ถือเป็นรายการซ้ำ
      if ((e as { code?: string }).code === '23505' && p.bankTxnId) return { kind: 'DUPLICATE' };
      throw e;
    } finally {
      c.release();
    }
  }

  private async withItems(rows: Omit<Receipt, 'items'>[]): Promise<Receipt[]> {
    if (!rows.length) return [];
    const it = await this.pool.query(
      `SELECT receipt_no, invoice_id AS "invoiceId", period, amount_satang AS "amountSatang"
       FROM receipt_items WHERE receipt_no = ANY($1) ORDER BY period`,
      [rows.map((r) => r.receiptNo)],
    );
    return rows.map((r) => ({
      ...r,
      paidAt: new Date(r.paidAt).toISOString(),
      items: it.rows.filter((x) => x.receipt_no === r.receiptNo).map(({ receipt_no: _, ...x }) => x as ReceiptItem),
    }));
  }
  async getReceipt(no: string) {
    const r = await this.pool.query(`SELECT ${rcpCols} FROM receipts WHERE receipt_no=$1 AND voided_at IS NULL`, [no]);
    return (await this.withItems(r.rows))[0] ?? null;
  }
  async listReceipts(payerIds: string[]) {
    if (!payerIds.length) return [];
    const r = await this.pool.query(
      `SELECT ${rcpCols} FROM receipts WHERE payer_id = ANY($1::uuid[]) AND voided_at IS NULL ORDER BY paid_at DESC LIMIT 50`,
      [payerIds],
    );
    return this.withItems(r.rows);
  }
  findStaffByTokenHash(h: string) {
    return this.one<Staff>('SELECT id, name, role FROM staff WHERE token_hash=$1 AND active', [h]);
  }
  async audit(actor: string, action: string, target: string, meta?: unknown) {
    await this.pool.query('INSERT INTO audit_logs(actor, action, target, meta) VALUES ($1,$2,$3,$4)', [
      actor,
      action,
      target,
      meta ?? null,
    ]);
  }
}
