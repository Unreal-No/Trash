# ระบบชำระค่าขยะเทศบาลผ่าน LINE OA

ชำระผ่าน **Thai QR (PromptPay Bill Payment)** / Mobile Banking / **เงินสดที่เคาน์เตอร์** → ธนาคาร callback อัปเดตสถานะอัตโนมัติ → ส่ง **ใบเสร็จดิจิทัล** เข้า LINE

- ออกแบบ/แผนงาน/PDPA: [docs/DESIGN.md](docs/DESIGN.md)
![ภาพรวมการใช้งาน](docs/screens/overview.png)

- Backend: `server/` (Node 22 + TypeScript + Express + PostgreSQL)
- หน้า LIFF ประชาชน: `/liff/` · หน้าเคาน์เตอร์: `/staff/` · นโยบายความเป็นส่วนตัว: `/privacy.html`

## ติดตั้งในเครื่อง (โหมดสาธิต ไม่ต้องมีฐานข้อมูล) — Windows / macOS / Linux
1. ติดตั้ง [Node.js 22 LTS](https://nodejs.org) (22.18 ขึ้นไป) และ [Git](https://git-scm.com)
2. เปิด Terminal / PowerShell แล้วรัน
```bash
git clone -b claude/vigilant-rubin-46m06v https://github.com/Unreal-No/Trash.git
cd Trash/server
npm install
npm run demo
```
3. เปิดเบราว์เซอร์
   - หน้าประชาชน (จำลอง LINE): http://localhost:3000/liff/ — ผูกด้วย `A0001`/`INV256911001`, `A0002`/`INV256911002`, `B0001`/`INV256911003` (ร้านค้า)
   - หน้าเคาน์เตอร์: http://localhost:3000/staff/ — token `demo-cashier`

ข้อมูลโหมดสาธิตอยู่ในหน่วยความจำ ปิดโปรแกรมแล้วหาย (กด Ctrl+C เพื่อปิด)

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
