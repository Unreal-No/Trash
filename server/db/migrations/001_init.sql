-- ระบบค่าธรรมเนียมขยะเทศบาล — PostgreSQL 16 / PGlite

-- การตั้งค่าระบบ (ข้อมูลเทศบาล, เปิด/ปิดแผนที่, อัตราเริ่มต้น, รายชื่อชุมชน ฯลฯ)
CREATE TABLE settings (
  key        varchar(50) PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- ทะเบียนบ้าน/สถานที่จัดเก็บ (1 หลัง = 1 บัญชีผู้ชำระ)
CREATE TABLE houses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           varchar(20) NOT NULL UNIQUE,       -- รหัสผู้ชำระ
  house_no       varchar(20) NOT NULL,              -- บ้านเลขที่ (ค้นหาแบบตรงตัว)
  moo            varchar(10),
  soi            varchar(100),
  road           varchar(100),
  community      varchar(100),
  subdistrict    varchar(100) NOT NULL,             -- ตำบล
  owner_name_enc text,                              -- AES-256-GCM (PDPA)
  phone_enc      text,
  category       varchar(12) NOT NULL DEFAULT 'RESIDENTIAL' CHECK (category IN ('RESIDENTIAL','COMMERCIAL')),
  rate_satang    integer NOT NULL DEFAULT 0 CHECK (rate_satang >= 0),
  lat            double precision,
  lng            double precision,
  active         boolean NOT NULL DEFAULT true,
  verified       boolean NOT NULL DEFAULT false,    -- ผ่านการตรวจสอบโดยหัวหน้า
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);
CREATE INDEX houses_house_no ON houses(house_no);
CREATE INDEX houses_area ON houses(subdistrict, community, road, soi);

-- ประวัติการแก้ไขทะเบียนบ้าน + คิวตรวจสอบ
CREATE TABLE house_changes (
  id          bigserial PRIMARY KEY,
  house_id    uuid NOT NULL REFERENCES houses(id),
  staff_id    uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  action      varchar(10) NOT NULL CHECK (action IN ('CREATE','UPDATE')),
  before      jsonb,
  after       jsonb NOT NULL,
  status      varchar(10) NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','AUTO')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text
);
CREATE INDEX house_changes_pending ON house_changes(status) WHERE status = 'PENDING';

-- 1 LINE ผูกได้หลายบ้าน / 1 บ้านมีหลาย LINE ได้
CREATE TABLE line_links (
  line_user_id    varchar(64) NOT NULL,
  house_id        uuid NOT NULL REFERENCES houses(id),
  label           varchar(30) NOT NULL,
  consent_version varchar(20) NOT NULL,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line_user_id, house_id)
);
CREATE INDEX line_links_house ON line_links(house_id);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    varchar(20) NOT NULL UNIQUE,        -- สุ่ม เดาไม่ได้
  house_id      uuid NOT NULL REFERENCES houses(id),
  period        varchar(7) NOT NULL,                -- 2569-11 (พ.ศ.)
  amount_satang integer NOT NULL CHECK (amount_satang > 0),
  status        varchar(10) NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PAID','CANCELLED')),
  due_date      date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (house_id, period)
);
CREATE INDEX invoices_period ON invoices(period, status);

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no      varchar(20) NOT NULL UNIQUE,        -- Ref1 ใน Thai QR
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

CREATE TABLE receipt_counters (
  year integer PRIMARY KEY,
  last integer NOT NULL DEFAULT 0
);

CREATE TABLE receipts (
  receipt_no    varchar(20) PRIMARY KEY,
  house_id      uuid NOT NULL REFERENCES houses(id),
  order_id      uuid NOT NULL REFERENCES orders(id),
  payment_id    uuid NOT NULL REFERENCES payments(id),
  amount_satang integer NOT NULL,
  method        varchar(5) NOT NULL,
  staff_id      uuid,
  paid_at       timestamptz NOT NULL,
  voided_at     timestamptz,
  void_reason   text
);
CREATE INDEX receipts_house ON receipts(house_id);
CREATE INDEX receipts_paid_at ON receipts(paid_at);

CREATE TABLE receipt_items (
  receipt_no    varchar(20) NOT NULL REFERENCES receipts(receipt_no),
  invoice_id    uuid NOT NULL UNIQUE REFERENCES invoices(id),
  period        varchar(7) NOT NULL,
  amount_satang integer NOT NULL,
  PRIMARY KEY (receipt_no, invoice_id)
);

-- เจ้าหน้าที่ + สิทธิ์
CREATE TABLE staff_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        varchar(50) NOT NULL UNIQUE,
  name            varchar(100) NOT NULL,
  role            varchar(12) NOT NULL CHECK (role IN ('ADMIN','SUPERVISOR','CASHIER','SURVEYOR','VIEWER')),
  password_hash   text NOT NULL,                    -- scrypt
  active          boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  token_hash char(64) PRIMARY KEY,                  -- sha256 ของ token
  user_id    uuid NOT NULL REFERENCES staff_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  actor  text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  meta   jsonb
);
CREATE INDEX audit_logs_at ON audit_logs(at DESC)
