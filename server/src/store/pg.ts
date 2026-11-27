import pg from 'pg';
import { fiscalYearBE, formatReceiptNo } from '../util.ts';
import type { Invoice, InvoiceStatus, Payer, PaymentInput, PaymentResult, Receipt, Staff, Store } from './types.ts';

const payerCols = (t = '') =>
  `${t}id, ${t}code, ${t}name_enc AS "nameEnc", ${t}address_enc AS "addressEnc", ${t}phone_enc AS "phoneEnc"`;
const invCols = (t = '') =>
  `${t}id, ${t}invoice_no AS "invoiceNo", ${t}payer_id AS "payerId", ${t}period, ${t}amount_satang AS "amountSatang", ${t}status, to_char(${t}due_date, 'YYYY-MM-DD') AS "dueDate"`;
const rcpCols = (t = '') =>
  `${t}receipt_no AS "receiptNo", ${t}invoice_id AS "invoiceId", ${t}payer_id AS "payerId", ${t}amount_satang AS "amountSatang", ${t}method, ${t}paid_at AS "paidAt", ${t}staff_id AS "staffId"`;

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }

  private async one<T>(sql: string, params: unknown[]): Promise<T | null> {
    const r = await this.pool.query(sql, params);
    return (r.rows[0] as T) ?? null;
  }

  findPayerByCode(code: string) {
    return this.one<Payer>(`SELECT ${payerCols()} FROM payers WHERE code=$1 AND active`, [code]);
  }
  findPayerById(id: string) {
    return this.one<Payer>(`SELECT ${payerCols()} FROM payers WHERE id=$1`, [id]);
  }
  findPayerByLineUser(u: string) {
    return this.one<Payer>(
      `SELECT ${payerCols('p.')} FROM line_links l JOIN payers p ON p.id=l.payer_id WHERE l.line_user_id=$1`,
      [u],
    );
  }
  async linkLine(u: string, payerId: string, consentVersion: string) {
    await this.pool.query(
      `INSERT INTO line_links(line_user_id, payer_id, consent_version) VALUES ($1,$2,$3)
       ON CONFLICT (line_user_id) DO UPDATE SET payer_id=$2, consent_version=$3, linked_at=now()`,
      [u, payerId, consentVersion],
    );
  }
  async unlinkLine(u: string) {
    await this.pool.query('DELETE FROM line_links WHERE line_user_id=$1', [u]);
  }
  async lineUsersOfPayer(payerId: string) {
    const r = await this.pool.query('SELECT line_user_id FROM line_links WHERE payer_id=$1', [payerId]);
    return r.rows.map((x) => x.line_user_id as string);
  }
  async listInvoices(payerId: string) {
    const r = await this.pool.query(`SELECT ${invCols()} FROM invoices WHERE payer_id=$1 ORDER BY period`, [payerId]);
    return r.rows as Invoice[];
  }
  getInvoice(id: string) {
    return this.one<Invoice>(`SELECT ${invCols()} FROM invoices WHERE id=$1`, [id]);
  }
  findInvoiceByRefs(code: string, no: string) {
    return this.one<Invoice>(
      `SELECT ${invCols('i.')}
       FROM invoices i JOIN payers p ON p.id=i.payer_id WHERE p.code=$1 AND i.invoice_no=$2`,
      [code, no],
    );
  }
  async setInvoiceStatus(id: string, from: InvoiceStatus[], to: InvoiceStatus) {
    const r = await this.pool.query('UPDATE invoices SET status=$3 WHERE id=$1 AND status = ANY($2)', [id, from, to]);
    return r.rowCount === 1;
  }

  async recordPayment(p: PaymentInput): Promise<PaymentResult> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      if (p.bankTxnId) {
        const dup = await c.query(
          `SELECT ${rcpCols('r.')} FROM payments pm LEFT JOIN receipts r ON r.payment_id=pm.id WHERE pm.bank_txn_id=$1`,
          [p.bankTxnId],
        );
        if (dup.rowCount) {
          await c.query('ROLLBACK');
          const row = dup.rows[0];
          return { kind: 'DUPLICATE', receipt: row.receiptNo ? (row as Receipt) : null };
        }
      }
      const inv = (await c.query(`SELECT ${invCols()} FROM invoices WHERE id=$1 FOR UPDATE`, [p.invoiceId])).rows[0] as
        | Invoice
        | undefined;
      if (!inv) {
        await c.query('ROLLBACK');
        return { kind: 'NOT_FOUND' };
      }
      const result =
        inv.status === 'PAID' ? 'LATE' : inv.status === 'CANCELLED' || inv.amountSatang !== p.amountSatang ? 'MISMATCH' : 'PAID';
      const pay = await c.query(
        `INSERT INTO payments(invoice_id, method, amount_satang, bank_txn_id, staff_id, result, raw, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [inv.id, p.method, p.amountSatang, p.bankTxnId, p.staffId, result, p.raw ?? null, p.paidAt],
      );
      if (result !== 'PAID') {
        if (result === 'MISMATCH' && inv.status !== 'CANCELLED')
          await c.query(`UPDATE invoices SET status='MISMATCH' WHERE id=$1`, [inv.id]);
        await c.query('COMMIT');
        return result === 'LATE' ? { kind: 'ALREADY_PAID' } : { kind: 'MISMATCH' };
      }
      const year = fiscalYearBE(p.paidAt);
      const seq = await c.query(
        `INSERT INTO receipt_counters(year, last) VALUES ($1, 1)
         ON CONFLICT (year) DO UPDATE SET last = receipt_counters.last + 1 RETURNING last`,
        [year],
      );
      const receiptNo = formatReceiptNo(year, seq.rows[0].last);
      await c.query(`UPDATE invoices SET status='PAID' WHERE id=$1`, [inv.id]);
      const r = await c.query(
        `INSERT INTO receipts(receipt_no, invoice_id, payer_id, payment_id, amount_satang, method, staff_id, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${rcpCols()}`,
        [receiptNo, inv.id, inv.payerId, pay.rows[0].id, p.amountSatang, p.method, p.staffId, p.paidAt],
      );
      await c.query('COMMIT');
      return { kind: 'PAID', receipt: r.rows[0] as Receipt };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      // unique violation บน bank_txn_id จาก callback ที่มาพร้อมกัน → ถือเป็นรายการซ้ำ
      if ((e as { code?: string }).code === '23505' && p.bankTxnId) return { kind: 'DUPLICATE', receipt: null };
      throw e;
    } finally {
      c.release();
    }
  }

  getReceipt(no: string) {
    return this.one<Receipt>(`SELECT ${rcpCols()} FROM receipts WHERE receipt_no=$1 AND voided_at IS NULL`, [no]);
  }
  async listReceipts(payerId: string) {
    const r = await this.pool.query(
      `SELECT ${rcpCols()} FROM receipts WHERE payer_id=$1 AND voided_at IS NULL ORDER BY paid_at DESC LIMIT 50`,
      [payerId],
    );
    return r.rows as Receipt[];
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
