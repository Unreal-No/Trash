-- PostgreSQL 16 — ระบบค่าขยะเทศบาล
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1 บัญชี = 1 สถานที่จัดเก็บ (บ้าน/ร้านค้า)
CREATE TABLE payers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(20) NOT NULL UNIQUE,
  name_enc     text NOT NULL,                        -- AES-256-GCM (PDPA)
  address_enc  text NOT NULL,
  phone_enc    text,
  category     varchar(12) NOT NULL DEFAULT 'RESIDENTIAL' CHECK (category IN ('RESIDENTIAL','COMMERCIAL')),
  rate_satang  integer NOT NULL DEFAULT 0 CHECK (rate_satang >= 0),  -- อัตรารายเดือน
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 1 LINE ผูกได้หลายบัญชี / 1 บัญชีมีหลาย LINE ได้ (เจ้าของ, ญาติ, ผู้เช่า)
CREATE TABLE line_links (
  line_user_id    varchar(64) NOT NULL,
  payer_id        uuid NOT NULL REFERENCES payers(id),
  label           varchar(30) NOT NULL,
  consent_version varchar(20) NOT NULL,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line_user_id, payer_id)
);
CREATE INDEX ON line_links(payer_id);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    varchar(20) NOT NULL UNIQUE,        -- สุ่ม เดาไม่ได้ (ใช้ยืนยันตอนผูกบัญชี)
  payer_id      uuid NOT NULL REFERENCES payers(id),
  period        varchar(7) NOT NULL,                -- 2569-11
  amount_satang integer NOT NULL CHECK (amount_satang > 0),
  status        varchar(10) NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PAID','CANCELLED')),
  due_date      date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payer_id, period)
);

-- คำสั่งชำระ: หลายงวด/หลายบัญชี/ทั้งปี ใน QR เดียว (order_no = Ref1)
CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no      varchar(20) NOT NULL UNIQUE,
  created_by    varchar(80) NOT NULL,
  amount_satang integer NOT NULL CHECK (amount_satang > 0),
  status        varchar(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','MISMATCH','REFUND')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id      uuid NOT NULL REFERENCES orders(id),
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  amount_satang integer NOT NULL,
  PRIMARY KEY (order_id, invoice_id)
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  method        varchar(5) NOT NULL CHECK (method IN ('QR','BANK','CASH')),
  amount_satang integer NOT NULL,
  bank_txn_id   varchar(64) UNIQUE,                 -- กัน callback ซ้ำ
  staff_id      uuid,
  result        varchar(10) NOT NULL,               -- PAID / MISMATCH / REFUND
  raw           jsonb,
  paid_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- เลขใบเสร็จรันต่อเนื่องรายปีงบประมาณ (ล็อกแถวใน transaction ไม่ข้าม/ไม่ซ้ำ)
CREATE TABLE receipt_counters (
  year integer PRIMARY KEY,
  last integer NOT NULL DEFAULT 0
);

-- ใบเสร็จแยกตามบัญชีผู้ชำระ
CREATE TABLE receipts (
  receipt_no    varchar(20) PRIMARY KEY,
  payer_id      uuid NOT NULL REFERENCES payers(id),
  order_id      uuid NOT NULL REFERENCES orders(id),
  payment_id    uuid NOT NULL REFERENCES payments(id),
  amount_satang integer NOT NULL,
  method        varchar(5) NOT NULL,
  staff_id      uuid,
  paid_at       timestamptz NOT NULL,
  voided_at     timestamptz,
  void_reason   text
);
CREATE INDEX ON receipts(payer_id);

CREATE TABLE receipt_items (
  receipt_no    varchar(20) NOT NULL REFERENCES receipts(receipt_no),
  invoice_id    uuid NOT NULL UNIQUE REFERENCES invoices(id),   -- 1 งวดออกใบเสร็จได้ครั้งเดียว
  period        varchar(7) NOT NULL,
  amount_satang integer NOT NULL,
  PRIMARY KEY (receipt_no, invoice_id)
);

CREATE TABLE staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  role        varchar(10) NOT NULL CHECK (role IN ('ADMIN','CASHIER','VIEWER')),
  token_hash  char(64) NOT NULL UNIQUE,             -- sha256 ของ token (ไม่เก็บ token จริง)
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE audit_logs (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text NOT NULL,
  meta    jsonb
);

-- audit log ห้ามแก้/ลบ
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
