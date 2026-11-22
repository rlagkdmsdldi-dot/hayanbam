// 하얀밤조소공방 홈페이지 서버 (Railway)
// - 정적 파일(public/) 제공
// - 예약 현황(잔여석) 공개 API, 홈페이지 문의 저장
// - 관리자 페이지(/admin) 로그인 · 예약 캘린더 · 문의 관리
// 외부 패키지 없이 Node 기본 모듈만 사용합니다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SETUP_CODE = process.env.SETUP_CODE || '';
if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET 미설정: 재시작 시 로그인이 풀립니다.');

// ---------- 저장소 (JSON 파일, Railway 볼륨에 보관) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { admin: null, settings: { capacity: 6 }, slots: {}, inquiries: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (_) {}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- 수업 시간표 ----------
// 0=일 … 6=토 / 월요일 휴무
const EVENING = ['20:00-22:00', '22:00-24:00'];
const SCHEDULE = { 0: ['10:00-12:00'], 1: [], 2: EVENING, 3: EVENING, 4: EVENING, 5: EVENING, 6: EVENING };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dow(date) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function slotsFor(date) { return SCHEDULE[dow(date)] || []; }
function slotInfo(date, slot, withMemo) {
  const o = db.slots[date + '|' + slot] || {};
  const r = {
    slot,
    capacity: Number.isInteger(o.capacity) ? o.capacity : db.settings.capacity,
    booked: o.booked || 0,
    closed: !!o.closed,
  };
  if (withMemo) r.memo = o.memo || '';
  return r;
}
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function rangeDays(from, to, max) {
  const out = []; let d = from;
  while (d <= to && out.length < max) { out.push(d); d = addDays(d, 1); }
  return out;
}

// ---------- 유틸 ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
};
function send(res, code, obj, headers = {}) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function ip(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''; }
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function str(v, max = 500) { return String(v == null ? '' : v).slice(0, max).trim(); }
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// 간단한 요청 제한 (IP별)
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (b.length >= max) { buckets.set(key, b); return true; }
  b.push(now); buckets.set(key, b); return false;
}

// ---------- 관리자 인증 ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  return safeEqual(crypto.scryptSync(pw, salt, 64).toString('hex'), h);
}
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeToken() { const v = `a.${Date.now() + 7 * 864e5}.${db.admin.ver}`; return v + '.' + sign(v); }
function authed(req) {
  const t = cookies(req).hb_admin;
  if (!t || !db.admin) return false;
  const i = t.lastIndexOf('.');
  const v = t.slice(0, i), s = t.slice(i + 1);
  if (!safeEqual(s, sign(v))) return false;
  const [, exp, ver] = v.split('.');
  return Date.now() < Number(exp) && Number(ver) === db.admin.ver;
}
function sessionCookie(token, maxAge) {
  return `hb_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function validPw(pw) { return typeof pw === 'string' && pw.length >= 8 && pw.length <= 100; }
function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_.-]{4,30}$/.test(id); }

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const isAdmin = p.startsWith('/api/admin/');

  // 관리자 POST는 CSRF 방지용 헤더 필요
  if (isAdmin && req.method === 'POST' && req.headers['x-hb'] !== '1') return send(res, 403, { error: 'forbidden' });

  // 공개: 잔여석
  if (p === '/api/availability' && req.method === 'GET') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return send(res, 400, { error: 'bad date' });
    const days = {};
    for (const d of rangeDays(from, to, 62)) days[d] = slotsFor(d).map(s => slotInfo(d, s, false));
    return send(res, 200, { days });
  }

  // 공개: 홈페이지 문의 저장
  if (p === '/api/inquiry' && req.method === 'POST') {
    if (limited('inq:' + ip(req), 5, 10 * 60e3)) return send(res, 429, { error: '잠시 후 다시 시도해 주세요.' });
    let b; try { b = await readBody(req, 10000); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    if (b.website) return send(res, 200, { ok: true }); // 스팸봇용 숨김 칸
    const type = str(b.type, 20);
    if (!['수업 문의', '출강 문의', '조형물 제작'].includes(type)) return send(res, 400, { error: 'bad type' });
    if (!str(b.name, 50) || !str(b.phone, 50)) return send(res, 400, { error: '이름과 연락처를 입력해 주세요.' });
    const item = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'new', type,
      name: str(b.name, 50), phone: str(b.phone, 50), org: str(b.org, 100),
      cls: str(b.cls, 50), people: str(b.people, 50), place: str(b.place, 100),
      kind: str(b.kind, 50), size: str(b.size, 100), budget: str(b.budget, 100),
      date: str(b.date, 20), time: str(b.time, 20), msg: str(b.msg, 2000),
    };
    db.inquiries.unshift(item);
    db.inquiries = db.inquiries.slice(0, 2000);
    save();
    return send(res, 200, { ok: true });
  }

  // 관리자: 상태
  if (p === '/api/admin/state' && req.method === 'GET') {
    return send(res, 200, { setup: !db.admin, setupEnabled: !!SETUP_CODE, authed: authed(req), id: authed(req) ? db.admin.id : null });
  }

  // 관리자: 첫 계정 만들기 (설정 코드 필요)
  if (p === '/api/admin/setup' && req.method === 'POST') {
    if (db.admin) return send(res, 409, { error: '이미 관리자 계정이 있습니다.' });
    if (limited('setup:' + ip(req), 8, 15 * 60e3)) return send(res, 429, { error: '잠시 후 다시 시도해 주세요.' });
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    if (!SETUP_CODE || !safeEqual(str(b.code, 100), SETUP_CODE)) return send(res, 401, { error: '설정 코드가 올바르지 않습니다.' });
    if (!validId(b.id)) return send(res, 400, { error: '아이디는 영문·숫자 4~30자로 입력해 주세요.' });
    if (!validPw(b.pw)) return send(res, 400, { error: '비밀번호는 8자 이상으로 입력해 주세요.' });
    db.admin = { id: b.id, pw: hashPw(b.pw), ver: 1 };
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(makeToken(), 7 * 86400) });
  }

  // 관리자: 로그인
  if (p === '/api/admin/login' && req.method === 'POST') {
    if (limited('login:' + ip(req), 10, 15 * 60e3)) return send(res, 429, { error: '로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.' });
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    // 아이디·비밀번호를 둘 다 검사해 응답 시간 차이를 줄임
    const idOk = !!db.admin && safeEqual(str(b.id, 30), db.admin.id);
    const pwOk = !!db.admin && checkPw(String(b.pw || ''), db.admin.pw);
    if (!idOk || !pwOk) {
      return send(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(makeToken(), 7 * 86400) });
  }

  if (p === '/api/admin/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // 이하 로그인 필요
  if (isAdmin && !authed(req)) return send(res, 401, { error: 'login required' });

  if (p === '/api/admin/month' && req.method === 'GET') {
    const ym = url.searchParams.get('ym') || '';
    if (!/^\d{4}-\d{2}$/.test(ym)) return send(res, 400, { error: 'bad month' });
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const days = {};
    for (let d = 1; d <= last; d++) {
      const ds = `${ym}-${String(d).padStart(2, '0')}`;
      days[ds] = slotsFor(ds).map(s => slotInfo(ds, s, true));
    }
    return send(res, 200, { days, capacity: db.settings.capacity });
  }

  if (p === '/api/admin/slot' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    if (!DATE_RE.test(b.date || '') || !slotsFor(b.date).includes(b.slot)) return send(res, 400, { error: '없는 수업 타임입니다.' });
    const key = b.date + '|' + b.slot;
    const booked = Math.max(0, Math.min(99, parseInt(b.booked, 10) || 0));
    const cap = b.capacity === '' || b.capacity == null ? undefined : Math.max(0, Math.min(99, parseInt(b.capacity, 10) || 0));
    const next = { booked, closed: !!b.closed, memo: str(b.memo, 300) };
    if (cap !== undefined && cap !== db.settings.capacity) next.capacity = cap;
    if (!next.booked && !next.closed && !next.memo && next.capacity === undefined) delete db.slots[key];
    else db.slots[key] = next;
    save();
    return send(res, 200, { ok: true, slot: slotInfo(b.date, b.slot, true) });
  }

  if (p === '/api/admin/inquiries' && req.method === 'GET') {
    return send(res, 200, { items: db.inquiries });
  }

  if (p === '/api/admin/inquiries/status' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const it = db.inquiries.find(x => x.id === b.id);
    if (!it || !['new', 'checked', 'confirmed', 'done'].includes(b.status)) return send(res, 400, { error: 'bad request' });
    it.status = b.status; save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/inquiries/delete' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    db.inquiries = db.inquiries.filter(x => x.id !== b.id); save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/settings' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const cap = parseInt(b.capacity, 10);
    if (!(cap >= 1 && cap <= 99)) return send(res, 400, { error: '정원은 1~99명으로 입력해 주세요.' });
    db.settings.capacity = cap; save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/password' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    if (!checkPw(String(b.current || ''), db.admin.pw)) return send(res, 401, { error: '현재 비밀번호가 올바르지 않습니다.' });
    if (!validPw(b.next)) return send(res, 400, { error: '새 비밀번호는 8자 이상으로 입력해 주세요.' });
    db.admin.pw = hashPw(b.next); db.admin.ver += 1; save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(makeToken(), 7 * 86400) });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- 정적 파일 ----------
function serveFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 500 : 200, { 'Content-Type': TYPES['.html'] });
        res.end(html);
      });
    }
    const ext = path.extname(file).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=604800';
    res.writeHead(200, Object.assign({ 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache }, extraHeaders));
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    try { return await api(req, res, url); } catch (e) { console.error(e); return send(res, 500, { error: 'server error' }); }
  }
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    return serveFile(res, path.join(ROOT, 'admin.html'), { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  serveFile(res, file);
}).listen(PORT, () => console.log('hayanbam site on ' + PORT));
