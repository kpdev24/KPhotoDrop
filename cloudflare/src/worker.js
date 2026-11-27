// PhotoDrop Event Gallery System by KPDev. — Cloudflare edition
// Workers (API + หน้าเว็บ) + R2 (เก็บไฟล์ภาพ/วิดีโอ) + D1 (ฐานข้อมูล)
// API ใช้ชื่อฟังก์ชันเดียวกับ Code.gs เพื่อให้หน้าเว็บ (Index.html) ใช้ร่วมกันได้

const DEFAULT_CATEGORY = 'ทั่วไป';
const DEFAULT_PUBLIC_URL = 'https://kpdev24.github.io/KPhotoDrop/';
const SESSION_HOURS = 8;
const URL_TTL = 12 * 3600; // ลิงก์ไฟล์ที่ลงลายเซ็นมีอายุ 12 ชม.
const PART_SIZE = 20 * 1024 * 1024; // ขนาดชิ้นอัปโหลดแบบ multipart

// ---------- schema (สร้างตารางอัตโนมัติครั้งแรก) ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS albums (id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT, startDate TEXT, endDate TEXT, createdAt TEXT, createdBy TEXT, passwordHash TEXT DEFAULT '', sort INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, albumId TEXT, category TEXT, name TEXT, mime TEXT, size INTEGER, created INTEGER, crc INTEGER, hasThumb INTEGER DEFAULT 0, hasView INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_files_album ON files(albumId)`,
  `CREATE TABLE IF NOT EXISTS subs (albumId TEXT, name TEXT, description TEXT DEFAULT '', passwordHash TEXT DEFAULT '', PRIMARY KEY (albumId, name))`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, passwordHash TEXT, name TEXT, role TEXT, status TEXT, createdAt TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS stats (time INTEGER, date TEXT, albumId TEXT, fileId TEXT, action TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_stats_date ON stats(date)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT, exp INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, payload TEXT, exp INTEGER)`,
  `CREATE TABLE IF NOT EXISTS faces (albumId TEXT PRIMARY KEY, json TEXT)`,
  `CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, meta TEXT, exp INTEGER)`
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
  const n = await env.DB.prepare('SELECT COUNT(*) c FROM users').first('c');
  if (!n) await env.DB.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)')
    .bind(uid(), 'admin', await sha256('456789'), 'ผู้ดูแลระบบ', 'admin', 'Active', new Date().toISOString()).run();
  schemaReady = true;
}

// ---------- utils ----------
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(s)))); }
function uid() { return crypto.randomUUID().split('-')[0] + Date.now().toString(36); }
function today() { return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); } // Asia/Bangkok
const fail = m => { throw new Error(m); };
const json = (o, st = 200, h = {}) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json; charset=utf-8', ...h } });

async function getSetting(env, k) { const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(k).first(); return r ? String(r.value) : ''; }
async function setSetting(env, k, v) { await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, String(v)).run(); }
async function secret(env) {
  if (env.SIGN_SECRET) return env.SIGN_SECRET;
  let s = await getSetting(env, '_signSecret');
  if (!s) { s = hex(crypto.getRandomValues(new Uint8Array(32))); await setSetting(env, '_signSecret', s); }
  return s;
}
let hmacKey = null;
async function sign(env, msg) {
  if (!hmacKey) hmacKey = await crypto.subtle.importKey('raw', enc.encode(await secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(msg))).slice(0, 32);
}
async function fileUrl(env, variant, id, origin) {
  const exp = Math.ceil(Date.now() / 1000 / 3600) * 3600 + URL_TTL; // ปัดเป็นชั่วโมงเพื่อให้เบราว์เซอร์แคชได้
  return `${origin}/f/${variant}/${id}?e=${exp}&s=${await sign(env, variant + ':' + id + ':' + exp)}`;
}

// ---------- auth ----------
async function login(env, username, password, role) {
  const u = await env.DB.prepare('SELECT * FROM users WHERE lower(username)=lower(?)').bind(String(username).trim()).first();
  if (!u || u.passwordHash !== await sha256(password)) fail('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (u.status !== 'Active') fail('บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน');
  if (role && u.role !== role) fail('ประเภทผู้ใช้งานไม่ตรงกับบัญชีนี้');
  const token = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(token, u.id, Date.now() + SESSION_HOURS * 3600e3).run();
  return { token, user: { id: u.id, username: u.username, name: u.name, role: u.role } };
}
async function auth(env, token, needAdmin) {
  if (!token) fail('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  const s = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.userId WHERE s.token=? AND s.exp>?').bind(token, Date.now()).first();
  if (!s) fail('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (s.status !== 'Active') fail('บัญชีถูกระงับหรือไม่พบผู้ใช้');
  if (needAdmin && s.role !== 'admin') fail('เฉพาะแอดมินเท่านั้น');
  return s;
}
async function isStaff(env, token) { try { await auth(env, token); return true; } catch (e) { return false; } }

// ---------- albums ----------
async function findAlbum(env, id) { const a = await env.DB.prepare('SELECT * FROM albums WHERE id=?').bind(id).first(); if (!a) fail('ไม่พบอัลบั้ม'); return a; }
function isVisible(a) {
  if (a.status !== 'Active') return false;
  const t = today();
  if (a.startDate && t < a.startDate) return false;
  if (a.endDate && t > a.endDate) return false;
  return true;
}
const normPass = p => (p && typeof p === 'object') ? { a: String(p.a || ''), s: p.s || {} } : { a: String(p || ''), s: {} };
async function checkAccess(env, a, token, pass) {
  if (await isStaff(env, token)) return true;
  if (!isVisible(a)) fail('อัลบั้มนี้ยังไม่เปิดแสดงผลหรือหมดเวลาแสดงผลแล้ว');
  if (a.passwordHash && await sha256(normPass(pass).a) !== a.passwordHash) fail('PASSWORD_REQUIRED');
  return true;
}
async function subMeta(env, albumId) {
  const { results } = await env.DB.prepare('SELECT * FROM subs WHERE albumId=?').bind(albumId).all();
  const m = {}; results.forEach(r => m[r.name] = r); return m;
}
async function lockedSubs(env, albumId, token, pass) {
  if (await isStaff(env, token)) return {};
  const pv = normPass(pass).s, meta = await subMeta(env, albumId), out = {};
  for (const n of Object.keys(meta)) { const h = meta[n].passwordHash; if (h && await sha256(String(pv[n] || '')) !== h) out[n] = 1; }
  return out;
}
async function filesOf(env, albumId) {
  const { results } = await env.DB.prepare('SELECT * FROM files WHERE albumId=? ORDER BY created DESC').bind(albumId).all();
  return results;
}
async function categoriesOf(env, albumId) {
  const a = await env.DB.prepare(`SELECT DISTINCT category c FROM files WHERE albumId=? AND category<>?`).bind(albumId, DEFAULT_CATEGORY).all();
  const b = await env.DB.prepare('SELECT name c FROM subs WHERE albumId=?').bind(albumId).all();
  return [...new Set(a.results.map(r => r.c).concat(b.results.map(r => r.c)))].sort();
}
async function fileOut(env, f, origin) {
  const isImg = f.mime.startsWith('image/');
  const orig = await fileUrl(env, 'o', f.id, origin);
  return { id: f.id, name: f.name, mime: f.mime, type: f.mime.startsWith('video') ? 'video' : 'image', category: f.category, size: f.size, created: f.created,
    thumb: f.hasThumb ? await fileUrl(env, 't', f.id, origin) : (isImg ? orig : ''),
    view: f.hasView ? await fileUrl(env, 'v', f.id, origin) : orig,
    preview: orig, download: orig + '&dl=1' };
}
async function albumOut(env, a, origin, withCount) {
  const o = { id: a.id, name: a.name, description: a.description || '', folderId: a.id, status: a.status, startDate: a.startDate || '', endDate: a.endDate || '',
    createdAt: (a.createdAt || '').slice(0, 10), locked: !!a.passwordHash };
  if (withCount) {
    o.count = await env.DB.prepare('SELECT COUNT(*) c FROM files WHERE albumId=?').bind(a.id).first('c');
    const c = a.passwordHash ? null : await env.DB.prepare(`SELECT id FROM files WHERE albumId=? AND mime LIKE 'image/%' ORDER BY created DESC LIMIT 1`).bind(a.id).first();
    o.cover = c ? c.id : ''; o.coverUrl = c ? await fileUrl(env, 't', c.id, origin) : '';
  }
  return o;
}

// ---------- stats ----------
async function statAgg(env) {
  const a = await env.DB.prepare(`SELECT albumId, SUM(action='album_view') v, SUM(action<>'album_view') d FROM stats GROUP BY albumId`).all();
  const out = {}; a.results.forEach(r => out[r.albumId] = { v: r.v || 0, d: r.d || 0 }); return out;
}
async function logEventFn(env, albumId, fileId, action) {
  if (!/^(album_view|download|download_social|zip)$/.test(action)) return false;
  await env.DB.prepare('INSERT INTO stats VALUES (?,?,?,?,?)').bind(Date.now(), today(), albumId || '', fileId || '', action).run();
  return true;
}

// ---------- LINE ----------
async function sendLine(env, text) {
  const tk = await getSetting(env, 'lineToken'); if (!tk) fail('ยังไม่ได้ตั้งค่า LINE Channel Access Token');
  const mode = (await getSetting(env, 'lineMode')) || 'broadcast';
  const body = { messages: [{ type: 'text', text: String(text).slice(0, 4900) }] };
  let url = 'https://api.line.me/v2/bot/message/broadcast';
  if (mode === 'push') { const to = await getSetting(env, 'lineTo'); if (!to) fail('ยังไม่ได้ระบุ LINE Group ID / User ID'); body.to = to; url = 'https://api.line.me/v2/bot/message/push'; }
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk }, body: JSON.stringify(body) });
  if (!r.ok) fail('LINE ตอบกลับ ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return true;
}
// ลิงก์สาธารณะ (QR/แชร์/LINE) — ค่าเริ่มต้น = ลิงก์ของ Worker นี้เอง เปลี่ยนได้ในตั้งค่าระบบ
let ORIGIN = '';
const publicUrl = async env => (await getSetting(env, 'publicUrl')) || (ORIGIN ? ORIGIN + '/' : DEFAULT_PUBLIC_URL);

// ---------- delete helpers ----------
async function removeFiles(env, ids) {
  if (!ids.length) return 0;
  const keys = []; ids.forEach(id => keys.push('o/' + id, 't/' + id, 'v/' + id));
  for (let i = 0; i < keys.length; i += 900) await env.BUCKET.delete(keys.slice(i, i + 900));
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    await env.DB.prepare(`DELETE FROM files WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).run();
  }
  return ids.length;
}

// ---------- API (ชื่อเดียวกับ Code.gs) ----------
function api(env, origin, ctx) {
  const A = {
    getWebAppUrl: async () => origin,
    getPublicConfig: async () => ({ publicUrl: await publicUrl(env), webAppUrl: origin, cloudflare: true }),
    getPublicAlbums: async () => {
      const { results } = await env.DB.prepare('SELECT * FROM albums ORDER BY sort DESC, createdAt DESC').all();
      const st = await statAgg(env), out = [];
      for (const a of results.filter(isVisible)) out.push(Object.assign(await albumOut(env, a, origin, true), { views: (st[a.id] || {}).v || 0, downloads: (st[a.id] || {}).d || 0 }));
      return out;
    },
    checkAlbumPassword: async (id, pw) => {
      const a = await findAlbum(env, id); if (!isVisible(a)) fail('อัลบั้มนี้ยังไม่เปิดแสดงผล');
      if (a.passwordHash && await sha256(pw || '') !== a.passwordHash) fail('รหัสผ่านไม่ถูกต้อง'); return true;
    },
    checkSubPassword: async (id, name, pw) => {
      const a = await findAlbum(env, id); if (!isVisible(a)) fail('อัลบั้มนี้ยังไม่เปิดแสดงผล');
      const m = (await subMeta(env, id))[name];
      if (m && m.passwordHash && await sha256(pw || '') !== m.passwordHash) fail('รหัสผ่านไม่ถูกต้อง'); return true;
    },
    getAlbumFiles: async (albumId, token, pass) => {
      const a = await findAlbum(env, albumId); await checkAccess(env, a, token, pass);
      const staff = await isStaff(env, token);
      const all = await filesOf(env, albumId), locked = await lockedSubs(env, albumId, token, pass), meta = await subMeta(env, albumId);
      const dl = {}; (await env.DB.prepare(`SELECT fileId, COUNT(*) n FROM stats WHERE albumId=? AND fileId<>'' GROUP BY fileId`).bind(albumId).all()).results.forEach(r => dl[r.fileId] = r.n);
      const files = [];
      for (const f of all) if (!locked[f.category]) files.push(Object.assign(await fileOut(env, f, origin), { dl: dl[f.id] || 0 }));
      const names = await categoriesOf(env, albumId), subs = [];
      for (const n of names) {
        const fs = all.filter(f => f.category === n), m = meta[n] || {}, cov = fs.find(f => f.mime.startsWith('image/'));
        if (!fs.length && !staff) continue;
        subs.push({ name: n, description: m.description || '', count: fs.length, hasPassword: !!m.passwordHash, locked: !!locked[n],
          cover: (!locked[n] && cov) ? await fileUrl(env, cov.hasThumb ? 't' : 'o', cov.id, origin) : '' });
      }
      const cats = [DEFAULT_CATEGORY].concat(names).filter(c => files.some(f => f.category === c));
      const st = (await statAgg(env))[albumId] || {};
      return { album: Object.assign(await albumOut(env, a, origin, false), { views: st.v || 0, downloads: st.d || 0 }), files, categories: cats, subs,
        generalCount: all.filter(f => f.category === DEFAULT_CATEGORY).length };
    },
    logEvent: async (albumId, fileId, action) => logEventFn(env, albumId, fileId, action),
    // ZIP: สร้างตั๋วชั่วคราว แล้วให้เบราว์เซอร์ดาวน์โหลดแบบสตรีมจาก /zip/<ticket>
    getZipPlan: async (albumId, token, pass, ids) => {
      const d = await A.getAlbumFiles(albumId, token, pass);
      let fs = d.files; if (ids && ids.length) { const w = new Set(ids); fs = fs.filter(f => w.has(f.id)); }
      return { albumName: d.album.name, totalFiles: fs.length, totalSize: fs.reduce((s, f) => s + f.size, 0), parts: 1, partFileIds: [fs.map(f => f.id)], tooBig: [] };
    },
    buildAlbumZip: async (albumId, partIndex, token, pass, ids) => {
      const plan = await A.getZipPlan(albumId, token, pass, ids);
      const t = uid() + uid();
      const safe = String(plan.albumName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'album';
      const name = (ids && ids.length ? `${safe}_เลือก${plan.totalFiles}ภาพ` : safe) + '.zip';
      await env.DB.prepare('INSERT INTO tickets VALUES (?,?,?)').bind(t, JSON.stringify({ albumId, ids: plan.partFileIds[0], name }), Date.now() + 3600e3).run();
      await logEventFn(env, albumId, '', 'zip');
      return { name, url: origin + '/zip/' + t, part: 1, parts: 1 };
    },
    getFileData: async (fileId, token, pass, mode) => {
      const f = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(fileId).first(); if (!f) fail('ไม่พบไฟล์');
      const a = await findAlbum(env, f.albumId); await checkAccess(env, a, token, pass);
      if ((await lockedSubs(env, a.id, token, pass))[f.category]) fail('อัลบั้มย่อยนี้ต้องใช้รหัสผ่าน');
      await logEventFn(env, a.id, fileId, mode === 'social' ? 'download_social' : 'download');
      return { name: f.name, mime: f.mime, fileUrl: await fileUrl(env, 'o', f.id, origin) };
    },
    // ---- auth ----
    login: async (u, p, r) => login(env, u, p, r),
    logout: async token => { await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run(); return true; },
    changeMyPassword: async (token, o, n) => {
      const u = await auth(env, token);
      if (u.passwordHash !== await sha256(o)) fail('รหัสผ่านเดิมไม่ถูกต้อง');
      if (!n || n.length < 6) fail('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
      await env.DB.prepare('UPDATE users SET passwordHash=? WHERE id=?').bind(await sha256(n), u.id).run(); return true;
    },
    // ---- albums (admin) ----
    adminGetAlbums: async token => {
      await auth(env, token);
      const { results } = await env.DB.prepare('SELECT * FROM albums ORDER BY sort DESC, createdAt DESC').all();
      const out = []; for (const a of results) out.push(await albumOut(env, a, origin, true)); return out;
    },
    saveAlbum: async (token, d) => {
      const s = await auth(env, token, true);
      if (!d.name || !String(d.name).trim()) fail('กรุณาระบุชื่ออัลบั้ม');
      if (d.startDate && d.endDate && d.startDate > d.endDate) fail('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
      if (d.password && String(d.password).length < 4) fail('รหัสผ่านอัลบั้มต้องมีอย่างน้อย 4 ตัวอักษร');
      if (d.id) {
        const a = await findAlbum(env, d.id);
        let ph = a.passwordHash || ''; if (d.removePassword) ph = ''; else if (d.password) ph = await sha256(d.password);
        await env.DB.prepare('UPDATE albums SET name=?, description=?, status=?, startDate=?, endDate=?, passwordHash=? WHERE id=?')
          .bind(d.name, d.description || '', d.status || 'Active', d.startDate || '', d.endDate || '', ph, d.id).run();
        return albumOut(env, await findAlbum(env, d.id), origin, false);
      }
      const id = uid();
      await env.DB.prepare('INSERT INTO albums (id,name,description,status,startDate,endDate,createdAt,createdBy,passwordHash,sort) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(id, d.name, d.description || '', d.status || 'Active', d.startDate || '', d.endDate || '', new Date().toISOString(), s.username, d.password ? await sha256(d.password) : '', Date.now()).run();
      return albumOut(env, await findAlbum(env, id), origin, false);
    },
    toggleAlbum: async (token, id) => {
      await auth(env, token, true); const a = await findAlbum(env, id); const st = a.status === 'Active' ? 'Hidden' : 'Active';
      await env.DB.prepare('UPDATE albums SET status=? WHERE id=?').bind(st, id).run(); return st;
    },
    deleteAlbum: async (token, id, deleteFiles) => {
      await auth(env, token, true); await findAlbum(env, id);
      if (deleteFiles) await removeFiles(env, (await filesOf(env, id)).map(f => f.id));
      else await env.DB.prepare('UPDATE files SET albumId=? WHERE albumId=?').bind('_orphan_' + id, id).run();
      await env.DB.batch([env.DB.prepare('DELETE FROM albums WHERE id=?').bind(id), env.DB.prepare('DELETE FROM subs WHERE albumId=?').bind(id), env.DB.prepare('DELETE FROM faces WHERE albumId=?').bind(id)]);
      return true;
    },
    // ---- categories / sub-albums ----
    getCategories: async (token, albumId) => { await auth(env, token); return categoriesOf(env, albumId); },
    createCategory: async (token, albumId, name) => { await auth(env, token); await env.DB.prepare('INSERT OR IGNORE INTO subs (albumId,name) VALUES (?,?)').bind(albumId, name).run(); return categoriesOf(env, albumId); },
    renameCategory: async (token, albumId, o, n) => {
      await auth(env, token, true); n = String(n || '').trim(); if (!n || /[\\/]/.test(n)) fail('ชื่อหมวดไม่ถูกต้อง');
      await env.DB.batch([env.DB.prepare('UPDATE files SET category=? WHERE albumId=? AND category=?').bind(n, albumId, o),
        env.DB.prepare('UPDATE subs SET name=? WHERE albumId=? AND name=?').bind(n, albumId, o)]);
      return categoriesOf(env, albumId);
    },
    deleteCategory: async (token, albumId, name) => {
      await auth(env, token, true);
      await env.DB.batch([env.DB.prepare('UPDATE files SET category=? WHERE albumId=? AND category=?').bind(DEFAULT_CATEGORY, albumId, name),
        env.DB.prepare('DELETE FROM subs WHERE albumId=? AND name=?').bind(albumId, name)]);
      return categoriesOf(env, albumId);
    },
    moveFileToCategory: async (token, albumId, fileId, name) => { await auth(env, token); await env.DB.prepare('UPDATE files SET category=? WHERE id=?').bind(name || DEFAULT_CATEGORY, fileId).run(); return true; },
    moveFiles: async (token, albumId, ids, name) => {
      await auth(env, token); ids = ids || [];
      await env.DB.batch(ids.map(id => env.DB.prepare('UPDATE files SET category=? WHERE id=? AND albumId=?').bind(name || DEFAULT_CATEGORY, id, albumId)));
      return ids.length;
    },
    getSubAlbums: async (token, albumId) => {
      await auth(env, token);
      const meta = await subMeta(env, albumId), all = await filesOf(env, albumId), out = [];
      for (const n of await categoriesOf(env, albumId)) {
        const fs = all.filter(f => f.category === n), cov = fs.find(f => f.mime.startsWith('image/'));
        out.push({ name: n, description: (meta[n] || {}).description || '', hasPassword: !!(meta[n] || {}).passwordHash, count: fs.length,
          cover: cov ? await fileUrl(env, cov.hasThumb ? 't' : 'o', cov.id, origin) : '' });
      }
      return out;
    },
    saveSubAlbum: async (token, albumId, d) => {
      await auth(env, token, true); await findAlbum(env, albumId);
      const name = String(d.name || '').trim();
      if (!name || name === DEFAULT_CATEGORY || /[\\/]/.test(name)) fail('ชื่ออัลบั้มย่อยไม่ถูกต้อง');
      if (d.password && String(d.password).length < 4) fail('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร');
      const exists = (await categoriesOf(env, albumId)).includes(name);
      if (d.oldName && d.oldName !== name) { if (exists) fail('มีอัลบั้มย่อยชื่อนี้แล้ว'); await A.renameCategory(token, albumId, d.oldName, name); }
      else if (!d.oldName && exists) fail('มีอัลบั้มย่อยชื่อนี้แล้ว');
      const cur = (await subMeta(env, albumId))[name] || {};
      let ph = cur.passwordHash || ''; if (d.removePassword) ph = ''; else if (d.password) ph = await sha256(d.password);
      await env.DB.prepare('INSERT INTO subs (albumId,name,description,passwordHash) VALUES (?,?,?,?) ON CONFLICT(albumId,name) DO UPDATE SET description=excluded.description, passwordHash=excluded.passwordHash')
        .bind(albumId, name, String(d.description || ''), ph).run();
      return A.getSubAlbums(token, albumId);
    },
    // ---- files ----
    deleteFile: async (token, id) => { await auth(env, token); return removeFiles(env, [id]) > 0; },
    deleteFiles: async (token, ids) => { await auth(env, token); return removeFiles(env, ids || []); },
    notifyNewPhotos: async (token, albumId, count) => {
      await auth(env, token);
      if ((await getSetting(env, 'lineEnabled')) !== 'true' || !count) return false;
      const a = await findAlbum(env, albumId); if (!isVisible(a)) return false;
      try { return await sendLine(env, `📸 ภาพใหม่ ${count} ไฟล์ ในอัลบั้ม "${a.name}"\n` + (a.passwordHash ? '🔒 อัลบั้มนี้มีรหัสผ่าน\n' : '') + `ดูและดาวน์โหลดภาพ 👉 ${await publicUrl(env)}?album=${a.id}`); }
      catch (e) { return false; }
    },
    // ---- users ----
    getUsers: async token => { await auth(env, token, true); return (await env.DB.prepare('SELECT id,username,name,role,status,createdAt FROM users').all()).results; },
    saveUser: async (token, d) => {
      const s = await auth(env, token, true);
      if (!d.username || !d.name) fail('กรุณากรอกข้อมูลให้ครบ');
      const dup = await env.DB.prepare('SELECT id FROM users WHERE lower(username)=lower(?) AND id<>?').bind(d.username, d.id || '').first();
      if (dup) fail('ชื่อผู้ใช้นี้มีอยู่แล้ว');
      if (d.id) {
        if (d.id === s.id && (d.status !== 'Active' || d.role !== 'admin')) fail('ไม่สามารถระงับหรือลดสิทธิ์บัญชีของตนเองได้');
        await env.DB.prepare('UPDATE users SET username=?, name=?, role=?, status=? WHERE id=?').bind(d.username, d.name, d.role, d.status, d.id).run();
        return true;
      }
      if (!d.password || d.password.length < 6) fail('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      await env.DB.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').bind(uid(), d.username, await sha256(d.password), d.name, d.role || 'staff', d.status || 'Active', new Date().toISOString()).run();
      return true;
    },
    toggleUser: async (token, id) => {
      const s = await auth(env, token, true); if (id === s.id) fail('ไม่สามารถระงับบัญชีของตนเองได้');
      const u = await env.DB.prepare('SELECT status FROM users WHERE id=?').bind(id).first(); if (!u) fail('ไม่พบผู้ใช้');
      const st = u.status === 'Active' ? 'Suspended' : 'Active';
      await env.DB.batch([env.DB.prepare('UPDATE users SET status=? WHERE id=?').bind(st, id), env.DB.prepare('DELETE FROM sessions WHERE userId=?').bind(id)]);
      return st;
    },
    resetPassword: async (token, id, p) => {
      await auth(env, token, true); if (!p || p.length < 6) fail('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      await env.DB.prepare('UPDATE users SET passwordHash=? WHERE id=?').bind(await sha256(p), id).run(); return true;
    },
    deleteUser: async (token, id) => {
      const s = await auth(env, token, true); if (id === s.id) fail('ไม่สามารถลบบัญชีของตนเองได้');
      await env.DB.batch([env.DB.prepare('DELETE FROM users WHERE id=?').bind(id), env.DB.prepare('DELETE FROM sessions WHERE userId=?').bind(id)]); return true;
    },
    // ---- settings ----
    getSettings: async token => {
      await auth(env, token, true);
      return { rootFolderId: 'Cloudflare R2', autoSubfolder: true, publicUrl: await publicUrl(env), lineEnabled: (await getSetting(env, 'lineEnabled')) === 'true',
        lineMode: (await getSetting(env, 'lineMode')) || 'broadcast', lineTo: await getSetting(env, 'lineTo'), lineHasToken: !!(await getSetting(env, 'lineToken')),
        cloudflare: true, migrateKey: await migrateKey(env) };
    },
    saveSettings: async (token, d) => {
      await auth(env, token, true);
      let pu = String(d.publicUrl || '').trim(); if (pu && !/\/$/.test(pu)) pu += '/';
      await setSetting(env, 'publicUrl', pu);
      await setSetting(env, 'lineEnabled', d.lineEnabled ? 'true' : 'false');
      await setSetting(env, 'lineMode', d.lineMode === 'push' ? 'push' : 'broadcast');
      await setSetting(env, 'lineTo', String(d.lineTo || '').trim());
      if (d.lineToken) await setSetting(env, 'lineToken', String(d.lineToken).trim());
      return true;
    },
    testFolder: async token => {
      await auth(env, token, true);
      const c = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM files').first();
      return { ok: true, name: `Cloudflare R2 — ${c.n} ไฟล์ ใช้พื้นที่ ${(c.s / 1073741824).toFixed(2)} GB จากที่ฟรี 10 GB`, url: '#' };
    },
    testLine: async token => { await auth(env, token, true); return sendLine(env, '✅ ทดสอบการแจ้งเตือนจาก PhotoDrop สำเร็จ\n' + await publicUrl(env)); },
    getStats: async (token, days) => {
      await auth(env, token); days = Math.min(Math.max(Number(days) || 30, 7), 365);
      const dayList = []; for (let i = days - 1; i >= 0; i--) dayList.push(new Date(Date.now() + 7 * 3600e3 - i * 864e5).toISOString().slice(0, 10));
      const since = dayList[0];
      const tot = await env.DB.prepare(`SELECT SUM(action='album_view') views, SUM(action='download') downloads, SUM(action='download_social') social, SUM(action='zip') zip FROM stats WHERE date>=?`).bind(since).first();
      const byA = (await env.DB.prepare(`SELECT s.albumId, COALESCE(a.name,'(ลบแล้ว)') name, SUM(action='album_view') views, SUM(action='download') downloads, SUM(action='download_social') social, SUM(action='zip') zip
        FROM stats s LEFT JOIN albums a ON a.id=s.albumId WHERE date>=? GROUP BY s.albumId ORDER BY (views+downloads) DESC`).bind(since).all()).results;
      const byD = (await env.DB.prepare(`SELECT date, SUM(action='album_view') views, SUM(action<>'album_view') downloads FROM stats WHERE date>=? GROUP BY date`).bind(since).all()).results;
      const dm = {}; byD.forEach(r => dm[r.date] = r);
      const top = (await env.DB.prepare(`SELECT s.fileId id, COALESCE(f.name, s.fileId) name, COUNT(*) count, f.hasThumb FROM stats s LEFT JOIN files f ON f.id=s.fileId
        WHERE s.date>=? AND s.fileId<>'' GROUP BY s.fileId ORDER BY count DESC LIMIT 10`).bind(since).all()).results;
      for (const t of top) t.thumb = await fileUrl(env, t.hasThumb ? 't' : 'o', t.id, origin);
      return { days, totals: { views: tot.views || 0, downloads: tot.downloads || 0, social: tot.social || 0, zip: tot.zip || 0 }, albums: byA,
        daily: dayList.map(d => ({ date: d, views: (dm[d] || {}).views || 0, downloads: (dm[d] || {}).downloads || 0 })), topFiles: top };
    },
    // ---- face search ----
    getFaceData: async (albumId, token, pass) => {
      const d = await A.getAlbumFiles(albumId, token, pass);
      const row = await env.DB.prepare('SELECT json FROM faces WHERE albumId=?').bind(albumId).first();
      let index = {}; try { index = row ? JSON.parse(row.json) : {}; } catch (e) {}
      const imageIds = d.files.filter(f => f.type === 'image').map(f => f.id);
      Object.keys(index).forEach(k => { if (!imageIds.includes(k)) delete index[k]; });
      return { index, imageIds };
    },
    getFaceThumbs: async (albumId, ids, token, pass) => {
      const d = await A.getAlbumFiles(albumId, token, pass), w = new Set(ids);
      return d.files.filter(f => w.has(f.id)).map(f => ({ id: f.id, data: f.view }));
    },
    saveFaceIndex: async (token, albumId, partial) => {
      await auth(env, token);
      const row = await env.DB.prepare('SELECT json FROM faces WHERE albumId=?').bind(albumId).first();
      let index = {}; try { index = row ? JSON.parse(row.json) : {}; } catch (e) {}
      Object.assign(index, partial || {});
      await env.DB.prepare('INSERT INTO faces VALUES (?,?) ON CONFLICT(albumId) DO UPDATE SET json=excluded.json').bind(albumId, JSON.stringify(index)).run();
      return Object.keys(index).length;
    },
    // ---- upload (multipart ไป R2) ----
    cfUploadStart: async (token, albumId, meta) => {
      await auth(env, token); await findAlbum(env, albumId);
      if (!/^(image\/(jpeg|png|heic|heif|webp)|video\/(mp4|quicktime|x-m4v|webm))$/.test(meta.mime)) fail('รองรับเฉพาะภาพ JPG/PNG/HEIC/WEBP และวิดีโอ MP4/MOV/M4V/WEBM');
      const id = uid() + Math.random().toString(36).slice(2, 6);
      const mp = await env.BUCKET.createMultipartUpload('o/' + id, { httpMetadata: { contentType: meta.mime } });
      const m = { id, albumId, uploadId: mp.uploadId, name: meta.name, mime: meta.mime, size: meta.size, crc: meta.crc >>> 0, category: meta.category || DEFAULT_CATEGORY };
      await env.DB.prepare('INSERT INTO uploads VALUES (?,?,?)').bind(id, JSON.stringify(m), Date.now() + 24 * 3600e3).run();
      return { id, partSize: PART_SIZE };
    }
  };
  return A;
}
async function migrateKey(env) {
  if (env.MIGRATE_KEY) return env.MIGRATE_KEY;
  let k = await getSetting(env, '_migrateKey');
  if (!k) { k = hex(crypto.getRandomValues(new Uint8Array(16))); await setSetting(env, '_migrateKey', k); }
  return k;
}

// ---------- file serving ----------
async function serveFile(env, req, variant, id) {
  const u = new URL(req.url), e = Number(u.searchParams.get('e')), s = u.searchParams.get('s');
  if (!e || e * 1000 < Date.now() || s !== await sign(env, variant + ':' + id + ':' + e)) return new Response('ลิงก์หมดอายุ กรุณารีเฟรชหน้าเว็บ', { status: 403 });
  const key = variant + '/' + id;
  const obj = await env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers(); obj.writeHttpMetadata(h); h.set('etag', obj.httpEtag);
  h.set('cache-control', 'private, max-age=' + Math.max(60, e - Math.floor(Date.now() / 1000)));
  h.set('accept-ranges', 'bytes');
  if (u.searchParams.get('dl')) {
    const f = await env.DB.prepare('SELECT name FROM files WHERE id=?').bind(id).first();
    if (f) h.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  }
  if (!('body' in obj)) return new Response(null, { status: 304, headers: h });
  if (obj.range && req.headers.get('range')) {
    const r = obj.range, start = r.offset || 0, end = (r.length ? start + r.length : obj.size) - 1;
    h.set('content-range', `bytes ${start}-${end}/${obj.size}`); h.set('content-length', String(end - start + 1));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { headers: h });
}

// ---------- streaming ZIP (STORE, ใช้ CRC ที่คำนวณไว้ตอนอัปโหลด → ไม่กิน CPU) ----------
function dosTime(ms) {
  const d = new Date(ms + 7 * 3600e3);
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}
async function serveZip(env, ticket) {
  const t = await env.DB.prepare('SELECT payload FROM tickets WHERE id=? AND exp>?').bind(ticket, Date.now()).first();
  if (!t) return new Response('ลิงก์ดาวน์โหลดหมดอายุ', { status: 410 });
  const p = JSON.parse(t.payload);
  const all = await filesOf(env, p.albumId), want = new Set(p.ids);
  const fs = all.filter(f => want.has(f.id) && f.crc !== null && f.crc !== undefined);
  const multi = new Set(fs.map(f => f.category)).size > 1, used = {};
  const entries = fs.map(f => {
    let n = (multi ? f.category + '/' : '') + f.name;
    if (used[n]) { const i = n.lastIndexOf('.'); n = (i > 0 ? n.slice(0, i) : n) + '_' + (used[n]++) + (i > 0 ? n.slice(i) : ''); } else used[n] = 1;
    return { f, name: enc.encode(n), dt: dosTime(f.created || Date.now()) };
  });
  let offset = 0; entries.forEach(e => { e.offset = offset; offset += 30 + e.name.length + e.f.size; });
  const cdSize = entries.reduce((s, e) => s + 46 + e.name.length, 0);
  const total = offset + cdSize + 22;
  if (offset > 0xFFFFFFFF || entries.length > 0xFFFF) return new Response('อัลบั้มใหญ่เกิน 4GB — กรุณาเลือกภาพบางส่วน', { status: 413 });
  const { readable, writable } = new FixedLengthStream(total);
  (async () => {
    const w = writable.getWriter();
    try {
      for (const e of entries) {
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
        h.setUint16(10, e.dt.time, true); h.setUint16(12, e.dt.date, true); h.setUint32(14, e.f.crc >>> 0, true);
        h.setUint32(18, e.f.size, true); h.setUint32(22, e.f.size, true); h.setUint16(26, e.name.length, true); h.setUint16(28, 0, true);
        await w.write(new Uint8Array(h.buffer)); await w.write(e.name);
        const obj = await env.BUCKET.get('o/' + e.f.id);
        const r = obj.body.getReader();
        for (;;) { const { done, value } = await r.read(); if (done) break; await w.write(value); }
      }
      for (const e of entries) {
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
        c.setUint16(12, e.dt.time, true); c.setUint16(14, e.dt.date, true); c.setUint32(16, e.f.crc >>> 0, true);
        c.setUint32(20, e.f.size, true); c.setUint32(24, e.f.size, true); c.setUint16(28, e.name.length, true);
        c.setUint32(42, e.offset, true);
        await w.write(new Uint8Array(c.buffer)); await w.write(e.name);
      }
      const z = new DataView(new ArrayBuffer(22));
      z.setUint32(0, 0x06054b50, true); z.setUint16(8, entries.length, true); z.setUint16(10, entries.length, true);
      z.setUint32(12, cdSize, true); z.setUint32(16, offset, true);
      await w.write(new Uint8Array(z.buffer)); await w.close();
    } catch (err) { try { await w.abort(err); } catch (e) {} }
  })();
  return new Response(readable, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(p.name)}` } });
}

// ---------- upload parts ----------
async function uploadPart(env, req, id, partNo) {
  const row = await env.DB.prepare('SELECT meta FROM uploads WHERE id=? AND exp>?').bind(id, Date.now()).first();
  if (!row) return json({ error: 'ไม่พบการอัปโหลด' }, 404);
  const m = JSON.parse(row.meta);
  const tok = req.headers.get('x-token'); try { await auth(env, tok); } catch (e) { return json({ error: e.message }, 401); }
  const mp = env.BUCKET.resumeMultipartUpload('o/' + id, m.uploadId);
  const part = await mp.uploadPart(Number(partNo), req.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}
async function uploadComplete(env, req, id) {
  const row = await env.DB.prepare('SELECT meta FROM uploads WHERE id=?').bind(id).first();
  if (!row) return json({ error: 'ไม่พบการอัปโหลด' }, 404);
  const m = JSON.parse(row.meta);
  const tok = req.headers.get('x-token'); try { await auth(env, tok); } catch (e) { return json({ error: e.message }, 401); }
  const body = await req.json();
  const mp = env.BUCKET.resumeMultipartUpload('o/' + id, m.uploadId);
  const obj = await mp.complete(body.parts);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO files (id,albumId,category,name,mime,size,created,crc,hasThumb,hasView) VALUES (?,?,?,?,?,?,?,?,0,0)')
      .bind(id, m.albumId, m.category, m.name, m.mime, obj.size, Date.now(), m.crc),
    env.DB.prepare('DELETE FROM uploads WHERE id=?').bind(id)]);
  return json({ id, name: m.name });
}
// ภาพย่อ (t) และภาพสำหรับดู (v) ที่เบราว์เซอร์สร้างไว้ตอนอัปโหลด
async function uploadVariant(env, req, id, variant) {
  const tok = req.headers.get('x-token'); try { await auth(env, tok); } catch (e) { return json({ error: e.message }, 401); }
  if (!/^[tv]$/.test(variant)) return json({ error: 'bad variant' }, 400);
  const f = await env.DB.prepare('SELECT id FROM files WHERE id=?').bind(id).first(); if (!f) return json({ error: 'ไม่พบไฟล์' }, 404);
  await env.BUCKET.put(variant + '/' + id, req.body, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare(`UPDATE files SET ${variant === 't' ? 'hasThumb' : 'hasView'}=1 WHERE id=?`).bind(id).run();
  return json({ ok: true });
}

// ---------- migration from Google Drive (เรียกจาก Code.gs) ----------
async function migrate(env, req, what) {
  if (req.headers.get('x-migrate-key') !== await migrateKey(env)) return json({ error: 'MIGRATE KEY ไม่ถูกต้อง' }, 401);
  if (what === 'meta') {
    const d = await req.json(), st = [];
    (d.albums || []).forEach((a, i) => st.push(env.DB.prepare('INSERT OR REPLACE INTO albums (id,name,description,status,startDate,endDate,createdAt,createdBy,passwordHash,sort) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(a.id, a.name, a.description || '', a.status || 'Active', a.startDate || '', a.endDate || '', a.createdAt || new Date().toISOString(), a.createdBy || '', a.passwordHash || '', (d.albums.length - i))));
    (d.users || []).forEach(u => st.push(env.DB.prepare('INSERT OR REPLACE INTO users VALUES (?,?,?,?,?,?,?)').bind(u.id, u.username, u.passwordHash, u.name, u.role, u.status, u.createdAt || '')));
    (d.subs || []).forEach(s => st.push(env.DB.prepare('INSERT OR REPLACE INTO subs VALUES (?,?,?,?)').bind(s.albumId, s.name, s.description || '', s.passwordHash || '')));
    Object.keys(d.settings || {}).forEach(k => st.push(env.DB.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').bind(k, String(d.settings[k]))));
    Object.keys(d.faces || {}).forEach(k => st.push(env.DB.prepare('INSERT OR REPLACE INTO faces VALUES (?,?)').bind(k, JSON.stringify(d.faces[k]))));
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
    if (d.replaceAdmin) await env.DB.prepare(`DELETE FROM users WHERE username='admin' AND id NOT IN (${(d.users || []).map(() => '?').join(',') || "''"})`).bind(...(d.users || []).map(u => u.id)).run();
    return json({ ok: true, rows: st.length });
  }
  if (what === 'stats') {
    const rows = await req.json();
    const st = rows.map(r => env.DB.prepare('INSERT INTO stats VALUES (?,?,?,?,?)').bind(r[0], r[1], r[2], r[3], r[4]));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, rows: st.length });
  }
  if (what === 'file') {
    const h = k => decodeURIComponent(req.headers.get('x-' + k) || '');
    const id = h('id'), variant = h('variant') || 'o';
    if (!id) return json({ error: 'no id' }, 400);
    if (variant === 'o') {
      const exists = await env.DB.prepare('SELECT id FROM files WHERE id=?').bind(id).first();
      if (exists) return json({ ok: true, skipped: true });
      const obj = await env.BUCKET.put('o/' + id, req.body, { httpMetadata: { contentType: h('mime') } });
      await env.DB.prepare('INSERT OR REPLACE INTO files (id,albumId,category,name,mime,size,created,crc,hasThumb,hasView) VALUES (?,?,?,?,?,?,?,?,0,0)')
        .bind(id, h('album'), h('category') || DEFAULT_CATEGORY, h('name'), h('mime'), obj.size, Number(h('created')) || Date.now(), Number(h('crc')) >>> 0).run();
    } else {
      await env.BUCKET.put(variant + '/' + id, req.body, { httpMetadata: { contentType: 'image/jpeg' } });
      await env.DB.prepare(`UPDATE files SET ${variant === 't' ? 'hasThumb' : 'hasView'}=1 WHERE id=?`).bind(id).run();
    }
    return json({ ok: true });
  }
  if (what === 'has') {
    const ids = await req.json(), have = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const r = await env.DB.prepare(`SELECT id FROM files WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
      r.results.forEach(x => have.push(x.id));
    }
    return json({ ok: true, have });
  }
  if (what === 'status') {
    const c = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM files').first();
    return json({ ok: true, files: c.n, bytes: c.s });
  }
  return json({ error: 'unknown' }, 404);
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname, origin = url.origin;
    ORIGIN = origin;
    try {
      await ensureSchema(env);
      if (path === '/api' && req.method === 'POST') {
        const { fn, args } = await req.json();
        const A = api(env, origin, ctx);
        if (!Object.prototype.hasOwnProperty.call(A, fn)) return json({ error: 'ไม่รู้จักคำสั่ง: ' + fn }, 400);
        try { return json({ ok: true, result: await A[fn](...(args || [])) }); }
        catch (e) { return json({ ok: false, error: e.message || String(e) }); }
      }
      let m;
      if ((m = path.match(/^\/f\/([otv])\/([\w-]+)$/))) return serveFile(env, req, m[1], m[2]);
      if ((m = path.match(/^\/zip\/(\w+)$/))) return serveZip(env, m[1]);
      if ((m = path.match(/^\/up\/([\w-]+)\/part\/(\d+)$/)) && req.method === 'PUT') return uploadPart(env, req, m[1], m[2]);
      if ((m = path.match(/^\/up\/([\w-]+)\/complete$/)) && req.method === 'POST') return uploadComplete(env, req, m[1]);
      if ((m = path.match(/^\/up\/([\w-]+)\/([tv])$/)) && req.method === 'PUT') return uploadVariant(env, req, m[1], m[2]);
      if ((m = path.match(/^\/migrate\/(\w+)$/)) && req.method === 'POST') return migrate(env, req, m[1]);
      if (path === '/health') return json({ ok: true });
      // หน้าเว็บ (static assets)
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 500);
    }
  },
  // ล้างข้อมูลหมดอายุทุกวัน
  async scheduled(event, env) {
    await ensureSchema(env);
    await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE exp<?').bind(Date.now()), env.DB.prepare('DELETE FROM tickets WHERE exp<?').bind(Date.now()),
      env.DB.prepare('DELETE FROM uploads WHERE exp<?').bind(Date.now())]);
  }
};
