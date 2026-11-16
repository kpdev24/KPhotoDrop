# PhotoDrop Event Gallery System by KPDev.

ดาวน์โหลดภาพถ่ายกิจกรรมความคมชัดสูง ผ่านการสแกน QR Code

Google Apps Script + Google Drive (ไฟล์ต้นฉบับไม่ลดขนาด) + Google Sheets + Tailwind CSS (ธีมมืด ส้ม-ขาว, Mobile-First)

## ฟีเจอร์
- **ผู้ใช้ทั่วไป**: ดูอัลบั้ม, กรองภาพนิ่ง/วิดีโอ, Lightbox, ดาวน์โหลดต้นฉบับ, **ดาวน์โหลดทั้งอัลบั้มเป็น ZIP**, แชร์ LINE/Facebook/Email/Copy Link
- **QR Code 2 แบบ**: QR รวมทุกอัลบั้ม และ QR เฉพาะอัลบั้ม (พิมพ์ / บันทึก PNG)
- **ค้นหาภาพของฉัน (AI)**: ผู้ใช้อัปโหลดเซลฟี่ 1 ภาพ ระบบหาภาพที่มีใบหน้าตรงกันในอัลบั้ม (ประมวลผลในเบราว์เซอร์, แอดมินกด 🙂 สร้างดัชนีล่วงหน้าได้)
- **ทีมงาน**: อัปโหลด JPG/PNG/MP4/MOV หลายไฟล์, ลบไฟล์, แชร์ลิงก์, เปลี่ยนรหัสผ่าน
- **แอดมิน**: จัดการอัลบั้ม + ตั้งช่วงวันแสดงผล + เปิด/ซ่อน, จัดการสมาชิก (SHA-256, ระงับ, รีเซ็ตรหัส), ตั้งค่า Drive Folder ID

## ไฟล์
| ไฟล์ | หน้าที่ |
|---|---|
| `Code.gs` | Backend: Drive, Sheets, Auth, Upload, ZIP |
| `Index.html` | Frontend UI ภาษาไทย |

## ลิงก์ใช้งาน
https://kpdev24.github.io/KPhotoDrop/ (`docs/index.html` ฝังเว็บแอป Apps Script)

ถ้า Deploy ใหม่จนได้ลิงก์ `/exec` ใหม่ ให้แก้ค่า `EXEC` ใน `docs/index.html`

## ติดตั้ง
1. สร้าง Google Sheet ใหม่ → ส่วนขยาย → Apps Script
2. วาง `Code.gs` และสร้างไฟล์ HTML ชื่อ `Index` วาง `Index.html`
3. Deploy → Web app: Execute as **Me**, Who has access **Anyone**
4. เข้าระบบ `admin` / `456789` แล้ว **เปลี่ยนรหัสผ่านทันที**
5. เมนูตั้งค่าระบบ → ใส่ Drive Folder ID หลัก → ทดสอบการเชื่อมต่อ → บันทึก

## ข้อจำกัด
- อัปโหลดผ่านเว็บไฟล์ละไม่เกิน ~45MB (ไฟล์ใหญ่กว่านั้นอัปเข้าโฟลเดอร์ Drive ของอัลบั้มโดยตรงได้ จะแสดงในแกลเลอรีอัตโนมัติ)
- ZIP แบ่งส่วนละ ~35MB อัตโนมัติ (ลิมิตการส่งข้อมูลของ Apps Script)
