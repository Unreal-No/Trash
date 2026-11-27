# ระบบชำระค่าขยะเทศบาลผ่าน LINE OA

ชำระผ่าน **Thai QR (PromptPay Bill Payment)** / Mobile Banking / **เงินสดที่เคาน์เตอร์** → ธนาคาร callback อัปเดตสถานะอัตโนมัติ → ส่ง **ใบเสร็จดิจิทัล** เข้า LINE

- ออกแบบ/แผนงาน/PDPA: [docs/DESIGN.md](docs/DESIGN.md)
![ภาพรวมการใช้งาน](docs/screens/overview.png)

- Backend: `server/` (Node 22 + TypeScript + Express + PostgreSQL)
- หน้า LIFF ประชาชน: `/liff/` · หน้าเคาน์เตอร์: `/staff/` · นโยบายความเป็นส่วนตัว: `/privacy.html`

## ทดลอง (โหมดสาธิต ไม่ต้องมี DB)
```bash
cd server && npm install && npm run dev
```
เปิด `http://localhost:3000/staff/` token `demo-cashier` ค้นหา `A0001`

## ทดสอบ
```bash
cd server && npm test
```

## Production
1. ขอ Biller ID + spec callback จากธนาคาร → ปรับ `server/src/bank/adapter.ts`
2. สร้าง LINE OA (Messaging API) + LINE Login channel + LIFF (endpoint `https://<domain>/liff/`)
3. ตั้ง webhook `https://<domain>/webhook/line`
4. `cp server/.env.example server/.env` กรอกค่า แล้ว `DB_PASSWORD=... docker compose up -d`
5. เพิ่มเจ้าหน้าที่: `INSERT INTO staff(name, role, token_hash) VALUES ('ชื่อ','CASHIER', encode(sha256('<token>'),'hex'));`
