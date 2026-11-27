-- PostgreSQL 16 — ระบบค่าขยะเทศบาล
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE payers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(20) NOT NULL UNIQUE,          -- Ref1
  name_enc     text NOT NULL,                        -- AES-256-GCM (PDPA)
  address_enc  text NOT NULL,
  phone_enc    text,
  rate_satang  integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_links (
  line_user_id    varchar(64) PRIMARY KEY,
  payer_id        uuid NOT NULL REFERENCES payers(id),
  consent_version varchar(20) NOT NULL,
  linked_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON line_links(payer_id);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    varchar(20) NOT NULL,               -- Ref2
  payer_id      uuid NOT NULL REFERENCES payers(id),
  period        varchar(10) NOT NULL,               -- 2569-11
  amount_satang integer NOT NULL CHECK (amount_satang > 0),
  status        varchar(10) NOT NULL DEFAULT 'UNPAID'
                CHECK (status IN ('UNPAID','PENDING','PAID','MISMATCH','CANCELLED')),
  due_date      date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payer_id, invoice_no),
  UNIQUE (payer_id, period)
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  method        varchar(5) NOT NULL CHECK (method IN ('QR','BANK','CASH')),
  amount_satang integer NOT NULL,
  bank_txn_id   varchar(64) UNIQUE,                 -- กัน callback ซ้ำ
  staff_id      uuid,
  result        varchar(10) NOT NULL,               -- PAID / MISMATCH / LATE
  raw           jsonb,
  paid_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- เลขใบเสร็จรันต่อเนื่องรายปีงบประมาณ (ล็อกแถวใน transaction ไม่ข้าม/ไม่ซ้ำ)
CREATE TABLE receipt_counters (
  year integer PRIMARY KEY,
  last integer NOT NULL DEFAULT 0
);

CREATE TABLE receipts (
  receipt_no    varchar(20) PRIMARY KEY,
  invoice_id    uuid NOT NULL UNIQUE REFERENCES invoices(id),
  payer_id      uuid NOT NULL REFERENCES payers(id),
  payment_id    uuid NOT NULL REFERENCES payments(id),
  amount_satang integer NOT NULL,
  method        varchar(5) NOT NULL,
  staff_id      uuid,
  paid_at       timestamptz NOT NULL,
  voided_at     timestamptz,
  void_reason   text
);
CREATE INDEX ON receipts(payer_id);

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
