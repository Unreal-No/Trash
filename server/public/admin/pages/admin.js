'use strict';
/* รายงาน, ผู้ใช้, ตั้งค่า, บันทึกการใช้งาน */
App.pages.reports = async root => {
  const msg = el('div'), bmsg = el('div');
  const dl = async () => {
    try {
      const r = await api('GET', '/api/staff/reports/outstanding.csv', null, true);
      if (!r.ok) { put(msg, note('err', 'ดาวน์โหลดไม่สำเร็จ')); return; }
      const a = el('a', {href: URL.createObjectURL(await r.blob()), download: 'outstanding.csv'});
      document.body.append(a); a.click(); a.remove(); put(msg, note('ok', 'ดาวน์โหลดแล้ว'));
    } catch (e) { if (e.message !== '401') put(msg, note('err', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้')); }
  };
  const nowBE = new Date(Date.now() + 7 * 3600e3);
  const mo = sel(MON.map((m, i) => [i + 1, m]), nowBE.getUTCMonth() + 1);
  const y0 = nowBE.getUTCFullYear() + 543;
  const yr = sel([y0 + 1, y0, y0 - 1].map(y => [y, y]), y0);
  const gen = async () => {
    const period = yr.value + '-' + String(mo.value).padStart(2, '0');
    if (!confirm('ออกใบแจ้งหนี้งวด ' + fper(period) + ' ให้ทุกบ้านที่ใช้งาน?')) return;
    const r = await App.call(bmsg, 'POST', '/api/staff/billing/generate', {period});
    if (r && r.ok) put(bmsg, note('ok', 'ออกใบแจ้งหนี้งวด ' + fper(period) + ' สร้างใหม่ ' + num(r.data.created) + ' ฉบับ · ข้าม ' + num(r.data.skipped)));
  };
  put(root, el('h2', null, 'รายงาน'),
    el('div', {class: 'card'}, el('h3', null, 'รายงานผู้ค้างชำระ (CSV)'), el('button', {class: 'btn', onclick: dl}, 'ดาวน์โหลด outstanding.csv'), msg),
    can('billing.manage') ? el('div', {class: 'card'}, el('h3', null, 'ออกใบแจ้งหนี้ประจำงวด'),
      el('div', {class: 'grid'}, field('เดือน', mo), field('ปี (พ.ศ.)', yr)), el('div', {style: 'margin-top:10px'}, el('button', {class: 'btn', onclick: gen}, 'ออกใบแจ้งหนี้')), bmsg) : null);
};

App.pages.users = async root => {
  const roles = Object.keys(ROLE).map(k => [k, ROLE[k]]);
  const msg = el('div'), formBox = el('div'), tbl = el('div');
  put(root, el('div', {class: 'row between wrap'}, el('h2', null, 'ผู้ใช้'), el('button', {class: 'btn', onclick: () => edit(null)}, '+ เพิ่มผู้ใช้')), msg, formBox, tbl);

  function edit(u) {
    const un = el('input', {type: 'text', value: u ? u.username : '', disabled: !!u, autocomplete: 'off'});
    const nm = el('input', {type: 'text', value: u ? u.name : ''});
    const rl = sel(roles, u ? u.role : 'CASHIER');
    const ac = el('input', {type: 'checkbox', checked: u ? u.active : true});
    const pw = el('input', {type: 'password', autocomplete: 'new-password', placeholder: u ? 'เว้นว่าง = ไม่เปลี่ยน' : 'อย่างน้อย 8 ตัวอักษร'});
    const fm = el('div');
    const save = async () => {
      if (pw.value && pw.value.length < 8) { put(fm, note('err', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร')); return; }
      if (!u && (!un.value.trim() || !nm.value.trim() || !pw.value)) { put(fm, note('err', 'กรุณากรอกข้อมูลให้ครบ')); return; }
      const b = {name: nm.value.trim(), role: rl.value};
      if (u) b.active = ac.checked;
      if (pw.value) b.password = pw.value;
      if (!u) b.username = un.value.trim();
      const r = await App.call(fm, u ? 'PUT' : 'POST', '/api/staff/users' + (u ? '/' + u.id : ''), b);
      if (r && r.ok) { put(formBox); put(msg, note('ok', 'บันทึกแล้ว')); load(); }
    };
    put(formBox, el('div', {class: 'card'}, el('h3', null, u ? 'แก้ไขผู้ใช้ ' + u.username : 'เพิ่มผู้ใช้'),
      el('div', {class: 'grid'}, field('ชื่อผู้ใช้', un), field('ชื่อ-สกุล', nm), field('สิทธิ์', rl), field('รหัสผ่าน', pw),
        u ? el('label', {class: 'opt', style: 'align-self:end'}, ac, 'เปิดใช้งาน') : null), fm,
      el('div', {class: 'row', style: 'margin-top:10px'}, el('button', {class: 'btn', onclick: save}, 'บันทึก'), el('button', {class: 'btn sec', onclick: () => put(formBox)}, 'ยกเลิก'))));
    formBox.scrollIntoView({behavior: 'smooth'});
  }
  async function load() {
    const r = await App.call(msg, 'GET', '/api/staff/users');
    if (!r || !r.ok) return;
    put(tbl, el('div', {class: 'card'}, App.table([
      {h: 'ชื่อผู้ใช้', f: u => u.username}, {h: 'ชื่อ', f: u => u.name}, {h: 'สิทธิ์', f: u => ROLE[u.role] || u.role},
      {h: 'สถานะ', f: u => [u.active ? badge('ใช้งาน', '#1B7F3B') : badge('ปิด', '#888'), u.locked ? badge('ล็อก', '#C62828') : null]},
      {h: 'เข้าสู่ระบบล่าสุด', f: u => fdt(u.lastLoginAt)}, {h: '', f: u => el('button', {class: 'btn sec sm', onclick: () => edit(u)}, 'แก้ไข')}], r.data.items || [])));
  }
  await load();
};

App.pages.settings = async root => {
  const r = await App.call(root, 'GET', '/api/staff/settings');
  if (!r || !r.ok) return;
  const s = r.data, ft = s.features || {}, mp = s.map || {}, mu = s.municipality || {}, ar = s.areas || {};
  const section = (title, body, build) => {
    const m = el('div');
    const btn = el('button', {class: 'btn', onclick: async () => {
      const x = await App.call(m, 'PUT', '/api/staff/settings', build());
      if (x && x.ok) { put(m, note('ok', 'บันทึกแล้ว')); App.refreshMe().catch(() => {}); }
    }}, 'บันทึก');
    return el('div', {class: 'card'}, el('h3', null, title), body, m, el('div', {style: 'margin-top:10px'}, btn));
  };
  const txt = (v, p) => el('input', Object.assign({type: 'text', value: v == null ? '' : v}, p));
  const mf = {name: txt(mu.name), address: txt(mu.address), phone: txt(mu.phone), officeHours: txt(mu.officeHours)};
  const chk = (v, l) => el('label', {class: 'opt'}, el('input', {type: 'checkbox', checked: !!v}), l);
  const fc = [chk(ft.mapEnabled, 'แสดงแผนที่'), chk(ft.mapShowStatus, 'แสดงสีสถานะการชำระบนแผนที่'), chk(ft.liffHouseSearch, 'ให้ประชาชนค้นหาบ้านใน LINE')];
  const fk = ['mapEnabled', 'mapShowStatus', 'liffHouseSearch'];
  const mm = {lat: txt(mp.lat, {type: 'number', step: 'any'}), lng: txt(mp.lng, {type: 'number', step: 'any'}), zoom: txt(mp.zoom, {type: 'number', min: 1, max: 19})};
  const rt = {RESIDENTIAL: txt(((s.rates || {}).RESIDENTIAL || 0) / 100, {type: 'number', min: 0, step: '0.01'}), COMMERCIAL: txt(((s.rates || {}).COMMERCIAL || 0) / 100, {type: 'number', min: 0, step: '0.01'})};
  const AREAS = {subdistricts: 'ตำบล/แขวง', communities: 'ชุมชน', roads: 'ถนน', sois: 'ซอย'};
  const ta = {}; for (const k in AREAS) ta[k] = el('textarea', null, (ar[k] || []).join('\n'));
  put(root, el('h2', null, 'ตั้งค่า'),
    section('ข้อมูลเทศบาล', el('div', {class: 'grid'}, field('ชื่อ', mf.name), field('ที่อยู่', mf.address), field('โทรศัพท์', mf.phone), field('เวลาทำการ', mf.officeHours)),
      () => ({municipality: Object.fromEntries(Object.keys(mf).map(k => [k, mf[k].value.trim()]))})),
    section('ฟีเจอร์', el('div', null, fc), () => ({features: Object.fromEntries(fk.map((k, i) => [k, fc[i].querySelector('input').checked]))})),
    section('จุดกึ่งกลางแผนที่', el('div', {class: 'grid'}, field('ละติจูด', mm.lat), field('ลองจิจูด', mm.lng), field('ซูม', mm.zoom)),
      () => ({map: {lat: +mm.lat.value, lng: +mm.lng.value, zoom: +mm.zoom.value}})),
    section('อัตราเริ่มต้น (บาท/เดือน)', el('div', {class: 'grid'}, field(CAT.RESIDENTIAL, rt.RESIDENTIAL), field(CAT.COMMERCIAL, rt.COMMERCIAL)),
      () => ({rates: {RESIDENTIAL: Math.round(+rt.RESIDENTIAL.value * 100), COMMERCIAL: Math.round(+rt.COMMERCIAL.value * 100)}})),
    section('รายการพื้นที่ (หนึ่งรายการต่อบรรทัด)', el('div', {class: 'grid'}, Object.keys(AREAS).map(k => field(AREAS[k], ta[k]))),
      () => ({areas: Object.fromEntries(Object.keys(AREAS).map(k => [k, ta[k].value.split('\n').map(x => x.trim()).filter(Boolean)]))})));
};

App.pages.audit = async root => {
  const r = await App.call(root, 'GET', '/api/staff/audit?limit=200');
  if (!r || !r.ok) return;
  put(root, el('h2', null, 'บันทึกการใช้งาน'), el('div', {class: 'card'}, App.table([
    {h: 'เวลา', f: a => fdt(a.at)}, {h: 'ผู้ใช้', f: a => a.actor}, {h: 'การกระทำ', f: a => a.action}, {h: 'เป้าหมาย', f: a => a.target}], r.data.items || [])));
};
