/**
 * PhotoDrop Event Gallery System by KPDev.
 * ดาวน์โหลดภาพถ่ายกิจกรรมความคมชัดสูง ผ่านการสแกน QR Code
 * Google Apps Script + Google Drive + Google Sheets
 * © 2026 Power By น.ส.กันธิมา พุ่มเพ็ชร์ นักทรัพยากรบุคคลชำนาญการ
 */

// ====== CONFIG ======
const SHEET_ALBUMS = 'Albums';
const SHEET_USERS = 'Users';
const SHEET_SETTINGS = 'Settings';
const SESSION_HOURS = 8;
const ZIP_PART_LIMIT = 35 * 1024 * 1024; // ~35MB ต่อไฟล์ ZIP (เผื่อ Base64 โต ~33% ไม่เกินลิมิต 50MB ของ google.script.run)

// ====== WEB APP ======
function doGet(e) {
  setupSheets_();
  const t = HtmlService.createTemplateFromFile('Index');
  t.albumParam = (e && e.parameter && e.parameter.album) || '';
  return t.evaluate()
    .setTitle('PhotoDrop Event Gallery System by KPDev.')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getWebAppUrl() { return ScriptApp.getService().getUrl(); }

// ====== SETUP ======
function getSS_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SS_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  let ss;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (!ss) ss = SpreadsheetApp.create('PhotoDrop Database');
  props.setProperty('SS_ID', ss.getId());
  return ss;
}

function setupSheets_() {
  const ss = getSS_();
  const defs = {
    [SHEET_ALBUMS]: ['id', 'name', 'description', 'folderId', 'status', 'startDate', 'endDate', 'createdAt', 'createdBy'],
    [SHEET_USERS]: ['id', 'username', 'passwordHash', 'name', 'role', 'status', 'createdAt'],
    [SHEET_SETTINGS]: ['key', 'value']
  };
  Object.keys(defs).forEach(n => {
    let sh = ss.getSheetByName(n);
    if (!sh) { sh = ss.insertSheet(n); sh.appendRow(defs[n]); sh.setFrozenRows(1); }
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
function rows_(name) {
  const sh = getSS_().getSheetByName(name);
  const v = sh.getDataRange().getValues();
  const h = v.shift();
  return v.map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, j) => o[k] = r[j]); return o; });
}
function headers_(name) { return getSS_().getSheetByName(name).getRange(1, 1, 1, getSS_().getSheetByName(name).getLastColumn()).getValues()[0]; }
function writeRow_(name, rowNum, obj) {
  const h = headers_(name);
  getSS_().getSheetByName(name).getRange(rowNum, 1, 1, h.length).setValues([h.map(k => obj[k] === undefined ? '' : obj[k])]);
}
function appendObj_(name, obj) { getSS_().getSheetByName(name).appendRow(headers_(name).map(k => obj[k] === undefined ? '' : obj[k])); }
function getSetting_(k) { const r = rows_(SHEET_SETTINGS).find(x => x.key === k); return r ? String(r.value) : ''; }
function setSetting_(k, v) {
  const r = rows_(SHEET_SETTINGS).find(x => x.key === k);
  if (r) getSS_().getSheetByName(SHEET_SETTINGS).getRange(r._row, 2).setValue(v);
  else appendObj_(SHEET_SETTINGS, { key: k, value: v });
}
function fmtDate_(d) { return d instanceof Date ? Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd') : String(d || ''); }

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

// ====== ALBUMS (PUBLIC) ======
function isAlbumVisible_(a) {
  if (a.status !== 'Active') return false;
  const today = fmtDate_(new Date());
  const s = fmtDate_(a.startDate), e = fmtDate_(a.endDate);
  if (s && today < s) return false;
  if (e && today > e) return false;
  return true;
}
function albumOut_(a, withCount) {
  const o = { id: a.id, name: a.name, description: a.description, folderId: a.folderId, status: a.status,
    startDate: fmtDate_(a.startDate), endDate: fmtDate_(a.endDate), createdAt: fmtDate_(a.createdAt) };
  if (withCount) {
    try {
      const it = DriveApp.getFolderById(a.folderId).getFiles(); let n = 0, cover = '';
      while (it.hasNext()) { const f = it.next(); if (isMedia_(f.getMimeType())) { n++; if (!cover && f.getMimeType().indexOf('image') === 0) cover = f.getId(); } }
      o.count = n; o.cover = cover;
    } catch (e) { o.count = 0; o.cover = ''; }
  }
  return o;
}
function getPublicAlbums() {
  setupSheets_();
  return rows_(SHEET_ALBUMS).filter(isAlbumVisible_).reverse().map(a => albumOut_(a, true));
}
function isMedia_(m) { return /^image\/|^video\//.test(m); }

function getAlbumFiles(albumId, token) {
  const a = rows_(SHEET_ALBUMS).find(x => x.id === albumId);
  if (!a) throw new Error('ไม่พบอัลบั้ม');
  let staff = false;
  if (token) { try { auth_(token); staff = true; } catch (e) {} }
  if (!staff && !isAlbumVisible_(a)) throw new Error('อัลบั้มนี้ยังไม่เปิดแสดงผลหรือหมดเวลาแสดงผลแล้ว');
  const files = [];
  const it = DriveApp.getFolderById(a.folderId).getFiles();
  while (it.hasNext()) {
    const f = it.next(); const m = f.getMimeType();
    if (!isMedia_(m)) continue;
    files.push({ id: f.getId(), name: f.getName(), mime: m, type: m.indexOf('video') === 0 ? 'video' : 'image',
      size: f.getSize(), created: f.getDateCreated().getTime(),
      thumb: 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w600',
      view: 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w2000',
      preview: 'https://drive.google.com/file/d/' + f.getId() + '/preview',
      download: 'https://drive.google.com/uc?export=download&id=' + f.getId() });
  }
  files.sort((x, y) => y.created - x.created);
  return { album: albumOut_(a, false), files };
}

// ====== DOWNLOAD ALL AS ZIP ======
/**
 * ขั้นที่ 1: วางแผนการแบ่งไฟล์ ZIP (Apps Script ส่งข้อมูลกลับได้ไม่เกิน ~50MB ต่อครั้ง)
 * ถ้าอัลบั้มใหญ่จะแบ่งเป็นหลายส่วน part1.zip, part2.zip ...
 */
function getZipPlan(albumId, token) {
  const data = getAlbumFiles(albumId, token);
  const parts = []; let cur = [], size = 0;
  data.files.forEach(f => {
    if (cur.length && size + f.size > ZIP_PART_LIMIT) { parts.push(cur); cur = []; size = 0; }
    cur.push(f.id); size += f.size;
  });
  if (cur.length) parts.push(cur);
  const totalSize = data.files.reduce((s, f) => s + f.size, 0);
  const tooBig = data.files.filter(f => f.size > ZIP_PART_LIMIT).map(f => f.name);
  return { albumName: data.album.name, totalFiles: data.files.length, totalSize, parts: parts.length, partFileIds: parts, tooBig };
}

/**
 * ขั้นที่ 2: สร้าง ZIP ของส่วนที่ระบุ ด้วย Utilities.zip() แล้วส่งกลับเป็น Base64
 */
function buildAlbumZip(albumId, partIndex, token) {
  const plan = getZipPlan(albumId, token);
  const ids = plan.partFileIds[partIndex];
  if (!ids) throw new Error('ไม่พบส่วนของไฟล์ ZIP');
  const used = {};
  const blobs = ids.map(id => {
    const f = DriveApp.getFileById(id);
    let name = f.getName();
    if (used[name]) { const i = name.lastIndexOf('.'); name = (i > 0 ? name.slice(0, i) : name) + '_' + (used[f.getName()]++) + (i > 0 ? name.slice(i) : ''); }
    else used[name] = 1;
    return f.getBlob().setName(name); // ไฟล์ต้นฉบับ ไม่บีบอัด/ไม่ลดขนาด
  });
  const safe = String(plan.albumName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'album';
  const zipName = plan.parts > 1 ? `${safe}_part${partIndex + 1}of${plan.parts}.zip` : `${safe}.zip`;
  const zip = Utilities.zip(blobs, zipName);
  return { name: zipName, base64: Utilities.base64Encode(zip.getBytes()), part: partIndex + 1, parts: plan.parts };
}

// ====== ALBUMS (ADMIN) ======
function adminGetAlbums(token) { auth_(token); return rows_(SHEET_ALBUMS).reverse().map(a => albumOut_(a, true)); }

function saveAlbum(token, data) {
  const s = auth_(token, true);
  if (!data.name || !String(data.name).trim()) throw new Error('กรุณาระบุชื่ออัลบั้ม');
  if (data.startDate && data.endDate && data.startDate > data.endDate) throw new Error('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
  if (data.id) {
    const a = rows_(SHEET_ALBUMS).find(x => x.id === data.id);
    if (!a) throw new Error('ไม่พบอัลบั้ม');
    Object.assign(a, { name: data.name, description: data.description || '', status: data.status || 'Active', startDate: data.startDate || '', endDate: data.endDate || '' });
    try { if (getSetting_('autoSubfolder') === 'true') DriveApp.getFolderById(a.folderId).setName(data.name); } catch (e) {}
    writeRow_(SHEET_ALBUMS, a._row, a);
    return albumOut_(a, false);
  }
  const root = getRoot_();
  let folderId;
  if (getSetting_('autoSubfolder') === 'true') folderId = root.createFolder(data.name).getId();
  else folderId = root.getId();
  const a = { id: uid_(), name: data.name, description: data.description || '', folderId, status: data.status || 'Active',
    startDate: data.startDate || '', endDate: data.endDate || '', createdAt: new Date(), createdBy: s.username };
  appendObj_(SHEET_ALBUMS, a);
  return albumOut_(a, false);
}

function toggleAlbum(token, id) {
  auth_(token, true);
  const a = rows_(SHEET_ALBUMS).find(x => x.id === id); if (!a) throw new Error('ไม่พบอัลบั้ม');
  a.status = a.status === 'Active' ? 'Hidden' : 'Active';
  writeRow_(SHEET_ALBUMS, a._row, a); return a.status;
}

function deleteAlbum(token, id, deleteFolder) {
  auth_(token, true);
  const a = rows_(SHEET_ALBUMS).find(x => x.id === id); if (!a) throw new Error('ไม่พบอัลบั้ม');
  if (deleteFolder && a.folderId !== getSetting_('rootFolderId')) { try { DriveApp.getFolderById(a.folderId).setTrashed(true); } catch (e) {} }
  getSS_().getSheetByName(SHEET_ALBUMS).deleteRow(a._row);
  return true;
}

// ====== UPLOAD / DELETE FILES (STAFF+) ======
function uploadFile(token, albumId, name, mime, base64) {
  auth_(token);
  if (!/^(image\/(jpeg|png)|video\/(mp4|quicktime))$/.test(mime)) throw new Error('รองรับเฉพาะ JPG, PNG, MP4, MOV');
  const a = rows_(SHEET_ALBUMS).find(x => x.id === albumId); if (!a) throw new Error('ไม่พบอัลบั้ม');
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, name); // ไฟล์จริง ไม่บีบอัด
  const f = DriveApp.getFolderById(a.folderId).createFile(blob);
  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { id: f.getId(), name: f.getName() };
}

function deleteFile(token, fileId) {
  auth_(token);
  DriveApp.getFileById(fileId).setTrashed(true);
  return true;
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
  if (all.some(u => u.username.toLowerCase() === d.username.toLowerCase() && u.id !== d.id)) throw new Error('ชื่อผู้ใช้นี้มีอยู่แล้ว');
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
  getSS_().getSheetByName(SHEET_USERS).deleteRow(u._row); return true;
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
function getSettings(token) { auth_(token, true); return { rootFolderId: getSetting_('rootFolderId'), autoSubfolder: getSetting_('autoSubfolder') === 'true' }; }
function saveSettings(token, d) {
  auth_(token, true);
  setSetting_('rootFolderId', String(d.rootFolderId || '').trim());
  setSetting_('autoSubfolder', d.autoSubfolder ? 'true' : 'false');
  return true;
}
function testFolder(token, id) {
  auth_(token, true);
  try { const f = DriveApp.getFolderById(String(id).trim()); return { ok: true, name: f.getName(), url: f.getUrl() }; }
  catch (e) { throw new Error('เชื่อมต่อไม่สำเร็จ: ไม่พบโฟลเดอร์หรือไม่มีสิทธิ์เข้าถึง'); }
}

// ====== DOWNLOAD SINGLE FILE (ไม่ต้องเปิด Google Drive) ======
/** ส่งไฟล์ต้นฉบับกลับเป็น Base64 เพื่อบันทึกลงเครื่องได้ทันที (รองรับเบราว์เซอร์ในแอป LINE / Messenger) */
function getFileData(fileId, token) {
  const f = DriveApp.getFileById(fileId);
  let staff = false;
  if (token) { try { auth_(token); staff = true; } catch (e) {} }
  if (!staff) {
    const parents = []; const it = f.getParents(); while (it.hasNext()) parents.push(it.next().getId());
    const ok = rows_(SHEET_ALBUMS).some(a => isAlbumVisible_(a) && parents.indexOf(a.folderId) > -1);
    if (!ok) throw new Error('ไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้');
  }
  if (f.getSize() > ZIP_PART_LIMIT) return { tooBig: true, url: 'https://drive.google.com/uc?export=download&id=' + fileId, name: f.getName() };
  return { name: f.getName(), mime: f.getMimeType(), base64: Utilities.base64Encode(f.getBlob().getBytes()) };
}

// ====== FACE SEARCH (ค้นหาภาพของฉันด้วยใบหน้า) ======
// ประมวลผลใบหน้าในเบราว์เซอร์ (face-api.js) — ภาพเซลฟี่ของผู้ใช้ไม่ถูกส่งหรือบันทึกที่เซิร์ฟเวอร์
// เซิร์ฟเวอร์เก็บเฉพาะ "ดัชนีใบหน้า" (ตัวเลข 128 ค่า/ใบหน้า) ของภาพในอัลบั้ม ไว้ในไฟล์ _faces.json ในโฟลเดอร์อัลบั้ม
const FACE_FILE = '_faces.json';

function faceFile_(folderId) {
  const it = DriveApp.getFolderById(folderId).getFilesByName(FACE_FILE);
  return it.hasNext() ? it.next() : null;
}

function getFaceData(albumId, token) {
  const data = getAlbumFiles(albumId, token); // ตรวจสิทธิ์/การมองเห็นอัลบั้มแล้ว
  const f = faceFile_(data.album.folderId);
  let index = {};
  if (f) { try { index = JSON.parse(f.getBlob().getDataAsString()); } catch (e) {} }
  const imageIds = data.files.filter(x => x.type === 'image').map(x => x.id);
  Object.keys(index).forEach(k => { if (imageIds.indexOf(k) < 0) delete index[k]; });
  return { index, imageIds };
}

/** ดึงภาพย่อ (กว้าง ~1000px) เป็น Base64 เพื่อให้เบราว์เซอร์ตรวจจับใบหน้าได้ */
function getFaceThumbs(albumId, ids, token) {
  const data = getAlbumFiles(albumId, token);
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

/** ทีมงาน/แอดมิน บันทึกดัชนีใบหน้า (เพื่อให้ผู้ใช้ค้นหาได้เร็ว ไม่ต้องสแกนใหม่ทุกครั้ง) */
function saveFaceIndex(token, albumId, partial) {
  auth_(token);
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const a = rows_(SHEET_ALBUMS).find(x => x.id === albumId); if (!a) throw new Error('ไม่พบอัลบั้ม');
    let f = faceFile_(a.folderId), index = {};
    if (f) { try { index = JSON.parse(f.getBlob().getDataAsString()); } catch (e) {} }
    Object.assign(index, partial || {});
    const json = JSON.stringify(index);
    if (f) f.setContent(json); else DriveApp.getFolderById(a.folderId).createFile(FACE_FILE, json, 'application/json');
    return Object.keys(index).length;
  } finally { lock.releaseLock(); }
}
