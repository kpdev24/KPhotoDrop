#!/usr/bin/env bash
# สร้าง public/index.html จาก ../Index.html (ไฟล์เดียวกับที่ใช้ใน Apps Script) + shim สำหรับ Cloudflare
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p public
python3 - <<'PY'
s = open('../Index.html').read()
shim = open('shim.js').read()
s = s.replace('<base target="_top">', '', 1)
i = s.index('<!-- TW:START -->')
s = s[:i] + '<script>\n' + shim + '</script>\n' + s[i:]
open('public/index.html', 'w').write(s)
print('public/index.html', len(s) // 1024, 'KB')
PY
