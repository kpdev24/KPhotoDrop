#!/usr/bin/env bash
# สร้าง CSS ของ Tailwind ล่วงหน้า แล้วฝังลงใน Index.html (ระหว่าง TW:START / TW:END)
# ทำให้หน้าเว็บโหลดเร็วกว่าใช้ cdn.tailwindcss.com ที่ต้องคอมไพล์ในเบราว์เซอร์ทุกครั้ง
# ใช้: bash tools/build-css.sh   (ต้องมี Node.js — ติดตั้ง tailwindcss@3.4 อัตโนมัติ)
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > "$TMP/in.css"
printf 'module.exports={content:["%s/Index.html"],theme:{extend:{}},plugins:[]}\n' "$PWD" > "$TMP/tailwind.config.js"
npx -y tailwindcss@3.4 -c "$TMP/tailwind.config.js" -i "$TMP/in.css" -o "$TMP/out.css" --minify >/dev/null 2>&1
python3 - "$TMP/out.css" <<'PY'
import re, sys
css = open(sys.argv[1]).read()
css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)  # ตัดคอมเมนต์ /* */ ทิ้ง (Apps Script มีปัญหากับ /*)
s = open('Index.html').read()
a, b = '<!-- TW:START -->', '<!-- TW:END -->'
i, j = s.index(a) + len(a), s.index(b)
s = s[:i] + '\n<style>' + css + '</style>\n' + s[j:]
open('Index.html', 'w').write(s)
print('CSS', len(css)//1024, 'KB')
PY
rm -rf "$TMP"
# ตรวจรูปแบบที่ทำให้ Apps Script แปลงโค้ดผิด (หน้าเว็บว่าง)
python3 - <<'PY'
import re, sys
s = open('Index.html').read()
bad = []
if '/*' in s: bad.append('พบ "/*" ในไฟล์')
for js in re.findall(r'<script>(.*?)</script>', s, re.S):
    for L in js.split('\n'):
        if '`' in L and '//' in L: bad.append('บรรทัดที่มี ` และ // : ' + L.strip()[:80])
if bad: print('❌ ' + '\n❌ '.join(bad)); sys.exit(1)
print('✅ ผ่านการตรวจรูปแบบสำหรับ Apps Script')
PY

# สร้างหน้าเว็บสำหรับ Cloudflare ด้วย (cloudflare/public/index.html)
bash cloudflare/build.sh
