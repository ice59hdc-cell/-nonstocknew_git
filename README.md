# Dashboard มูลค่ายาคงคลัง

Node 22+ (ใช้ `node:sqlite` ในตัว ไม่ต้อง npm install) · ข้อมูลอยู่ใน `data.db` (SQLite)

    node server.js        # เปิด http://localhost:3000
    python -I import_xlsx.py "../nonstcoknara2027 .xlsx" data.db   # นำเข้า Excel ใหม่ (ล้างข้อมูลเดิม)

API: `GET/POST /api/<table>`, `GET/PUT/DELETE /api/<table>/<id>` — table: units, transactions, insights, lessons, kpi_targets

## ล็อกอิน / สิทธิ์
- เริ่มเซิร์ฟเวอร์ครั้งแรกจะสร้าง `admin` พร้อมรหัสผ่านสุ่ม แสดงในหน้าจอที่รัน (หรือกำหนดเองด้วย env `ADMIN_PASSWORD`)
- เพิ่ม/เปลี่ยนผู้ใช้: `node adduser.js <user> <password> [admin|viewer]` — viewer ดูได้อย่างเดียว
- ส่งออก CSV (เปิดใน Excel ได้): `/api/export/<table>.csv`

## จัดการผู้ใช้ และ Master Prompt
- เมนู "จัดการผู้ใช้" (เฉพาะ admin): เพิ่ม/เปลี่ยนสิทธิ์/ตั้งรหัสผ่านใหม่/ลบ — ป้องกันการลบหรือลดสิทธิ์ admin คนสุดท้าย และลบบัญชีตัวเองไม่ได้
- เมนู "Master Prompt": สร้าง Prompt สรุปผู้บริหารจากข้อมูลบนหน้าสรุปผู้บริหารตามตัวกรอง แก้เทมเพลตได้ ตัวแปร: `{{ขอบเขต}} {{เกณฑ์ KPI}} {{ตัวชี้วัดหลัก}} {{ประเด็นสำคัญ}} {{อันดับอำเภอ}} {{หน่วยที่ต้องติดตาม}} {{หน่วยที่ยังไม่รายงาน}} {{Key Insights}}`
# -nonstocknew_git
