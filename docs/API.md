# API Reference

เงินเป็น **สตางค์ (integer)** ทุกจุด · งวด `YYYY-MM` เป็น **พ.ศ.** (เช่น `2569-11`) · ข้อผิดพลาดตอบ `{ "error": "<ข้อความภาษาไทย>" }`

`payStatus` ของบ้าน: `PAID` ไม่มียอดค้าง · `DUE` ค้างแต่ยังไม่เลยกำหนด · `OVERDUE` มีงวดเลยกำหนด · `NONE` ยังไม่มีใบแจ้งหนี้

## สิทธิ์เจ้าหน้าที่ (role → permission)

| permission | ADMIN | SUPERVISOR | CASHIER | SURVEYOR | VIEWER |
|---|---|---|---|---|---|
| `house.read` ค้นหา/ดูทะเบียนบ้าน | ✔ | ✔ | ✔ | ✔ | ✔ |
| `house.write` เพิ่ม/แก้ไข/สำรวจ/ปักหมุด | ✔ | ✔ | | ✔ | |
| `house.verify` ตรวจสอบ/อนุมัติข้อมูล | ✔ | ✔ | | | |
| `payment.cash` รับชำระเงินสด | ✔ | | ✔ | | |
| `dashboard.read` Dashboard | ✔ | ✔ | ✔ | | ✔ |
| `map.read` แผนที่ (ถ้าเปิดในตั้งค่า) | ✔ | ✔ | ✔ | ✔ | ✔ |
| `report.read` รายงาน/ส่งออก | ✔ | ✔ | | | ✔ |
| `audit.read` บันทึกการใช้งาน | ✔ | ✔ | | | |
| `billing.manage` ออกใบแจ้งหนี้ประจำงวด | ✔ | | | | |
| `user.manage` จัดการผู้ใช้/สิทธิ์ | ✔ | | | | |
| `settings.manage` ตั้งค่าระบบ | ✔ | | | | |

เมื่อผู้ไม่มี `house.verify` แก้ไขข้อมูลบ้าน ข้อมูลจะถูกบันทึกทันทีแต่บ้านจะถูกตั้งเป็น "รอตรวจสอบ" (`verified=false`) และเข้าคิวตรวจสอบ หัวหน้าอนุมัติหรือปฏิเสธ (ปฏิเสธ = ย้อนข้อมูลกลับ)

## Public
| | | |
|---|---|---|
| GET | `/api/config` | `{liffId, demo, municipality:{name,address,phone,officeHours}, features:{liffHouseSearch}}` |
| GET | `/api/public/address-options` | `{subdistricts[], communities[], roads[], sois[]}` |
| GET | `/r/:receiptNo?sig=` | หน้าตรวจสอบใบเสร็จ |

## LIFF (ประชาชน) — `Authorization: Bearer <LINE ID token>`
| | | |
|---|---|---|
| GET | `/api/liff/houses/search?houseNo=3&moo=&soi=&road=&community=&subdistrict=` | ต้องมี `houseNo` · ตรงตัวเท่านั้น (`3` ไม่เจอ `13`, `3/1`) · สูงสุด 20 → `{items:[{code,houseNo,moo,soi,road,community,subdistrict,address,ownerMasked,category}]}` |
| GET | `/api/liff/accounts` | `{accounts:[{code,label,category,rateSatang,nameMasked,address,invoices:[{id,invoiceNo,period,amountSatang,status,dueDate}]}], currentFiscalYear}` |
| POST | `/api/liff/accounts` | `{payerCode, invoiceNo, label, consent:true}` ผูกบ้าน |
| DELETE | `/api/liff/accounts/:code` | ยกเลิกผูก |
| POST | `/api/liff/quote` | `{invoiceIds[], years:[{payerCode,fiscalYear}]}` → `{amountSatang, items:[{invoiceId,payerCode,label,period,amountSatang}]}` |
| POST | `/api/liff/orders` | เหมือน quote → `{orderNo, amountSatang, items, payload, qrDataUrl, expiresAt}` |
| GET | `/api/liff/orders/:orderNo` | `{orderNo, status:'OPEN'|'PAID'|'MISMATCH'|'REFUND', amountSatang}` |
| GET | `/api/liff/receipts` | `{receipts:[{receiptNo,payerCode,label,amountSatang,paidAt,method,periods[],verifyUrl}]}` |

## เจ้าหน้าที่ — `Authorization: Bearer <session token>`
### เข้าสู่ระบบ
| | | |
|---|---|---|
| POST | `/api/staff/login` | `{username,password}` → `{token, expiresAt, user:{id,username,name,role,permissions[]}}` · ผิด 5 ครั้งล็อก 15 นาที |
| POST | `/api/staff/logout` | |
| GET | `/api/staff/me` | `{user, settings:{municipality, features, map}}` |

### ทะเบียนบ้าน
`House` = `{id, code, houseNo, moo, soi, road, community, subdistrict, address, ownerName, phone, category, rateSatang, lat, lng, active, verified, note, outstandingSatang, overdueCount, payStatus, updatedAt, updatedBy}`

| | | |
|---|---|---|
| GET | `/api/staff/houses?houseNo=&moo=&soi=&road=&community=&subdistrict=&category=&payStatus=&verified=&q=&page=1&pageSize=50` | `houseNo` ตรงตัว, ช่องอื่นตรงตัว, `q` ค้นรหัส/ชื่อเจ้าของบางส่วน → `{items:[House], total, page, pageSize}` |
| GET | `/api/staff/houses/:id` | `{house, invoices[], receipts:[{receiptNo,amountSatang,method,paidAt,periods[]}], lineLinks, changes:[{id,at,action,staffName,status,diff:[{field,before,after}]}]}` |
| POST | `/api/staff/houses` | `{houseNo*, subdistrict*, moo, soi, road, community, ownerName, phone, category, rateSatang, lat, lng, note, active, code}` (`code` ว่าง = สร้างอัตโนมัติ, `rateSatang` ว่าง = อัตราเริ่มต้นตามประเภท) → `{house, changeStatus:'AUTO'|'PENDING'}` |
| PUT | `/api/staff/houses/:id` | ฟิลด์ใดก็ได้จากข้างบน → เหมือน POST |
| GET | `/api/staff/address-options` | `{subdistricts[], communities[], roads[], sois[], moos[]}` |
| GET | `/api/staff/reviews` | `{items:[{id,houseId,code,houseNo,address,action,at,staffName,diff[]}]}` |
| POST | `/api/staff/reviews/:id` | `{decision:'APPROVE'|'REJECT', note}` |

### การเงิน
| | | |
|---|---|---|
| GET | `/api/staff/payers/:code` | `{payer:{code,name,address,category,rateSatang}, invoices[], currentFiscalYear}` |
| POST | `/api/staff/quote` | `{invoiceIds[], years[]}` → `{amountSatang, items[]}` |
| POST | `/api/staff/counter/pay` | `{invoiceIds[], years[], receivedSatang}` → `{receipts:[{receiptNo,payerCode,amountSatang,periods[],verifyUrl}], amountSatang, changeSatang, lineNotified}` |
| POST | `/api/staff/billing/generate` | `{period}` ออกใบแจ้งหนี้ทุกบ้านที่ active และมีอัตรา → `{created, skipped}` |

### Dashboard / แผนที่ / รายงาน
| | | |
|---|---|---|
| GET | `/api/staff/dashboard?fy=2570` | `{fy, houses:{total,active,residential,commercial,verified,pendingReview,withLocation}, billing:{invoicedSatang,paidSatang,outstandingSatang,collectionRate}, payStatus:{PAID,DUE,OVERDUE,NONE}, monthly:[{period,invoicedSatang,paidSatang}], byMethod:{QR,BANK,CASH}, byCommunity:[{community,houses,paid,due,overdue,outstandingSatang}], topDebtors:[{id,code,address,outstandingSatang,overdueCount}], recentPayments:[{receiptNo,code,address,amountSatang,method,paidAt}]}` |
| GET | `/api/staff/map?community=&payStatus=` | `{center:{lat,lng,zoom}, showStatus, points:[{id,code,address,community,category,lat,lng,payStatus,outstandingSatang}]}` · ปิดในตั้งค่า → 403 `MAP_DISABLED` |
| GET | `/api/staff/reports/outstanding.csv` | CSV (UTF-8 BOM เปิดใน Excel ได้) |
| GET | `/api/staff/audit?limit=200` | `{items:[{at,actor,action,target}]}` |

### ผู้ใช้ / ตั้งค่า (ADMIN)
| | | |
|---|---|---|
| GET | `/api/staff/users` | `{items:[{id,username,name,role,active,lastLoginAt,locked}]}` |
| POST | `/api/staff/users` | `{username,name,role,password}` (รหัสผ่าน ≥ 8 ตัว) |
| PUT | `/api/staff/users/:id` | `{name?,role?,active?,password?}` |
| GET | `/api/staff/settings` | `{municipality, features:{mapEnabled,mapShowStatus,liffHouseSearch}, map:{lat,lng,zoom}, rates:{RESIDENTIAL,COMMERCIAL}, areas:{subdistricts[],communities[],roads[],sois[]}}` |
| PUT | `/api/staff/settings` | ส่งเฉพาะส่วนที่แก้ เช่น `{features:{mapEnabled:false}}` |

### ธนาคาร
| | | |
|---|---|---|
| POST | `/api/bank/callback` | header `x-bank-timestamp`, `x-bank-signature` = hex HMAC-SHA256(secret, `ts.rawBody`) · body `{txnId,billerId,ref1,amount,paidAt,channel}` |
