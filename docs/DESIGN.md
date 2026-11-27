# ระบบชำระค่าขยะเทศบาลผ่าน LINE OA — เอกสารออกแบบ

## 1. ขอบเขต (Requirements)

**ผู้ใช้ (ประชาชน) ผ่าน LINE OA / LIFF**
- 1 LINE ผูกได้หลายบัญชี (สูงสุด 20): บ้านตัวเอง, บ้านคนอื่น (จ่ายแทน), เจ้าของหลายหลัง, ร้านค้า — ตั้งชื่อเรียกเองได้ เช่น "บ้านแม่"
- 1 บัญชีผูกได้หลาย LINE (เจ้าของ/ญาติ/ผู้เช่า) → ใบเสร็จส่งถึงทุกคนที่ผูก
- ยืนยันการผูกด้วย รหัสผู้ชำระ + เลขที่ใบแจ้งหนี้ (เลขสุ่ม เดาไม่ได้ พิมพ์บนใบแจ้งหนี้/ขอที่เคาน์เตอร์)
- ประเภทบัญชี: ที่อยู่อาศัย / ร้านค้า-กิจการ (อัตรารายเดือนต่างกัน กำหนดรายบัญชี)
- เลือกจ่าย: งวดที่ค้าง (เลือกเป็นรายเดือน), ทั้งปีงบประมาณปัจจุบัน, ล่วงหน้าทั้งปีถัดไป — รวมหลายบ้านได้ใน **QR เดียว**
- เลือกวิธีชำระ: (1) Thai QR (PromptPay Bill Payment) (2) Mobile Banking (3) เงินสดที่เคาน์เตอร์ (เลือกงวด/ทั้งปีได้เหมือนกัน)
- รับใบเสร็จดิจิทัลอัตโนมัติใน LINE (Flex Message + ลิงก์ PDF/ตรวจสอบ QR)
- แจ้งเตือนใบแจ้งหนี้/ค้างชำระ

**เจ้าหน้าที่ (Back-office เว็บ)**
- จัดการผู้ชำระ อัตราค่าธรรมเนียม ออกใบแจ้งหนี้รายเดือน/รายปี (batch)
- เคาน์เตอร์รับเงินสด → ออกใบเสร็จทันที (พิมพ์ + ส่ง LINE)
- กระทบยอด (Reconciliation) กับ statement ธนาคารรายวัน
- รายงาน: รายวัน/รายเดือน, ค้างชำระ, ยกเลิกใบเสร็จ (ต้องมีผู้อนุมัติ)

**Non-functional**: ผู้ใช้ ~5k–50k ครัวเรือน, peak ช่วงต้นเดือน, ความพร้อม 99.5%, ค่าใช้จ่ายต่ำ, PDPA

## 2. สถาปัตยกรรม

```
 ประชาชน ── LINE App ── LINE OA (Messaging API) ──webhook──┐
              └─ LIFF (เว็บในไลน์) ─────────── HTTPS ──────┤
 เจ้าหน้าที่ ── Back-office Web (counter/report) ─────────────┤
                                                           ▼
                                              ┌─────────────────────┐
 ธนาคาร (Biller) ──payment callback (HMAC)──▶ │   API Server (Node) │──▶ PostgreSQL (เข้ารหัสฟิลด์)
      ▲         ◀── inquiry / verify ──────── │  - billing          │──▶ Object storage (PDF ใบเสร็จ)
      └─ statement SFTP (กระทบยอดรายวัน) ───▶ │  - payment          │──▶ LINE push (ใบเสร็จ)
                                              │  - receipt          │
                                              └─────────────────────┘
```

## 3. การชำระเงิน — หลักการสำคัญ

ใช้ **Thai QR Payment แบบ Bill Payment (Tag 30)** ไม่ใช่ PromptPay เบอร์/บัตร (Tag 29)
- เทศบาลสมัคร **Biller ID** กับธนาคาร (เช่น KTB/กรุงไทย ที่ อปท. ใช้ทั่วไป, หรือ KBank/SCB)
- ทุกครั้งที่กดจ่ายจะสร้าง **คำสั่งชำระ (order)** รวมหลายงวด/หลายบัญชี → QR มี `Ref1 = เลขคำสั่งชำระ` (สุ่ม 12 ตัว) + ยอดรวมตายตัว
- ธนาคารส่ง **callback** พร้อม Ref1 → ปิดทุกงวดใน order พร้อมกัน (atomic) → ออก **ใบเสร็จแยกตามบัญชี** (บ้านละ 1 ใบ)
- จ่ายทั้งปี: ระบบสร้างใบแจ้งหนี้ที่ยังไม่ออกของปีงบประมาณนั้นให้อัตโนมัติ (ตามอัตราของบัญชี)
- Tag 29 (เบอร์ PromptPay) ไม่มี callback → ต้องตรวจสลิปเอง ไม่แนะนำ

| ช่องทาง | การยืนยันสถานะ |
|---|---|
| Thai QR Bill Payment | Bank callback (real-time) + กระทบยอดรายวัน |
| Mobile Banking / Deeplink | API ธนาคาร (เช่น KBank/SCB Open API) callback |
| เงินสดเคาน์เตอร์ | เจ้าหน้าที่บันทึก → ออกใบเสร็จทันที |

**ความถูกต้องของเงิน**
- callback ตรวจ HMAC-SHA256 + timestamp (กัน replay ±5 นาที) + IP allowlist
- Idempotent ด้วย `bank_txn_id` (unique) — callback ซ้ำไม่ออกใบเสร็จซ้ำ
- ยอดต้องตรงกับใบแจ้งหนี้ ไม่ตรง → สถานะ `MISMATCH` ให้เจ้าหน้าที่ตรวจ
- เก็บจำนวนเงินเป็น **สตางค์ (integer)** ไม่ใช้ float
- กระทบยอดรายวันกับ statement ธนาคาร → รายการที่หลุด callback จะถูกเติม

**สถานะ**: ใบแจ้งหนี้ `UNPAID → PAID` / `CANCELLED` · คำสั่งชำระ `OPEN → PAID` / `MISMATCH` (ยอดไม่ตรง) / `REFUND` (มีงวดถูกจ่ายไปแล้วจาก QR อื่น → เจ้าหน้าที่คืนเงิน)

## 4. ใบเสร็จดิจิทัล
- เลขที่ใบเสร็จรันต่อเนื่องตามปีงบประมาณ (`R2569-000001`) — ห้ามข้าม/ซ้ำ (DB sequence ภายใน transaction)
- ส่ง Flex Message เข้า LINE ของผู้ชำระทันทีหลังชำระ
- มีลิงก์ตรวจสอบ `/r/{receipt_no}?sig=...` (HMAC กันปลอม) และ PDF
- ยกเลิกใบเสร็จได้โดยออกเอกสารยกเลิก ไม่ลบข้อมูล (audit)
- (เฟส 2) e-Receipt ตามมาตรฐานกรมบัญชีกลาง/ลงลายมือชื่อดิจิทัล

## 5. PDPA / ความเป็นส่วนตัว
- เก็บเท่าที่จำเป็น: ชื่อ, ที่อยู่จัดเก็บ, เบอร์โทร, LINE userId — **ไม่เก็บเลขบัตรประชาชน** ถ้าไม่จำเป็น
- ฟิลด์อ่อนไหว (เบอร์โทร/ชื่อ) เข้ารหัส **AES-256-GCM** ระดับแอป, ค้นหาด้วย HMAC blind index
- บันทึกความยินยอม (consent) + เวอร์ชันนโยบาย, ผู้ใช้ยกเลิกผูก LINE ได้เอง
- ใน LINE แสดงข้อมูลแบบ mask (`08x-xxx-1234`, `น*** ใ***`) — ผู้ที่ผูกบ้านคนอื่นเห็นเฉพาะข้อมูลที่ปิดบังแล้ว
- ใบเสร็จ Flex ไม่มีชื่อเต็ม แสดงเฉพาะรหัสและบ้านเลขที่
- Back-office: RBAC (ADMIN / CASHIER / VIEWER), audit log ทุกการดู/แก้ไขข้อมูลส่วนบุคคล
- HTTPS เท่านั้น, secrets ใน env/secret manager, ข้อมูลอยู่ในไทย (cloud region TH หรือ server เทศบาล)
- ระยะเวลาเก็บ: ข้อมูลการเงินตามระเบียบ (10 ปี), log เข้าถึง 1 ปี

## 6. Data Model (ย่อ)
ดู `server/db/schema.sql` — `payers` (1 บัญชี = 1 สถานที่, category, rate), `line_links` (LINE↔บัญชี หลายต่อหลาย + label), `invoices`, `orders` + `order_items`, `payments`, `receipts` + `receipt_items`, `staff`, `audit_logs`

## 7. API
| Method | Path | ผู้ใช้ |
|---|---|---|
| POST | `/webhook/line` | LINE platform (ตรวจ `x-line-signature`) |
| GET/POST/DELETE | `/api/liff/accounts[/:code]` | ดู/ผูก/ยกเลิกบัญชี |
| POST | `/api/liff/quote` | คำนวณยอด `{invoiceIds, years:[{payerCode,fiscalYear}]}` |
| POST | `/api/liff/orders` | สร้างคำสั่งชำระ + Thai QR |
| GET | `/api/liff/orders/:no` | สถานะ (polling) |
| GET | `/api/liff/receipts` | ใบเสร็จทุกบัญชี |
| POST | `/api/bank/callback` | ธนาคาร (HMAC) |
| GET | `/api/staff/payers/:code` | เจ้าหน้าที่ค้นหา |
| POST | `/api/staff/quote`, `/api/staff/counter/pay` | รับเงินสด (รายงวด/ทั้งปี) |
| GET | `/r/:receiptNo` | ตรวจสอบใบเสร็จ |

LIFF ยืนยันตัวตนด้วย **LINE ID token** ตรวจกับ `https://api.line.me/oauth2/v2.1/verify` ฝั่ง server (ไม่เชื่อ userId จาก client)

## 8. Tech Stack (ต้นทุนต่ำ ดูแลง่าย)
- Node.js 22 + TypeScript + Express, PostgreSQL 16
- LIFF (HTML/JS), Back-office (HTML/JS หรือ React เฟส 2)
- Deploy: Docker บน server เทศบาล หรือ Cloud region ไทย

## 9. แผนพัฒนา
| เฟส | งาน | ระยะ |
|---|---|---|
| 0 | ติดต่อธนาคารขอ Biller ID + spec callback, สร้าง LINE OA/LIFF, ร่างนโยบาย PDPA | 2–4 สัปดาห์ (คู่ขนาน) |
| 1 MVP | ผูกบัญชี, ดูยอด, Thai QR, callback, เคาน์เตอร์เงินสด, ใบเสร็จ LINE | 4–6 สัปดาห์ |
| 2 | Back-office เต็ม, รายงาน, กระทบยอด statement, PDF, แจ้งเตือนค้างชำระ | 4 สัปดาห์ |
| 3 | Deeplink Mobile Banking, e-Receipt ลายมือชื่อดิจิทัล, Dashboard ผู้บริหาร | 4 สัปดาห์ |

## 10. สิ่งที่ต้องได้จากธนาคาร (blocker)
- Biller ID + Suffix, รูปแบบ callback (field, การเซ็น), IP ต้นทาง, sandbox
- ไฟล์ statement รายวัน (format/ช่องทาง)
- `server/src/bank/adapter.ts` ออกแบบเป็น adapter — เปลี่ยนธนาคารแก้ไฟล์เดียว

## 11. ความเสี่ยง / ทบทวนเมื่อระบบโต
- callback หาย → กระทบยอดรายวันเป็นตัวกันพลาด
- หลายธนาคาร → เพิ่ม adapter ต่อธนาคาร
- ปริมาณสูง → ใส่ queue (เช่น Redis/BullMQ) ระหว่าง callback กับการส่ง LINE
