'use strict';
/* แกนหลักของระบบหลังบ้าน: helper, api, login, router, layout */
const App = {pages: {}, user: null, me: null, token: '', cleanup: null, seq: 0, _opts: null};

const CAT = {RESIDENTIAL: 'ที่อยู่อาศัย', COMMERCIAL: 'ร้านค้า/กิจการ'};
const PAY = {PAID: ['ชำระแล้ว', '#1B7F3B'], DUE: ['รอชำระ', '#D4A017'], OVERDUE: ['ค้างชำระ', '#C62828'], NONE: ['ยังไม่ออกใบแจ้งหนี้', '#7a7a7a']};
const ROLE = {ADMIN: 'ผู้ดูแลระบบ', SUPERVISOR: 'หัวหน้า/ผู้ตรวจสอบ', CASHIER: 'เจ้าหน้าที่การเงิน', SURVEYOR: 'เจ้าหน้าที่สำรวจ', VIEWER: 'ผู้บริหาร/ดูอย่างเดียว'};
const MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const FIELD = {houseNo: 'เลขที่บ้าน', moo: 'หมู่', soi: 'ซอย', road: 'ถนน', community: 'ชุมชน', subdistrict: 'ตำบล/แขวง', ownerName: 'ชื่อเจ้าของ', phone: 'โทรศัพท์', category: 'ประเภท', rateSatang: 'อัตรา (สตางค์)', lat: 'ละติจูด', lng: 'ลองจิจูด', note: 'หมายเหตุ', active: 'ใช้งาน', code: 'รหัส'};

/** replaceChildren ที่รับ array/null ได้ */
const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter(c => c != null && c !== false));
/** สร้าง DOM โดยไม่ใช้ innerHTML — ค่าทุกตัวเป็น text */
function el(tag, props, ...kids) {
  const e = document.createElement(tag); let val;
  for (const k in (props || {})) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') val = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat(Infinity).forEach(c => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
  if (val != null) e.value = val;
  return e;
}
const baht = s => ((s || 0) / 100).toLocaleString('th-TH', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' บาท';
const num = n => (n || 0).toLocaleString('th-TH');
const fper = p => { const m = /^(\d{4})-(\d{2})$/.exec(p || ''); return m && MON[+m[2] - 1] ? MON[+m[2] - 1] + ' ' + m[1] : String(p || '-'); };
const psum = ps => { const s = [...ps].sort(); return s.length > 3 ? fper(s[0]) + ' – ' + fper(s[s.length - 1]) + ' (' + s.length + ' งวด)' : s.map(fper).join(', '); };
const fdt = s => s ? new Date(s).toLocaleString('th-TH', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok'}) : '-';
const fd = s => s ? new Date(s).toLocaleDateString('th-TH', {dateStyle: 'medium', timeZone: 'Asia/Bangkok'}) : '-';
const errMsg = d => (d && d.error) || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
const can = p => !!(App.user && App.user.permissions.includes(p));
const note = (cls, text) => el('div', {class: cls}, text);
const badge = (text, color) => el('span', {class: 'badge', style: 'background:' + color}, text);
const payBadge = s => { const p = PAY[s] || [s || '-', '#888']; return badge(p[0], p[1]); };
const sel = (opts, cur, props) => el('select', Object.assign({value: cur == null ? '' : String(cur)}, props), opts.map(o => el('option', {value: o[0]}, o[1])));
const field = (label, input) => el('div', null, el('label', null, label), input);
const qs = o => { const p = new URLSearchParams(); for (const k in o) if (o[k] !== '' && o[k] != null) p.set(k, o[k]); return p.toString(); };

/** Thai fiscal year ปัจจุบัน (เริ่ม ต.ค.) ตามเวลา Asia/Bangkok */
App.currentFY = () => { const d = new Date(Date.now() + 7 * 3600e3); return d.getUTCFullYear() + 543 + (d.getUTCMonth() >= 9 ? 1 : 0); };

/** ตารางทั่วไป: cols=[{h,f(row),n:ตัวเลข,k:คีย์เรียง}] */
App.table = (cols, rows, o) => {
  o = o || {};
  const th = cols.map(c => el('th', {class: (c.n ? 'n ' : '') + (c.k ? 's' : ''), onclick: c.k && o.onSort ? () => o.onSort(c.k) : null},
    c.h + (c.k && o.sortKey === c.k ? (o.sortDir > 0 ? ' ▲' : ' ▼') : '')));
  const body = rows.length ? rows.map(r => el('tr', null, cols.map(c => el('td', {class: c.n ? 'n' : ''}, c.f(r)))))
    : [el('tr', null, el('td', {colspan: cols.length, class: 'muted'}, 'ไม่พบข้อมูล'))];
  return el('div', {class: 'tw'}, el('table', null, el('thead', null, el('tr', null, th)), el('tbody', null, body)));
};
App.diff = d => el('div', {class: 'diff'}, (d || []).map(x => el('div', null, (FIELD[x.field] || x.field) + ': ',
  el('del', null, x.before == null || x.before === '' ? '(ว่าง)' : String(x.before)), ' → ', el('ins', null, x.after == null || x.after === '' ? '(ว่าง)' : String(x.after)))));

/** ตัวเลือกที่อยู่ (cache) */
App.opts = () => App._opts || (App._opts = api('GET', '/api/staff/address-options').then(r => r.ok ? r.data : {}).catch(() => ({})));
App.datalists = o => ['subdistricts', 'communities', 'roads', 'sois', 'moos'].map(k =>
  el('datalist', {id: 'dl-' + k}, (o[k] || []).map(v => el('option', {value: v}))));

async function api(method, path, body, raw) {
  const h = {Authorization: 'Bearer ' + App.token};
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(path, {method, headers: h, body: body ? JSON.stringify(body) : undefined});
  if (r.status === 401) { App.logout('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'); throw new Error('401'); }
  if (raw) return r;
  let j = {}; try { j = await r.json(); } catch (e) {}
  return {ok: r.ok, status: r.status, data: j};
}
/** เรียก api แล้วจัดการข้อผิดพลาดการเชื่อมต่อให้ ใช้กับปุ่ม: คืน response หรือ null */
App.call = async (box, ...a) => {
  try { const r = await api(...a); if (!r.ok) put(box, note('err', errMsg(r.data))); return r; }
  catch (e) { if (e.message !== '401') put(box, note('err', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้')); return null; }
};

const tok = {
  get() { try { return sessionStorage.getItem('staffToken') || ''; } catch (e) { return ''; } },
  set(v) { try { v ? sessionStorage.setItem('staffToken', v) : sessionStorage.removeItem('staffToken'); } catch (e) {} },
};

App.logout = msg => {
  App.token = ''; App.user = null; tok.set('');
  if (App.cleanup) { try { App.cleanup(); } catch (e) {} App.cleanup = null; }
  renderLogin(msg);
};

function renderLogin(msg) {
  const u = el('input', {type: 'text', autocomplete: 'username', placeholder: 'ชื่อผู้ใช้'});
  const p = el('input', {type: 'password', autocomplete: 'current-password', placeholder: 'รหัสผ่าน'});
  const box = el('div', {class: 'err'}, msg || '');
  const go = async () => {
    if (!u.value.trim() || !p.value) return;
    let r;
    try { r = await fetch('/api/staff/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: u.value.trim(), password: p.value})}); }
    catch (e) { put(box, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); return; }
    let d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok) { put(box, errMsg(d)); return; }
    App.token = d.token; tok.set(d.token);
    boot();
  };
  p.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  put($('root'), el('div', {class: 'login'}, el('div', {class: 'card'}, el('h2', null, 'เข้าสู่ระบบเจ้าหน้าที่'),
    el('div', {class: 'muted'}, 'เทศบาลเมืองเมืองพล · ระบบค่าธรรมเนียมขยะ'), box, u, el('div', {style: 'height:8px'}), p,
    el('button', {class: 'btn full', onclick: go}, 'เข้าสู่ระบบ'))));
}
function $(id) { return document.getElementById(id); }

const MENU = [
  ['dashboard', 'ภาพรวม', 'dashboard.read'], ['houses', 'ทะเบียนบ้าน', 'house.read'], ['reviews', 'คิวตรวจสอบ', 'house.verify'],
  ['counter', 'รับชำระ', 'payment.cash'], ['map', 'แผนที่', 'map.read'], ['reports', 'รายงาน', 'report.read'],
  ['users', 'ผู้ใช้', 'user.manage'], ['settings', 'ตั้งค่า', 'settings.manage'], ['audit', 'บันทึกการใช้งาน', 'audit.read'],
];
const ALIAS = {house: 'houses'};
const allowed = n => { const m = MENU.find(x => x[0] === (ALIAS[n] || n)); return !!m && can(m[2]) && (n !== 'map' || !!(App.me.settings.features || {}).mapEnabled); };

App.refreshMe = async () => {
  const r = await api('GET', '/api/staff/me');
  if (!r.ok) throw new Error('me');
  App.me = r.data; App.user = r.data.user;
};

async function boot() {
  try { await App.refreshMe(); } catch (e) { if (e.message !== '401') renderLogin('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); return; }
  const nav = el('nav', {id: 'nav'}, MENU.filter(m => allowed(m[0])).map(m => el('a', {href: '#' + m[0], 'data-r': m[0]}, m[1])));
  put($('root'),
    el('header', null, el('div', {class: 'row'}, el('button', {id: 'burger', onclick: () => nav.classList.toggle('open')}, '☰ เมนู'), el('span', {class: 't'}, 'ระบบค่าขยะ · หลังบ้าน')),
      el('div', {class: 'row'}, el('div', {class: 'u'}, el('div', null, App.user.name), el('div', null, ROLE[App.user.role] || App.user.role)),
        el('button', {onclick: () => { api('POST', '/api/staff/logout').catch(() => {}); App.logout(); }}, 'ออก'))),
    el('div', {class: 'layout'}, nav, el('main', {id: 'main'})));
  App.route();
}

App.route = async () => {
  if (!App.user) return;
  if (App.cleanup) { try { App.cleanup(); } catch (e) {} App.cleanup = null; }
  const seq = ++App.seq, parts = location.hash.slice(1).split('/'), name = parts[0];
  if (!allowed(name)) { const f = MENU.find(m => allowed(m[0])); if (f) location.replace('#' + f[0]); else put($('main'), note('warn', 'บัญชีนี้ไม่มีสิทธิ์ใช้งานเมนูใด')); return; }
  const active = ALIAS[name] || name;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.r === active));
  $('nav').classList.remove('open');
  const root = $('main');
  put(root, note('muted', 'กำลังโหลด...'));
  try {
    const c = await App.pages[name](root, decodeURIComponent(parts.slice(1).join('/')));
    if (typeof c === 'function') { if (seq === App.seq) App.cleanup = c; else c(); }
  } catch (e) { if (e.message !== '401' && seq === App.seq) put(root, note('err', 'เกิดข้อผิดพลาด: ' + e.message)); }
};

App.start = () => {
  window.addEventListener('hashchange', App.route);
  App.token = tok.get();
  App.token ? boot() : renderLogin();
};

/** Leaflet helpers */
App.osm = map => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '© OpenStreetMap'}).addTo(map);
