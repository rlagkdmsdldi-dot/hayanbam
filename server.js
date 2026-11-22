// 하얀밤 조소공방 홈페이지 서버 (Railway)
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
// 새 문의 메일 알림 (Resend). RESEND_API_KEY가 있을 때만 발송
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '818art@naver.com';
const MAIL_FROM = process.env.MAIL_FROM || '하얀밤 홈페이지 <onboarding@resend.dev>';
const SITE_URL = process.env.SITE_URL || 'https://hayanbam-web-production.up.railway.app';
async function notify(it) {
  const label = it.type === '조형물 제작' ? '제작 의뢰' : it.type;
  const rows = [['이름', it.name], ['연락처', it.phone], ['소속', it.org], ['수업', it.cls], ['인원', it.people], ['장소', it.place],
    ['종류', it.kind], ['규모', it.size], ['예산', it.budget], ['희망 일시', [it.date, it.time].filter(Boolean).join(' ')], ['내용', it.msg]]
    .filter(r => r[1]);
  const text = `[하얀밤 조소공방 홈페이지] 새 ${label}\n\n` + rows.map(r => `${r[0]}: ${r[1]}`).join('\n') + '\n\n관리자 페이지에서 확인하기: /admin';
  if (!RESEND_API_KEY) {
    // 기본: FormSubmit으로 공방 메일(818art@naver.com)에 전달 (첫 문의 때 인증 메일 1회 클릭 필요)
    try {
      const body = { _subject: `[홈페이지 ${label}] ${it.name}님 문의`, _template: 'table', _captcha: 'false' };
      rows.forEach(r => { body[r[0]] = r[1]; });
      body['관리자 페이지'] = SITE_URL + '/admin';
      const r = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(process.env.FORMSUBMIT_KEY || NOTIFY_EMAIL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: SITE_URL, Referer: SITE_URL + '/' },
        body: JSON.stringify(body),
      });
      const t = await r.text();
      if (!r.ok) console.error('[mail] FormSubmit 실패', r.status, t.slice(0, 200)); else console.log('[mail] FormSubmit', t.slice(0, 200));
    } catch (e) { console.error('[mail] FormSubmit 오류', e.message); }
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [NOTIFY_EMAIL], subject: `[홈페이지 ${label}] ${it.name}님 문의`, text }),
    });
    if (!r.ok) console.error('[mail] 발송 실패', r.status, await r.text());
  } catch (e) { console.error('[mail] 발송 오류', e.message); }
}
if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET 미설정: 재시작 시 로그인이 풀립니다.');

// ---------- 저장소 (JSON 파일, Railway 볼륨에 보관) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { admin: null, settings: { capacity: 6 }, slots: {}, inquiries: [], photos: { fixed: {}, gallery: { works: [], paint: [], visit: [] } } };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (_) {}
db.bookings = db.bookings || [];
db.enrollments = db.enrollments || [];
db.photos = db.photos || { fixed: {}, gallery: {} };
db.photos.fixed = db.photos.fixed || {};
db.photos.gallery = Object.assign({ works: [], paint: [], visit: [] }, db.photos.gallery || {});
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const FIXED_KEYS = ['hero', 'studio', 'teacher', 'c_sculpture', 'c_oil', 'c_oneday'];
const GALLERY_KEYS = ['works', 'paint', 'visit'];
function removeUpload(name) { if (name && /^[a-f0-9-]+\.jpg$/.test(name)) fs.unlink(path.join(UPLOAD_DIR, name), () => {}); }
function photosPublic() {
  const url = n => '/uploads/' + n;
  const fixed = {}; for (const k of FIXED_KEYS) if (db.photos.fixed[k]) fixed[k] = url(db.photos.fixed[k]);
  const gallery = {}; for (const k of GALLERY_KEYS) gallery[k] = (db.photos.gallery[k] || []).map(url);
  return { fixed, gallery };
}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- 수업 시간표 ----------
// 0=일 … 6=토 / 월요일 휴무
const EVENING = ['18:00-20:00', '20:00-22:00', '22:00-24:00']; // 18–20시는 유화반
const SCHEDULE = { 0: ['10:00-12:00'], 1: [], 2: EVENING, 3: EVENING, 4: EVENING, 5: EVENING, 6: EVENING };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dow(date) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function slotsFor(date) { return SCHEDULE[dow(date)] || []; }
function slotBookings(date, slot) { return db.bookings.filter(b => b.date === date && b.slot === slot); }
function slotInfo(date, slot, withMemo) {
  const o = db.slots[date + '|' + slot] || {};
  const list = slotBookings(date, slot);
  const extra = o.booked || 0; // 이름 없이 추가한 인원
  const r = {
    slot,
    capacity: Number.isInteger(o.capacity) ? o.capacity : db.settings.capacity,
    booked: extra + list.length,
    closed: !!o.closed,
  };
  if (withMemo) {
    r.memo = o.memo || '';
    r.extra = extra;
    r.people = list.map(b => ({ id: b.id, name: b.name, course: b.course, enr: b.enr || null }));
  }
  return r;
}
function todayKST() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
const COURSES = ['원데이 클래스', '조소반', '유화반'];
// 반복 일정 만들기: 시작일부터 요일·시간이 맞는 날을 회차 수만큼. 휴강 타임은 건너뜀
function genSessions(pattern, startDate, sessions, skip = new Set()) {
  const out = []; let d = startDate; let guard = 0;
  while (out.length < sessions && guard++ < 400) {
    const w = dow(d), valid = slotsFor(d);
    for (const p of pattern) {
      if (out.length >= sessions) break;
      if (p.dow !== w || !valid.includes(p.slot) || skip.has(d + '|' + p.slot)) continue;
      const info = slotInfo(d, p.slot, false);
      if (info.closed) continue;
      out.push({ date: d, slot: p.slot, full: info.booked >= info.capacity });
    }
    d = addDays(d, 1);
  }
  return out;
}
function cleanPattern(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.map(p => ({ dow: parseInt(p.dow, 10), slot: String(p.slot || '') }))
    .filter(p => p.dow >= 0 && p.dow <= 6 && (SCHEDULE[p.dow] || []).includes(p.slot))
    .filter(p => { const k = p.dow + '|' + p.slot; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => ((a.dow + 6) % 7) - ((b.dow + 6) % 7) || a.slot.localeCompare(b.slot));
}
const PAY_METHODS = ['카드', '현금', '계좌이체'];
function cleanPay(b) {
  const amount = Math.max(0, Math.min(99999999, parseInt(String(b.payAmount || '').replace(/[^0-9]/g, ''), 10) || 0));
  return { amount, method: PAY_METHODS.includes(b.payMethod) ? b.payMethod : '', paid: !!b.paid };
}
// 정규 수강 한 회를 쉬고 맨 뒤로 한 회 미루기
function postpone(e, bookingId) {
  const bk = db.bookings.find(x => x.id === bookingId && x.enr === e.id);
  if (!bk) return null;
  db.bookings = db.bookings.filter(x => x.id !== bookingId);
  const mine = db.bookings.filter(x => x.enr === e.id).map(x => x.date).sort();
  const last = mine.length ? mine[mine.length - 1] : bk.date;
  const from = addDays(last > bk.date ? last : bk.date, 1);
  const taken = new Set(db.bookings.filter(x => x.enr === e.id).map(x => x.date + '|' + x.slot));
  const add = genSessions(e.pattern, from, 1, taken)[0];
  if (add) db.bookings.push({ id: crypto.randomUUID(), date: add.date, slot: add.slot, name: e.name, course: e.course, enr: e.id });
  return { removed: bk, added: add || null };
}
function enrollmentView(e) {
  const list = db.bookings.filter(b => b.enr === e.id).sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
  return Object.assign({}, e, { dates: list.map(b => ({ id: b.id, date: b.date, slot: b.slot })) });
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

  // 공개: 사진 목록
  if (p === '/api/photos' && req.method === 'GET') return send(res, 200, photosPublic());

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
    notify(item);
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
    const booked = Math.max(0, Math.min(99, parseInt(b.extra != null ? b.extra : b.booked, 10) || 0));
    const cap = b.capacity === '' || b.capacity == null ? undefined : Math.max(0, Math.min(99, parseInt(b.capacity, 10) || 0));
    const next = { booked, closed: !!b.closed, memo: str(b.memo, 300) };
    if (cap !== undefined && cap !== db.settings.capacity) next.capacity = cap;
    let moved = 0;
    if (next.closed && b.postpone) {
      for (const bk of slotBookings(b.date, b.slot).filter(x => x.enr)) {
        const e = db.enrollments.find(x => x.id === bk.enr);
        if (e && postpone(e, bk.id)) moved++;
      }
    }
    if (!next.booked && !next.closed && !next.memo && next.capacity === undefined) delete db.slots[key];
    else db.slots[key] = next;
    save();
    return send(res, 200, { ok: true, moved, slot: slotInfo(b.date, b.slot, true) });
  }

  // ----- 수강생 · 예약 -----
  if (p === '/api/admin/booking' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    if (!DATE_RE.test(b.date || '') || !slotsFor(b.date).includes(b.slot)) return send(res, 400, { error: '없는 수업 타임입니다.' });
    const name = str(b.name, 30); if (!name) return send(res, 400, { error: '이름을 입력해 주세요.' });
    const course = COURSES.includes(b.course) ? b.course : '원데이 클래스';
    db.bookings.push({ id: crypto.randomUUID(), date: b.date, slot: b.slot, name, course, enr: null });
    save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/booking/delete' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    db.bookings = db.bookings.filter(x => x.id !== b.id); save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/enrollments' && req.method === 'GET') {
    return send(res, 200, { items: db.enrollments.map(enrollmentView), today: todayKST() });
  }

  if ((p === '/api/admin/enrollment' || p === '/api/admin/enrollment/preview') && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const name = str(b.name, 30); if (!name) return send(res, 400, { error: '수강생 이름을 입력해 주세요.' });
    const course = COURSES.includes(b.course) ? b.course : null; if (!course) return send(res, 400, { error: '수업 종류를 선택해 주세요.' });
    if (!DATE_RE.test(b.startDate || '')) return send(res, 400, { error: '시작일을 선택해 주세요.' });
    let pattern, sessions;
    if (course === '원데이 클래스') {
      if (!slotsFor(b.startDate).includes(b.slot)) return send(res, 400, { error: '그날 수업 시간을 선택해 주세요.' });
      pattern = [{ dow: dow(b.startDate), slot: b.slot }]; sessions = 1;
    } else {
      pattern = cleanPattern(b.pattern);
      if (!pattern.length) return send(res, 400, { error: '반복할 요일과 시간을 선택해 주세요.' });
      sessions = Math.max(1, Math.min(60, parseInt(b.sessions, 10) || pattern.length * 4));
    }
    const dates = genSessions(pattern, b.startDate, sessions);
    if (p.endsWith('/preview')) return send(res, 200, { dates, sessions });
    if (!dates.length) return send(res, 400, { error: '들어갈 수 있는 수업 날짜가 없습니다.' });
    const e = { id: crypto.randomUUID(), name, phone: str(b.phone, 30), course, pattern, startDate: b.startDate, sessions, memo: str(b.memo, 300), pay: cleanPay(b), createdAt: new Date().toISOString() };
    db.enrollments.unshift(e);
    for (const d of dates) db.bookings.push({ id: crypto.randomUUID(), date: d.date, slot: d.slot, name, course, enr: e.id });
    save();
    return send(res, 200, { ok: true, enrollment: enrollmentView(e) });
  }

  // 수강 정보 수정: 이름·연락처·메모·수업 종류 변경, 일정 변경 시 오늘 이후 일정만 다시 생성
  if (p === '/api/admin/enrollment/update' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const e = db.enrollments.find(x => x.id === b.id);
    if (!e) return send(res, 404, { error: '수강 정보를 찾을 수 없습니다.' });
    const name = str(b.name, 30); if (!name) return send(res, 400, { error: '수강생 이름을 입력해 주세요.' });
    const course = COURSES.includes(b.course) ? b.course : e.course;
    const t = todayKST();
    const past = db.bookings.filter(x => x.enr === e.id && x.date < t);
    let pattern = e.pattern, sessions = e.sessions, newDates = null;
    if (b.reschedule) {
      const start = DATE_RE.test(b.startDate || '') && b.startDate >= t ? b.startDate : t;
      if (course === '원데이 클래스') {
        if (!slotsFor(start).includes(b.slot)) return send(res, 400, { error: '그날 수업 시간을 선택해 주세요.' });
        pattern = [{ dow: dow(start), slot: b.slot }]; sessions = past.length + 1;
      } else {
        pattern = cleanPattern(b.pattern);
        if (!pattern.length) return send(res, 400, { error: '반복할 요일과 시간을 선택해 주세요.' });
        sessions = Math.max(past.length + 1, Math.min(60, parseInt(b.sessions, 10) || e.sessions));
      }
      const remain = sessions - past.length;
      // 이 수강생의 오늘 이후 일정은 계산에서 빼고 다시 만듦
      db.bookings = db.bookings.filter(x => !(x.enr === e.id && x.date >= t));
      newDates = genSessions(pattern, start, remain);
      for (const d of newDates) db.bookings.push({ id: crypto.randomUUID(), date: d.date, slot: d.slot, name, course, enr: e.id });
      sessions = past.length + newDates.length;
    }
    Object.assign(e, { name, phone: str(b.phone, 30), memo: str(b.memo, 300), course, pattern, sessions, pay: cleanPay(b) });
    db.bookings.forEach(x => { if (x.enr === e.id) { x.name = name; x.course = course; } });
    save();
    return send(res, 200, { ok: true, enrollment: enrollmentView(e) });
  }

  if (p === '/api/admin/enrollment/skip' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const e = db.enrollments.find(x => x.id === b.id);
    if (!e) return send(res, 404, { error: '수강 정보를 찾을 수 없습니다.' });
    const r = postpone(e, b.bookingId);
    if (!r) return send(res, 400, { error: '해당 수업을 찾을 수 없습니다.' });
    save();
    return send(res, 200, { ok: true, added: r.added });
  }

  if (p === '/api/admin/enrollment/pay' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const e = db.enrollments.find(x => x.id === b.id);
    if (!e) return send(res, 404, { error: '수강 정보를 찾을 수 없습니다.' });
    e.pay = Object.assign({ amount: 0, method: '', paid: false }, e.pay || {}, { paid: !!b.paid }); save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/enrollment/extend' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const e = db.enrollments.find(x => x.id === b.id);
    if (!e || e.course === '원데이 클래스') return send(res, 400, { error: '연장할 수 없는 수강입니다.' });
    const mine = db.bookings.filter(x => x.enr === e.id).map(x => x.date).sort();
    const last = mine.length ? mine[mine.length - 1] : todayKST();
    const start = addDays(last > todayKST() ? last : todayKST(), last > todayKST() ? 1 : 0);
    const n = Math.max(1, Math.min(60, parseInt(b.sessions, 10) || e.pattern.length * 4));
    const dates = genSessions(e.pattern, start, n);
    for (const d of dates) db.bookings.push({ id: crypto.randomUUID(), date: d.date, slot: d.slot, name: e.name, course: e.course, enr: e.id });
    e.sessions += dates.length; save();
    return send(res, 200, { ok: true, added: dates.length });
  }

  if (p === '/api/admin/enrollment/delete' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const t = todayKST();
    if (b.scope === 'future') {
      db.bookings = db.bookings.filter(x => !(x.enr === b.id && x.date >= t));
    } else {
      db.bookings = db.bookings.filter(x => x.enr !== b.id);
      db.enrollments = db.enrollments.filter(x => x.id !== b.id);
    }
    save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/photos' && req.method === 'GET') return send(res, 200, photosPublic());

  if (p === '/api/admin/photo' && req.method === 'POST') {
    let b; try { b = await readBody(req, 8 * 1024 * 1024); } catch (_) { return send(res, 413, { error: '사진 용량이 너무 큽니다.' }); }
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
    if (!m) return send(res, 400, { error: '사진 형식이 올바르지 않습니다.' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: '사진 형식이 올바르지 않습니다.' });
    const name = crypto.randomUUID() + '.jpg';
    if (FIXED_KEYS.includes(b.key)) {
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      removeUpload(db.photos.fixed[b.key]);
      db.photos.fixed[b.key] = name;
    } else if (GALLERY_KEYS.includes(b.key)) {
      if ((db.photos.gallery[b.key] || []).length >= 60) return send(res, 400, { error: '한 묶음에 사진은 60장까지 올릴 수 있습니다.' });
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      db.photos.gallery[b.key].push(name);
    } else return send(res, 400, { error: '사진 자리가 올바르지 않습니다.' });
    save();
    return send(res, 200, { ok: true, photos: photosPublic() });
  }

  if (p === '/api/admin/photo/delete' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    const name = String(b.url || '').replace('/uploads/', '');
    if (FIXED_KEYS.includes(b.key) && db.photos.fixed[b.key] === name) { delete db.photos.fixed[b.key]; removeUpload(name); }
    else if (GALLERY_KEYS.includes(b.key)) {
      const list = db.photos.gallery[b.key]; const i = list.indexOf(name);
      if (i >= 0) { list.splice(i, 1); removeUpload(name); }
    }
    save();
    return send(res, 200, { ok: true, photos: photosPublic() });
  }

  if (p === '/api/admin/photo/move' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad body' }); }
    if (!GALLERY_KEYS.includes(b.key)) return send(res, 400, { error: 'bad key' });
    const list = db.photos.gallery[b.key], name = String(b.url || '').replace('/uploads/', ''), i = list.indexOf(name), j = i + (b.dir < 0 ? -1 : 1);
    if (i >= 0 && j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; save(); }
    return send(res, 200, { ok: true, photos: photosPublic() });
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
  if (url.pathname.startsWith('/uploads/')) {
    const n = url.pathname.slice(9);
    if (!/^[a-f0-9-]+\.jpg$/.test(n)) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(UPLOAD_DIR, n), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(data);
    });
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  serveFile(res, file);
}).listen(PORT, () => console.log('hayanbam site on ' + PORT));
