/**
 * PhotoDrop Event Gallery System by KPDev.
 * ดาวน์โหลดภาพถ่ายกิจกรรมความคมชัดสูง ผ่านการสแกน QR Code
 * Google Apps Script + Google Drive + Google Sheets
 */

// ====== CONFIG ======
const SHEET_ALBUMS = 'Albums';
const SHEET_USERS = 'Users';
const SHEET_SETTINGS = 'Settings';
const SHEET_STATS = 'Stats';
const SESSION_HOURS = 8;
const ZIP_PART_LIMIT = 35 * 1024 * 1024; // ~35MB ต่อไฟล์ ZIP (Base64 โต ~33% ไม่ให้เกินลิมิต 50MB ของ google.script.run)
const FACE_FILE = '_faces.json';
const DEFAULT_CATEGORY = 'ทั่วไป';
const DEFAULT_PUBLIC_URL = 'https://kpdev24.github.io/KPhotoDrop/';

const SHEET_DEFS = {
  [SHEET_ALBUMS]: ['id', 'name', 'description', 'folderId', 'status', 'startDate', 'endDate', 'createdAt', 'createdBy', 'passwordHash'],
  [SHEET_USERS]: ['id', 'username', 'passwordHash', 'name', 'role', 'status', 'createdAt'],
  [SHEET_SETTINGS]: ['key', 'value'],
  [SHEET_STATS]: ['time', 'date', 'albumId', 'fileId', 'action']
};

// ====== WEB APP ======
function doGet() {
  setupSheets_();
  // ไม่ใช้ template เพื่อหลีกเลี่ยงปัญหาการแปลงโค้ด — หน้าเว็บอ่านพารามิเตอร์ ?album= เองผ่าน google.script.url
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('PhotoDrop Event Gallery System by KPDev.')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getWebAppUrl() { return ScriptApp.getService().getUrl(); }

/** ค่าที่หน้าเว็บสาธารณะต้องใช้ */
function getPublicConfig() {
  setupSheets_();
  return { publicUrl: getSetting_('publicUrl') || DEFAULT_PUBLIC_URL, webAppUrl: ScriptApp.getService().getUrl() };
}

// ====== SETUP ======
function getSS_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SS_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  let ss;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (!ss) ss = SpreadsheetApp.create('PhotoDrop Database');
  props.setProperty('SS_ID', ss.getId());
  return ss;
}

function setupSheets_() {
  const ss = getSS_();
  Object.keys(SHEET_DEFS).forEach(n => {
    let sh = ss.getSheetByName(n);
    if (!sh) { sh = ss.insertSheet(n); sh.appendRow(SHEET_DEFS[n]); sh.setFrozenRows(1); return; }
    // เพิ่มคอลัมน์ใหม่ให้ชีตเดิมอัตโนมัติ (อัปเกรดจากเวอร์ชันก่อน)
    const cur = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
    SHEET_DEFS[n].forEach(h => { if (cur.indexOf(h) < 0) { sh.getRange(1, sh.getLastColumn() + 1).setValue(h); cur.push(h); } });
  });
  const users = ss.getSheetByName(SHEET_USERS);
  if (users.getLastRow() < 2) {
    // แอดมินเริ่มต้น: admin / 456789 (กรุณาเปลี่ยนรหัสผ่านทันทีหลังเข้าสู่ระบบ)
    users.appendRow([uid_(), 'admin', hash_('456789'), 'ผู้ดูแลระบบ', 'admin', 'Active', new Date()]);
  }
  const st = ss.getSheetByName(SHEET_SETTINGS);
  if (st.getLastRow() < 2) {
    st.appendRow(['rootFolderId', '']);
    st.appendRow(['autoSubfolder', 'true']);
  }
}

// ====== UTIL ======
function uid_() { return Utilities.getUuid().split('-')[0] + Date.now().toString(36); }
function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function sheet_(name) { return getSS_().getSheetByName(name); }
function rows_(name) {
  const v = sheet_(name).getDataRange().getValues();
  const h = v.shift();
  return v.map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, j) => o[k] = r[j]); return o; });
}
function headers_(name) { const sh = sheet_(name); return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; }
function writeRow_(name, rowNum, obj) {
  const h = headers_(name);
  sheet_(name).getRange(rowNum, 1, 1, h.length).setValues([h.map(k => obj[k] === undefined ? '' : obj[k])]);
}
function appendObj_(name, obj) { sheet_(name).appendRow(headers_(name).map(k => obj[k] === undefined ? '' : obj[k])); }
function getSetting_(k) { const r = rows_(SHEET_SETTINGS).find(x => x.key === k); return r ? String(r.value) : ''; }
function setSetting_(k, v) {
  const r = rows_(SHEET_SETTINGS).find(x => x.key === k);
  if (r) sheet_(SHEET_SETTINGS).getRange(r._row, 2).setValue(v);
  else appendObj_(SHEET_SETTINGS, { key: k, value: v });
}
function fmtDate_(d) { return d instanceof Date ? Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd') : String(d || ''); }
function isMedia_(m) { return /^image\/|^video\//.test(m); }
// ====== CACHE (ทำให้เว็บโหลดเร็ว: ไม่ต้องสแกน Google Drive ทุกครั้ง) ======
const CACHE_SEC = 300; // 5 นาที — ไฟล์ที่เพิ่มผ่านระบบจะล้างแคชทันที
function cacheGet_(k) { try { const v = CacheService.getScriptCache().get(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cachePut_(k, v) { try { const s = JSON.stringify(v); if (s.length < 95000) CacheService.getScriptCache().put(k, s, CACHE_SEC); } catch (e) {} }
function invalidate_(folderId) { try { CacheService.getScriptCache().removeAll(['pub_albums', 'fl_' + folderId]); } catch (e) {} }
/** รายการไฟล์แบบย่อของอัลบั้ม (เก็บแคช) — fresh=true อ่านจาก Drive ใหม่ */
function listFilesLite_(folderId, fresh) {
  const key = 'fl_' + folderId;
  if (!fresh) { const c = cacheGet_(key); if (c) return c; }
  const list = collectFiles_(folderId).map(x => ({ id: x.f.getId(), name: x.f.getName(), mime: x.f.getMimeType(), cat: x.cat, size: x.f.getSize(), created: x.f.getDateCreated().getTime() }));
  cachePut_(key, list);
  return list;
}
function liteOut_(x) {
  const id = x.id;
  return { id, name: x.name, mime: x.mime, type: x.mime.indexOf('video') === 0 ? 'video' : 'image', category: x.cat, size: x.size, created: x.created,
    thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w400',
    view: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w2000',
    preview: 'https://drive.google.com/file/d/' + id + '/preview',
    download: 'https://drive.google.com/uc?export=download&id=' + id };
}
function publicUrl_() { return getSetting_('publicUrl') || DEFAULT_PUBLIC_URL; }

// ====== AUTH ======
function login(username, password, role) {
  setupSheets_();
  const u = rows_(SHEET_USERS).find(x => String(x.username).toLowerCase() === String(username).trim().toLowerCase());
  if (!u || u.passwordHash !== hash_(password)) throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (u.status !== 'Active') throw new Error('บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน');
  if (role && u.role !== role) throw new Error('ประเภทผู้ใช้งานไม่ตรงกับบัญชีนี้');
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify({ id: u.id, username: u.username, name: u.name, role: u.role }), SESSION_HOURS * 3600);
  return { token, user: { id: u.id, username: u.username, name: u.name, role: u.role } };
}
function logout(token) { CacheService.getScriptCache().remove('sess_' + token); return true; }
function auth_(token, needAdmin) {
  const s = token && CacheService.getScriptCache().get('sess_' + token);
  if (!s) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  const sess = JSON.parse(s);
  const u = rows_(SHEET_USERS).find(x => x.id === sess.id);
  if (!u || u.status !== 'Active') throw new Error('บัญชีถูกระงับหรือไม่พบผู้ใช้');
  if (needAdmin && u.role !== 'admin') throw new Error('เฉพาะแอดมินเท่านั้น');
  return sess;
}
function isStaff_(token) { if (!token) return false; try { auth_(token); return true; } catch (e) { return false; } }

// ====== ALBUM ACCESS ======
function isAlbumVisible_(a) {
  if (a.status !== 'Active') return false;
  const today = fmtDate_(new Date());
  const s = fmtDate_(a.startDate), e = fmtDate_(a.endDate);
  if (s && today < s) return false;
  if (e && today > e) return false;
  return true;
}
/** ตรวจสิทธิ์เข้าอัลบั้ม: ทีมงานผ่านเสมอ / ผู้ใช้ทั่วไปต้องเป็นอัลบั้มที่เปิดแสดง และใส่รหัสผ่านถูก (ถ้ามี) */
function checkAlbumAccess_(a, token, pass) {
  if (isStaff_(token)) return true;
  if (!isAlbumVisible_(a)) throw new Error('อัลบั้มนี้ยังไม่เปิดแสดงผลหรือหมดเวลาแสดงผลแล้ว');
  if (a.passwordHash && hash_(String(pass || '')) !== a.passwordHash) throw new Error('PASSWORD_REQUIRED');
  return true;
}
function findAlbum_(albumId) {
  const a = rows_(SHEET_ALBUMS).find(x => x.id === albumId);
  if (!a) throw new Error('ไม่พบอัลบั้ม');
  return a;
}
function checkAlbumPassword(albumId, pass) {
  const a = findAlbum_(albumId);
  if (!isAlbumVisible_(a)) throw new Error('อัลบั้มนี้ยังไม่เปิดแสดงผล');
  if (a.passwordHash && hash_(String(pass || '')) !== a.passwordHash) throw new Error('รหัสผ่านไม่ถูกต้อง');
  return true;
}

// ====== ALBUM FILES (รวมหมวดย่อย = โฟลเดอร์ย่อยในโฟลเดอร์อัลบั้ม) ======
function collectFiles_(folderId) {
  const out = [];
  const root = DriveApp.getFolderById(folderId);
  const push = (it, cat) => {
    while (it.hasNext()) {
      const f = it.next(); const m = f.getMimeType();
      if (!isMedia_(m)) continue;
      out.push({ f, cat });
    }
  };
  push(root.getFiles(), DEFAULT_CATEGORY);
  const subs = root.getFolders();
  while (subs.hasNext()) { const s = subs.next(); push(s.getFiles(), s.getName()); }
  return out;
}
function listCategories_(folderId) {
  const names = []; const it = DriveApp.getFolderById(folderId).getFolders();
  while (it.hasNext()) names.push(it.next().getName());
  return names.sort();
}
function fileOut_(f, cat) {
  const id = f.getId(), m = f.getMimeType();
  return { id, name: f.getName(), mime: m, type: m.indexOf('video') === 0 ? 'video' : 'image', category: cat,
    size: f.getSize(), created: f.getDateCreated().getTime(),
    thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w600',
    view: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w2000',
    preview: 'https://drive.google.com/file/d/' + id + '/preview',
    download: 'https://drive.google.com/uc?export=download&id=' + id };
}
function albumOut_(a, withCount) {
  const o = { id: a.id, name: a.name, description: a.description, folderId: a.folderId, status: a.status,
    startDate: fmtDate_(a.startDate), endDate: fmtDate_(a.endDate), createdAt: fmtDate_(a.createdAt), locked: !!a.passwordHash };
  if (withCount) {
    try {
      const fs = listFilesLite_(a.folderId, withCount === 'fresh'); o.count = fs.length;
      const c = fs.find(x => x.mime.indexOf('image') === 0);
      o.cover = (c && !a.passwordHash) ? c.id : ''; // อัลบั้มล็อกไม่แสดงภาพปก
    } catch (e) { o.count = 0; o.cover = ''; }
  }
  return o;
}
function getPublicAlbums() {
  const c = cacheGet_('pub_albums');
  if (c && c.day === fmtDate_(new Date())) return c.list;
  setupSheets_();
  const list = rows_(SHEET_ALBUMS).filter(isAlbumVisible_).reverse().map(a => albumOut_(a, true));
  cachePut_('pub_albums', { day: fmtDate_(new Date()), list });
  return list;
}
function getAlbumFiles(albumId, token, pass) {
  const a = findAlbum_(albumId);
  checkAlbumAccess_(a, token, pass);
  const files = listFilesLite_(a.folderId, isStaff_(token)).map(liteOut_).sort((x, y) => y.created - x.created); // ทีมงานเห็นข้อมูลล่าสุดเสมอ
  const cats = [DEFAULT_CATEGORY].concat(listCategories_(a.folderId)).filter(c => files.some(f => f.category === c));
  return { album: albumOut_(a, false), files, categories: cats };
}

// ====== STATS ======
/** บันทึกสถิติ: album_view, download, download_social, zip */
function logEvent(albumId, fileId, action) {
  try {
    if (!/^(album_view|download|download_social|zip)$/.test(action)) return false;
    const now = new Date();
    sheet_(SHEET_STATS).appendRow([now, Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd'), albumId || '', fileId || '', action]);
    return true;
  } catch (e) { return false; }
}
function getStats(token, days) {
  auth_(token);
  days = Math.min(Math.max(Number(days) || 30, 7), 365);
  const since = Utilities.formatDate(new Date(Date.now() - (days - 1) * 864e5), 'Asia/Bangkok', 'yyyy-MM-dd');
  const albums = rows_(SHEET_ALBUMS); const nameOf = {}; albums.forEach(a => nameOf[a.id] = a.name);
  const all = rows_(SHEET_STATS);
  const recent = all.filter(r => fmtDate_(r.date) >= since);
  const byAlbum = {}, byFile = {}, byDay = {};
  for (let i = 0; i < days; i++) byDay[Utilities.formatDate(new Date(Date.now() - (days - 1 - i) * 864e5), 'Asia/Bangkok', 'yyyy-MM-dd')] = { views: 0, downloads: 0 };
  const tot = { views: 0, downloads: 0, social: 0, zip: 0 };
  recent.forEach(r => {
    const d = fmtDate_(r.date), a = r.albumId;
    const A = byAlbum[a] = byAlbum[a] || { albumId: a, name: nameOf[a] || '(ลบแล้ว)', views: 0, downloads: 0, social: 0, zip: 0 };
    if (r.action === 'album_view') { A.views++; tot.views++; if (byDay[d]) byDay[d].views++; }
    else {
      if (r.action === 'download') { A.downloads++; tot.downloads++; }
      if (r.action === 'download_social') { A.social++; tot.social++; }
      if (r.action === 'zip') { A.zip++; tot.zip++; }
      if (byDay[d]) byDay[d].downloads++;
      if (r.fileId) byFile[r.fileId] = (byFile[r.fileId] || 0) + 1;
    }
  });
  const top = Object.keys(byFile).sort((x, y) => byFile[y] - byFile[x]).slice(0, 10).map(id => {
    let name = id; try { name = DriveApp.getFileById(id).getName(); } catch (e) {}
    return { id, name, count: byFile[id], thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w200' };
  });
  return { days, totals: tot, albums: Object.values(byAlbum).sort((x, y) => (y.views + y.downloads) - (x.views + x.downloads)),
    daily: Object.keys(byDay).map(d => ({ date: d, views: byDay[d].views, downloads: byDay[d].downloads })), topFiles: top };
}

// ====== DOWNLOAD ALL AS ZIP ======
function getZipPlan(albumId, token, pass, ids) {
  const data = getAlbumFiles(albumId, token, pass);
  if (ids && ids.length) { const want = {}; ids.forEach(i => want[i] = 1); data.files = data.files.filter(f => want[f.id]); } // เฉพาะภาพที่เลือก
  const parts = []; let cur = [], size = 0;
  data.files.forEach(f => {
    if (cur.length && size + f.size > ZIP_PART_LIMIT) { parts.push(cur); cur = []; size = 0; }
    cur.push(f.id); size += f.size;
  });
  if (cur.length) parts.push(cur);
  const totalSize = data.files.reduce((s, f) => s + f.size, 0);
  const tooBig = data.files.filter(f => f.size > ZIP_PART_LIMIT).map(f => f.name);
  return { albumName: data.album.name, totalFiles: data.files.length, totalSize, parts: parts.length, partFileIds: parts, tooBig,
    catOf: data.files.reduce((m, f) => (m[f.id] = f.category, m), {}), multiCat: data.categories.length > 1 };
}
function buildAlbumZip(albumId, partIndex, token, pass, ids) {
  const plan = getZipPlan(albumId, token, pass, ids);
  const picked = ids && ids.length;
  const partIds = plan.partFileIds[partIndex];
  if (!partIds) throw new Error('ไม่พบส่วนของไฟล์ ZIP');
  const used = {};
  const blobs = partIds.map(id => {
    const f = DriveApp.getFileById(id);
    let name = (plan.multiCat ? plan.catOf[id] + '/' : '') + f.getName(); // แยกโฟลเดอร์ตามหมวดใน ZIP
    if (used[name]) { const i = name.lastIndexOf('.'); name = (i > 0 ? name.slice(0, i) : name) + '_' + (used[name]++) + (i > 0 ? name.slice(i) : ''); }
    else used[name] = 1;
    return f.getBlob().setName(name); // ไฟล์ต้นฉบับ ไม่บีบอัด/ไม่ลดขนาด
  });
  const safe = String(plan.albumName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'album';
  const base = picked ? `${safe}_เลือก${plan.totalFiles}ภาพ` : safe;
  const zipName = plan.parts > 1 ? `${base}_part${partIndex + 1}of${plan.parts}.zip` : `${base}.zip`;
  const zip = Utilities.zip(blobs, zipName);
  if (partIndex === 0) logEvent(albumId, '', 'zip');
  return { name: zipName, base64: Utilities.base64Encode(zip.getBytes()), part: partIndex + 1, parts: plan.parts };
}

// ====== DOWNLOAD SINGLE FILE (ไม่ต้องเปิด Google Drive) ======
function albumOfFile_(f) {
  const parentIds = [];
  const it = f.getParents();
  while (it.hasNext()) { const p = it.next(); parentIds.push(p.getId()); const gp = p.getParents(); while (gp.hasNext()) parentIds.push(gp.next().getId()); }
  return rows_(SHEET_ALBUMS).find(a => parentIds.indexOf(a.folderId) > -1);
}
/** ส่งไฟล์ต้นฉบับเป็น Base64 — mode 'social' จะถูกย่อเหลือ 2048px ในเบราว์เซอร์ */
function getFileData(fileId, token, pass, mode) {
  const f = DriveApp.getFileById(fileId);
  const a = albumOfFile_(f);
  if (!a) throw new Error('ไม่พบอัลบั้มของไฟล์นี้');
  checkAlbumAccess_(a, token, pass);
  logEvent(a.id, fileId, mode === 'social' ? 'download_social' : 'download');
  if (f.getSize() > ZIP_PART_LIMIT) return { tooBig: true, url: 'https://drive.google.com/uc?export=download&id=' + fileId, name: f.getName() };
  return { name: f.getName(), mime: f.getMimeType(), base64: Utilities.base64Encode(f.getBlob().getBytes()) };
}

// ====== ALBUMS (ADMIN) ======
function adminGetAlbums(token) { auth_(token); return rows_(SHEET_ALBUMS).reverse().map(a => albumOut_(a, 'fresh')); }

function saveAlbum(token, data) {
  const s = auth_(token, true);
  if (!data.name || !String(data.name).trim()) throw new Error('กรุณาระบุชื่ออัลบั้ม');
  if (data.startDate && data.endDate && data.startDate > data.endDate) throw new Error('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
  if (data.password && String(data.password).length < 4) throw new Error('รหัสผ่านอัลบั้มต้องมีอย่างน้อย 4 ตัวอักษร');
  if (data.id) {
    const a = findAlbum_(data.id);
    Object.assign(a, { name: data.name, description: data.description || '', status: data.status || 'Active', startDate: data.startDate || '', endDate: data.endDate || '' });
    if (data.removePassword) a.passwordHash = '';
    else if (data.password) a.passwordHash = hash_(data.password);
    try { if (getSetting_('autoSubfolder') === 'true') DriveApp.getFolderById(a.folderId).setName(data.name); } catch (e) {}
    writeRow_(SHEET_ALBUMS, a._row, a); invalidate_(a.folderId);
    return albumOut_(a, false);
  }
  const root = getRoot_();
  const folderId = getSetting_('autoSubfolder') === 'true' ? root.createFolder(data.name).getId() : root.getId();
  const a = { id: uid_(), name: data.name, description: data.description || '', folderId, status: data.status || 'Active',
    startDate: data.startDate || '', endDate: data.endDate || '', createdAt: new Date(), createdBy: s.username,
    passwordHash: data.password ? hash_(data.password) : '' };
  appendObj_(SHEET_ALBUMS, a); invalidate_(folderId);
  return albumOut_(a, false);
}
function toggleAlbum(token, id) {
  auth_(token, true);
  const a = findAlbum_(id);
  a.status = a.status === 'Active' ? 'Hidden' : 'Active';
  writeRow_(SHEET_ALBUMS, a._row, a); invalidate_(a.folderId); return a.status;
}
function deleteAlbum(token, id, deleteFolder) {
  auth_(token, true);
  const a = findAlbum_(id);
  if (deleteFolder && a.folderId !== getSetting_('rootFolderId')) { try { DriveApp.getFolderById(a.folderId).setTrashed(true); } catch (e) {} }
  sheet_(SHEET_ALBUMS).deleteRow(a._row); invalidate_(a.folderId);
  return true;
}

// ====== CATEGORIES (หมวดภาพ = โฟลเดอร์ย่อย) ======
function getCategories(token, albumId) { auth_(token); return listCategories_(findAlbum_(albumId).folderId); }
function getOrCreateCategory_(album, name) {
  name = String(name || '').trim();
  if (!name || name === DEFAULT_CATEGORY) return DriveApp.getFolderById(album.folderId);
  if (/[\\/]/.test(name)) throw new Error('ชื่อหมวดห้ามมีเครื่องหมาย / หรือ \\');
  const root = DriveApp.getFolderById(album.folderId);
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}
function createCategory(token, albumId, name) { auth_(token); getOrCreateCategory_(findAlbum_(albumId), name); return listCategories_(findAlbum_(albumId).folderId); }
function renameCategory(token, albumId, oldName, newName) {
  auth_(token, true);
  newName = String(newName || '').trim();
  if (!newName || /[\\/]/.test(newName)) throw new Error('ชื่อหมวดไม่ถูกต้อง');
  const it = DriveApp.getFolderById(findAlbum_(albumId).folderId).getFoldersByName(oldName);
  if (!it.hasNext()) throw new Error('ไม่พบหมวด');
  it.next().setName(newName); invalidate_(findAlbum_(albumId).folderId); return listCategories_(findAlbum_(albumId).folderId);
}
/** ลบหมวด: ย้ายไฟล์ในหมวดกลับไปหมวด "ทั่วไป" แล้วลบโฟลเดอร์ (ไฟล์ไม่หาย) */
function deleteCategory(token, albumId, name) {
  auth_(token, true);
  const a = findAlbum_(albumId), root = DriveApp.getFolderById(a.folderId);
  const it = root.getFoldersByName(name);
  if (!it.hasNext()) throw new Error('ไม่พบหมวด');
  const sub = it.next(), files = sub.getFiles();
  while (files.hasNext()) files.next().moveTo(root);
  sub.setTrashed(true); invalidate_(a.folderId);
  return listCategories_(a.folderId);
}
// ย้ายหลายไฟล์พร้อมกัน
function moveFiles(token, albumId, ids, name) {
  auth_(token);
  const a = findAlbum_(albumId), target = getOrCreateCategory_(a, name);
  (ids || []).forEach(id => { try { DriveApp.getFileById(id).moveTo(target); } catch (e) {} });
  invalidate_(a.folderId); return (ids || []).length;
}
// ลบหลายไฟล์พร้อมกัน (ย้ายไปถังขยะของ Drive กู้คืนได้ 30 วัน)
function deleteFiles(token, ids) {
  auth_(token);
  const folders = {}; let n = 0;
  (ids || []).forEach(id => { try { const f = DriveApp.getFileById(id), a = albumOfFile_(f); f.setTrashed(true); n++; if (a) folders[a.folderId] = 1; } catch (e) {} });
  Object.keys(folders).forEach(invalidate_);
  return n;
}
function moveFileToCategory(token, albumId, fileId, name) {
  auth_(token);
  const a = findAlbum_(albumId), target = getOrCreateCategory_(a, name);
  DriveApp.getFileById(fileId).moveTo(target); invalidate_(a.folderId); return true;
}

// ====== UPLOAD / DELETE FILES (STAFF+) ======
function uploadFile(token, albumId, name, mime, base64, category) {
  auth_(token);
  if (!/^(image\/(jpeg|png)|video\/(mp4|quicktime))$/.test(mime)) throw new Error('รองรับเฉพาะ JPG, PNG, MP4, MOV');
  const a = findAlbum_(albumId);
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, name); // ไฟล์จริง ไม่บีบอัด
  const f = getOrCreateCategory_(a, category).createFile(blob);
  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  invalidate_(a.folderId);
  return { id: f.getId(), name: f.getName() };
}
function deleteFile(token, fileId) {
  auth_(token);
  const f = DriveApp.getFileById(fileId), a = albumOfFile_(f);
  f.setTrashed(true); if (a) invalidate_(a.folderId); return true;
}

// ====== DIRECT UPLOAD (อัปโหลดตรงเข้า Google Drive — ไม่จำกัด 45MB, รองรับวิดีโอไฟล์ใหญ่) ======
/** สร้าง Resumable Upload Session ให้เบราว์เซอร์ส่งไฟล์ตรงเข้า Drive (ไม่ผ่าน Apps Script) */
function createUploadSession(token, albumId, name, mime, size, category, origin) {
  auth_(token);
  if (!/^(image\/(jpeg|png|heic|heif|webp)|video\/(mp4|quicktime|x-m4v|webm))$/.test(mime)) throw new Error('รองรับเฉพาะภาพ JPG/PNG/HEIC/WEBP และวิดีโอ MP4/MOV/M4V/WEBM');
  const a = findAlbum_(albumId), folder = getOrCreateCategory_(a, category);
  const headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) };
  if (origin) headers.Origin = origin; // ให้ Google อนุญาต CORS กับหน้าเว็บที่อัปโหลด
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name';
  const opt = h => ({ method: 'post', contentType: 'application/json; charset=UTF-8', headers: h,
    payload: JSON.stringify({ name, mimeType: mime, parents: [folder.getId()] }), muteHttpExceptions: true });
  let r;
  try { r = UrlFetchApp.fetch(url, opt(headers)); }
  catch (e) { delete headers.Origin; r = UrlFetchApp.fetch(url, opt(headers)); } // บางระบบไม่อนุญาตส่ง Origin
  const loc = r.getHeaders()['Location'] || r.getHeaders()['location'];
  if (r.getResponseCode() !== 200 || !loc) throw new Error('สร้างการอัปโหลดไม่สำเร็จ (' + r.getResponseCode() + ')');
  return loc;
}
/** หลังเบราว์เซอร์อัปโหลดเสร็จ: ตั้งสิทธิ์ให้ดาวน์โหลดได้ + ล้างแคช */
function finalizeUpload(token, albumId, fileId) {
  auth_(token);
  const a = findAlbum_(albumId);
  try { DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  invalidate_(a.folderId); return true;
}

// ====== USERS (ADMIN) ======
function getUsers(token) {
  auth_(token, true);
  return rows_(SHEET_USERS).map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, status: u.status, createdAt: fmtDate_(u.createdAt) }));
}
function saveUser(token, d) {
  const s = auth_(token, true);
  const all = rows_(SHEET_USERS);
  if (!d.username || !d.name) throw new Error('กรุณากรอกข้อมูลให้ครบ');
  if (all.some(u => String(u.username).toLowerCase() === d.username.toLowerCase() && u.id !== d.id)) throw new Error('ชื่อผู้ใช้นี้มีอยู่แล้ว');
  if (d.id) {
    const u = all.find(x => x.id === d.id); if (!u) throw new Error('ไม่พบผู้ใช้');
    if (u.id === s.id && (d.status !== 'Active' || d.role !== 'admin')) throw new Error('ไม่สามารถระงับหรือลดสิทธิ์บัญชีของตนเองได้');
    Object.assign(u, { username: d.username, name: d.name, role: d.role, status: d.status });
    if (d.password) u.passwordHash = hash_(d.password);
    writeRow_(SHEET_USERS, u._row, u); return true;
  }
  if (!d.password || d.password.length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  appendObj_(SHEET_USERS, { id: uid_(), username: d.username, passwordHash: hash_(d.password), name: d.name, role: d.role || 'staff', status: d.status || 'Active', createdAt: new Date() });
  return true;
}
function toggleUser(token, id) {
  const s = auth_(token, true);
  if (id === s.id) throw new Error('ไม่สามารถระงับบัญชีของตนเองได้');
  const u = rows_(SHEET_USERS).find(x => x.id === id); if (!u) throw new Error('ไม่พบผู้ใช้');
  u.status = u.status === 'Active' ? 'Suspended' : 'Active';
  writeRow_(SHEET_USERS, u._row, u); return u.status;
}
function resetPassword(token, id, newPass) {
  auth_(token, true);
  if (!newPass || newPass.length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  const u = rows_(SHEET_USERS).find(x => x.id === id); if (!u) throw new Error('ไม่พบผู้ใช้');
  u.passwordHash = hash_(newPass); writeRow_(SHEET_USERS, u._row, u); return true;
}
function deleteUser(token, id) {
  const s = auth_(token, true);
  if (id === s.id) throw new Error('ไม่สามารถลบบัญชีของตนเองได้');
  const u = rows_(SHEET_USERS).find(x => x.id === id); if (!u) throw new Error('ไม่พบผู้ใช้');
  sheet_(SHEET_USERS).deleteRow(u._row); return true;
}
function changeMyPassword(token, oldPass, newPass) {
  const s = auth_(token);
  const u = rows_(SHEET_USERS).find(x => x.id === s.id);
  if (u.passwordHash !== hash_(oldPass)) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  if (!newPass || newPass.length < 6) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  u.passwordHash = hash_(newPass); writeRow_(SHEET_USERS, u._row, u); return true;
}

// ====== SETTINGS ======
function getRoot_() {
  const id = getSetting_('rootFolderId');
  if (!id) throw new Error('ยังไม่ได้ตั้งค่า Google Drive Folder ID หลัก (เมนูตั้งค่าระบบ)');
  return DriveApp.getFolderById(id);
}
function getSettings(token) {
  auth_(token, true);
  return { rootFolderId: getSetting_('rootFolderId'), autoSubfolder: getSetting_('autoSubfolder') === 'true',
    publicUrl: publicUrl_(), lineEnabled: getSetting_('lineEnabled') === 'true', lineMode: getSetting_('lineMode') || 'broadcast',
    lineTo: getSetting_('lineTo'), lineHasToken: !!getSetting_('lineToken') };
}
function saveSettings(token, d) {
  auth_(token, true);
  setSetting_('rootFolderId', String(d.rootFolderId || '').trim());
  setSetting_('autoSubfolder', d.autoSubfolder ? 'true' : 'false');
  let pu = String(d.publicUrl || '').trim(); if (pu && !/\/$/.test(pu)) pu += '/';
  setSetting_('publicUrl', pu);
  setSetting_('lineEnabled', d.lineEnabled ? 'true' : 'false');
  setSetting_('lineMode', d.lineMode === 'push' ? 'push' : 'broadcast');
  setSetting_('lineTo', String(d.lineTo || '').trim());
  if (d.lineToken) setSetting_('lineToken', String(d.lineToken).trim()); // เว้นว่าง = ใช้ Token เดิม (ไม่แสดง Token เดิมเพื่อความปลอดภัย)
  return true;
}
function testFolder(token, id) {
  auth_(token, true);
  try { const f = DriveApp.getFolderById(String(id).trim()); return { ok: true, name: f.getName(), url: f.getUrl() }; }
  catch (e) { throw new Error('เชื่อมต่อไม่สำเร็จ: ไม่พบโฟลเดอร์หรือไม่มีสิทธิ์เข้าถึง'); }
}

// ====== LINE NOTIFICATION (LINE Messaging API) ======
// broadcast = ส่งถึงทุกคนที่เพิ่มเพื่อน LINE OA / push = ส่งถึงกลุ่มหรือผู้ใช้ตาม ID ที่กำหนด
function sendLine_(text) {
  const tk = getSetting_('lineToken');
  if (!tk) throw new Error('ยังไม่ได้ตั้งค่า LINE Channel Access Token');
  const mode = getSetting_('lineMode') || 'broadcast';
  const body = { messages: [{ type: 'text', text: String(text).slice(0, 4900) }] };
  let url = 'https://api.line.me/v2/bot/message/broadcast';
  if (mode === 'push') {
    const to = getSetting_('lineTo');
    if (!to) throw new Error('ยังไม่ได้ระบุ LINE Group ID / User ID');
    body.to = to; url = 'https://api.line.me/v2/bot/message/push';
  }
  const r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + tk }, payload: JSON.stringify(body), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('LINE ตอบกลับ ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return true;
}
function testLine(token) { auth_(token, true); return sendLine_('✅ ทดสอบการแจ้งเตือนจาก PhotoDrop สำเร็จ\n' + publicUrl_()); }
/** เรียกหลังอัปโหลดเสร็จ — แจ้งเตือนเฉพาะอัลบั้มที่เปิดแสดงผลอยู่ */
function notifyNewPhotos(token, albumId, count) {
  auth_(token);
  if (getSetting_('lineEnabled') !== 'true' || !count) return false;
  const a = findAlbum_(albumId);
  if (!isAlbumVisible_(a)) return false;
  const msg = `📸 ภาพใหม่ ${count} ไฟล์ ในอัลบั้ม "${a.name}"\n` + (a.passwordHash ? '🔒 อัลบั้มนี้มีรหัสผ่าน\n' : '') +
    `ดูและดาวน์โหลดภาพต้นฉบับ 👉 ${publicUrl_()}?album=${a.id}`;
  try { return sendLine_(msg); } catch (e) { return false; }
}

// ====== FACE SEARCH (ค้นหาภาพของฉันด้วยใบหน้า) ======
// ประมวลผลใบหน้าในเบราว์เซอร์ (face-api.js) — ภาพเซลฟี่ของผู้ใช้ไม่ถูกส่งหรือบันทึกที่เซิร์ฟเวอร์
function faceFile_(folderId) {
  const it = DriveApp.getFolderById(folderId).getFilesByName(FACE_FILE);
  return it.hasNext() ? it.next() : null;
}
function getFaceData(albumId, token, pass) {
  const data = getAlbumFiles(albumId, token, pass);
  const f = faceFile_(data.album.folderId);
  let index = {};
  if (f) { try { index = JSON.parse(f.getBlob().getDataAsString()); } catch (e) {} }
  const imageIds = data.files.filter(x => x.type === 'image').map(x => x.id);
  Object.keys(index).forEach(k => { if (imageIds.indexOf(k) < 0) delete index[k]; });
  return { index, imageIds };
}
function getFaceThumbs(albumId, ids, token, pass) {
  const data = getAlbumFiles(albumId, token, pass);
  const allowed = {}; data.files.forEach(x => allowed[x.id] = 1);
  const oauth = ScriptApp.getOAuthToken();
  return ids.filter(id => allowed[id]).map(id => {
    try {
      const r = UrlFetchApp.fetch('https://drive.google.com/thumbnail?id=' + id + '&sz=w1000',
        { headers: { Authorization: 'Bearer ' + oauth }, muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() !== 200) throw new Error();
      return { id, data: 'data:image/jpeg;base64,' + Utilities.base64Encode(r.getContent()) };
    } catch (e) {
      const b = DriveApp.getFileById(id).getThumbnail();
      return { id, data: b ? 'data:image/png;base64,' + Utilities.base64Encode(b.getBytes()) : '' };
    }
  });
}
function saveFaceIndex(token, albumId, partial) {
  auth_(token);
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const a = findAlbum_(albumId);
    const f = faceFile_(a.folderId); let index = {};
    if (f) { try { index = JSON.parse(f.getBlob().getDataAsString()); } catch (e) {} }
    Object.assign(index, partial || {});
    const json = JSON.stringify(index);
    if (f) f.setContent(json); else DriveApp.getFolderById(a.folderId).createFile(FACE_FILE, json, 'application/json');
    return Object.keys(index).length;
  } finally { lock.releaseLock(); }
}
