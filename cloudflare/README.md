# PhotoDrop บน Cloudflare (Workers + R2 + D1)

เร็วกว่า Apps Script มาก — ภาพส่งจากเซิร์ฟเวอร์ใกล้ผู้ใช้ ไม่มีเวลารอเริ่มทำงาน 1–2 วินาที
**QR Code และลิงก์เดิมใช้ได้ต่อ** (`https://kpdev24.github.io/KPhotoDrop/?album=...`) เพราะรหัสอัลบั้ม/ไฟล์เดิมถูกย้ายมาทั้งหมด

| ส่วน | ใช้ทำอะไร | ฟรี |
|---|---|---|
| Workers | หน้าเว็บ + API | 100,000 ครั้ง/วัน |
| R2 | เก็บไฟล์ภาพ/วิดีโอ | 10 GB, ไม่คิดค่าโหลดออก |
| D1 | ฐานข้อมูล (อัลบั้ม ผู้ใช้ สถิติ) | 5 GB |

## ขั้นตอนติดตั้ง (ผ่านหน้าเว็บ Cloudflare ไม่ต้องใช้คำสั่ง)
1. สมัคร https://dash.cloudflare.com (ฟรี)
2. **R2** → เปิดใช้ R2 (อาจต้องผูกบัตร แต่ไม่เสียเงินถ้าไม่เกินโควตาฟรี) → **Create bucket** ชื่อ `photodrop-files`
3. **Storage & Databases → D1** → **Create** ชื่อ `photodrop-db` → คัดลอก **Database ID** ใส่ใน `wrangler.toml` (`database_id`)
4. **Workers & Pages → Create → Import a repository** → เลือก GitHub `kpdev24/KPhotoDrop`
   - Root directory: `cloudflare`
   - Deploy command: `npx wrangler deploy` (ค่าเริ่มต้น)
5. เปิดลิงก์ `https://photodrop.<ชื่อบัญชี>.workers.dev` → เข้าระบบ `admin` / `456789`
   → เมนู ตั้งค่าระบบ จะเห็น **MIGRATE KEY**

## ย้ายข้อมูลจาก Google Drive
1. ใน Apps Script วาง `Code.gs` เวอร์ชันล่าสุด
2. ใส่ค่าด้านล่างไฟล์: `CF_WORKER_URL` (ลิงก์ workers.dev) และ `CF_MIGRATE_KEY`
3. เลือกฟังก์ชัน `migrateToCloudflare` → กด **Run** → อนุญาตสิทธิ์
4. ระบบทำต่อเองทุก 1 นาทีจนครบ — ดูความคืบหน้าในชีต **Migration**
   - ย้าย: อัลบั้ม อัลบั้มย่อย รหัสผ่าน ผู้ใช้ (รหัสผ่านเดิม) สถิติ ดัชนีใบหน้า ไฟล์ทั้งหมด (ไฟล์ > 45MB ต้องอัปโหลดใหม่ผ่านเว็บ)
   - รันซ้ำได้ ไฟล์ที่ย้ายแล้วจะถูกข้าม
5. ย้ายครบแล้ว → แก้ `docs/index.html` ให้ส่งต่อไป Worker (QR เดิมไม่ต้องพิมพ์ใหม่)

## หมายเหตุสำหรับนักพัฒนา
- หน้าเว็บใช้ `../Index.html` ไฟล์เดียวกับ Apps Script → `bash build.sh` สร้าง `public/index.html` (ใส่ shim แทน `google.script.run`)
- `tools/build-css.sh` ที่โฟลเดอร์หลักจะรัน `build.sh` ให้อัตโนมัติ
- ไฟล์ใน R2: `o/<id>` ต้นฉบับ, `t/<id>` ภาพย่อ 400px, `v/<id>` ภาพดู 1600px — ลิงก์ไฟล์ลงลายเซ็น อายุ 12 ชม. (อัลบั้มที่มีรหัสผ่านปลอดภัยกว่าเดิม)
- ZIP สตรีมจาก R2 แบบไม่บีบอัด ใช้ CRC ที่คำนวณไว้ตอนอัปโหลด (ไม่กิน CPU ของ Worker)
