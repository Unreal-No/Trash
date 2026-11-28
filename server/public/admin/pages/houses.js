'use strict';
/* ทะเบียนบ้าน, รายละเอียดบ้าน, คิวตรวจสอบ */
const vbadge = h => h.verified ? null : badge('รอตรวจสอบ', '#D4A017');

let houseQuery = {};
App.pages.houses = async root => {
  const o = await App.opts();
  const q = Object.assign({page: 1, pageSize: 50}, houseQuery);
  const inp = (k, l, dl) => field(l, el('input', {type: 'text', name: k, list: dl ? 'dl-' + dl : null, value: q[k] || ''}));
  const ps = sel([['', 'ทั้งหมด']].concat(Object.keys(PAY).map(k => [k, PAY[k][0]])), q.payStatus || '');
  const cat = sel([['', 'ทั้งหมด'], ['RESIDENTIAL', CAT.RESIDENTIAL], ['COMMERCIAL', CAT.COMMERCIAL]], q.category || '');
  const ver = sel([['', 'ทั้งหมด'], ['true', 'ตรวจสอบแล้ว'], ['false', 'รอตรวจสอบ']], q.verified || '');
  const form = el('form', {class: 'card', onsubmit: e => { e.preventDefault(); q.page = 1; search(); }},
    el('div', {class: 'grid'}, inp('houseNo', 'เลขที่บ้าน (ตรงตัว)'), inp('moo', 'หมู่', 'moos'), inp('soi', 'ซอย', 'sois'), inp('road', 'ถนน', 'roads'),
      inp('community', 'ชุมชน', 'communities'), inp('subdistrict', 'ตำบล/แขวง', 'subdistricts'),
      field('ประเภท', cat), field('สถานะชำระ', ps), field('การตรวจสอบ', ver), inp('q', 'ค้นหารหัส/ชื่อเจ้าของ')),
    el('div', {class: 'row', style: 'margin-top:10px'}, el('button', {class: 'btn', type: 'submit'}, 'ค้นหา'),
      el('button', {class: 'btn sec', type: 'button', onclick: () => { houseQuery = {}; App.pages.houses(root); }}, 'ล้างค่า')));
  const out = el('div');
  put(root, el('div', {class: 'row between wrap'}, el('h2', null, 'ทะเบียนบ้าน'),
    can('house.write') ? el('a', {href: '#house/new'}, el('button', {class: 'btn'}, '+ เพิ่มบ้าน')) : null), App.datalists(o), form, out);

  async function search() {
    for (const i of form.querySelectorAll('input[name]')) q[i.name] = i.value.trim();
    q.category = cat.value; q.payStatus = ps.value; q.verified = ver.value;
    houseQuery = Object.assign({}, q, {page: 1});
    put(out, note('muted', 'กำลังค้นหา...'));
    const r = await App.call(out, 'GET', '/api/staff/houses?' + qs(q));
    if (!r || !r.ok) return;
    const d = r.data, pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const go = p => () => { q.page = p; search(); };
    put(out, el('div', {class: 'card'}, el('div', {class: 'muted'}, 'พบ ' + num(d.total) + ' รายการ'), App.table([
      {h: 'ที่อยู่', f: h => el('a', {href: '#house/' + h.id}, h.address || h.houseNo)}, {h: 'เจ้าของ', f: h => h.ownerName || '-'},
      {h: 'ประเภท', f: h => CAT[h.category] || h.category}, {h: 'อัตรา', n: 1, f: h => baht(h.rateSatang)},
      {h: 'สถานะ', f: h => payBadge(h.payStatus)}, {h: 'ยอดค้าง', n: 1, f: h => baht(h.outstandingSatang)}, {h: '', f: vbadge}], d.items),
      el('div', {class: 'row between', style: 'margin-top:10px'},
        el('button', {class: 'btn sec sm', disabled: d.page <= 1, onclick: go(d.page - 1)}, '« ก่อนหน้า'),
        el('span', null, 'หน้า ' + d.page + ' / ' + pages),
        el('button', {class: 'btn sec sm', disabled: d.page >= pages, onclick: go(d.page + 1)}, 'ถัดไป »'))));
  }
  if (Object.keys(houseQuery).length) search();
};

App.pages.house = async (root, id) => {
  const isNew = id === 'new', o = await App.opts();
  let h = {active: true, category: 'RESIDENTIAL'}, extra = {};
  if (!isNew) {
    const r = await App.call(root, 'GET', '/api/staff/houses/' + encodeURIComponent(id));
    if (!r || !r.ok) return;
    h = r.data.house; extra = r.data;
  }
  const ro = !can('house.write');
  const txt = (k, l, dl, type) => [k, el('input', {type: type || 'text', list: dl ? 'dl-' + dl : null, value: h[k] == null ? '' : h[k], disabled: ro})];
  const f = Object.fromEntries([txt('houseNo'), txt('subdistrict', 0, 'subdistricts'), txt('moo', 0, 'moos'), txt('soi', 0, 'sois'), txt('road', 0, 'roads'),
    txt('community', 0, 'communities'), txt('ownerName'), txt('phone'), txt('lat', 0, 0, 'number'), txt('lng', 0, 0, 'number'), txt('code'), txt('note')]);
  f.category = sel([['RESIDENTIAL', CAT.RESIDENTIAL], ['COMMERCIAL', CAT.COMMERCIAL]], h.category, {disabled: ro});
  f.rate = el('input', {type: 'number', min: '0', step: '0.01', placeholder: 'ว่าง = อัตราเริ่มต้น', value: h.rateSatang != null ? (h.rateSatang / 100).toFixed(2) : '', disabled: ro});
  f.active = el('input', {type: 'checkbox', checked: h.active !== false, disabled: ro});
  f.lat.step = f.lng.step = 'any';
  const msg = el('div'), mapDiv = el('div', {class: 'minimap'});
  const L_ = (k, l) => field(l || FIELD[k], f[k]);

  async function save() {
    const b = {};
    ['houseNo', 'subdistrict', 'moo', 'soi', 'road', 'community', 'ownerName', 'phone', 'note'].forEach(k => b[k] = f[k].value.trim());
    b.category = f.category.value; b.active = f.active.checked;
    b.lat = f.lat.value === '' ? null : +f.lat.value; b.lng = f.lng.value === '' ? null : +f.lng.value;
    if (f.rate.value !== '') b.rateSatang = Math.round(+f.rate.value * 100);
    if (isNew && f.code.value.trim()) b.code = f.code.value.trim();
    if (!b.houseNo || !b.subdistrict) { put(msg, note('err', 'กรุณากรอกเลขที่บ้านและตำบล')); return; }
    const r = await App.call(msg, isNew ? 'POST' : 'PUT', '/api/staff/houses' + (isNew ? '' : '/' + h.id), b);
    if (!r || !r.ok) return;
    const auto = r.data.changeStatus === 'AUTO';
    if (isNew) { location.hash = '#house/' + r.data.house.id; return; }
    await App.pages.house(root, id);
    root.prepend(note(auto ? 'ok' : 'warn', auto ? 'บันทึกแล้ว (อนุมัติอัตโนมัติ)' : 'บันทึกแล้ว — รอหัวหน้าตรวจสอบ'));
  }

  const top = isNew ? el('h2', null, 'เพิ่มบ้าน') : el('div', {class: 'row between wrap'}, el('h2', null, h.address || h.houseNo),
    el('div', {class: 'row'}, payBadge(h.payStatus), vbadge(h),
      can('payment.cash') ? el('a', {href: '#counter/' + encodeURIComponent(h.code)}, el('button', {class: 'btn'}, 'รับชำระ')) : null));
  const info = isNew ? null : el('div', {class: 'muted'}, 'รหัส ' + h.code + ' · ยอดค้าง ' + baht(h.outstandingSatang) + ' · ผูก LINE ' + num(extra.lineLinks) + ' บัญชี · แก้ไขล่าสุด ' + fdt(h.updatedAt) + (h.updatedBy ? ' โดย ' + h.updatedBy : ''));
  const gps = el('button', {class: 'btn sec sm', type: 'button', disabled: ro, onclick: () => {
    if (!navigator.geolocation) { put(msg, note('err', 'อุปกรณ์ไม่รองรับ GPS')); return; }
    navigator.geolocation.getCurrentPosition(p => setPin(p.coords.latitude, p.coords.longitude, true), () => put(msg, note('err', 'อ่านตำแหน่งไม่ได้ กรุณาอนุญาตการเข้าถึงตำแหน่ง')), {enableHighAccuracy: true, timeout: 15000});
  }}, 'ใช้ตำแหน่งปัจจุบัน (GPS)');
  put(root, top, info, App.datalists(o),
    el('div', {class: 'card'}, el('div', {class: 'grid'}, L_('houseNo'), L_('subdistrict'), L_('moo'), L_('soi'), L_('road'), L_('community'), L_('ownerName'), L_('phone'),
      L_('category'), field('อัตรา (บาท/เดือน)', f.rate), isNew ? L_('code', 'รหัส (ว่าง = อัตโนมัติ)') : null, L_('note'),
      el('label', {class: 'opt', style: 'align-self:end'}, f.active, 'ใช้งาน')),
      el('div', {class: 'row between wrap', style: 'margin-top:10px'}, el('b', null, 'ตำแหน่งบนแผนที่'), gps),
      el('div', {class: 'grid'}, L_('lat'), L_('lng')), mapDiv, el('div', {class: 'muted'}, ro ? '' : 'คลิกแผนที่หรือลากหมุดเพื่อกำหนดตำแหน่ง'),
      msg, ro ? null : el('button', {class: 'btn', onclick: save}, isNew ? 'เพิ่มบ้าน' : 'บันทึกการแก้ไข')),
    isNew ? null : detailTables(extra));

  const mc = (App.me.settings || {}).map || {lat: 16.0, lng: 102.6, zoom: 13};
  const has = h.lat != null && h.lng != null;
  const map = L.map(mapDiv).setView(has ? [h.lat, h.lng] : [mc.lat, mc.lng], has ? 17 : mc.zoom);
  App.osm(map);
  let pin = null;
  function setPin(lat, lng, pan) {
    lat = +(+lat).toFixed(6); lng = +(+lng).toFixed(6);
    f.lat.value = lat; f.lng.value = lng;
    if (pin) pin.setLatLng([lat, lng]);
    else { pin = L.marker([lat, lng], {draggable: !ro}).addTo(map); pin.on('dragend', () => { const p = pin.getLatLng(); setPin(p.lat, p.lng); }); }
    if (pan) map.setView([lat, lng], 18);
  }
  if (has) setPin(h.lat, h.lng);
  if (!ro) map.on('click', e => setPin(e.latlng.lat, e.latlng.lng));
  const sync = () => { if (f.lat.value !== '' && f.lng.value !== '') setPin(f.lat.value, f.lng.value, true); };
  f.lat.addEventListener('change', sync); f.lng.addEventListener('change', sync);
  setTimeout(() => map.invalidateSize(), 100);
  return () => map.remove();
};

function detailTables(d) {
  const st = {PAID: 'ชำระแล้ว', UNPAID: 'ค้างชำระ', VOID: 'ยกเลิก'};
  return [
    el('div', {class: 'card'}, el('h3', null, 'ใบแจ้งหนี้'), App.table([
      {h: 'เลขที่', f: i => i.invoiceNo}, {h: 'งวด', f: i => fper(i.period)}, {h: 'จำนวน', n: 1, f: i => baht(i.amountSatang)},
      {h: 'สถานะ', f: i => st[i.status] || i.status}, {h: 'ครบกำหนด', f: i => fd(i.dueDate)}], d.invoices || [])),
    el('div', {class: 'card'}, el('h3', null, 'ใบเสร็จ'), App.table([
      {h: 'เลขที่', f: r => r.receiptNo}, {h: 'วันที่', f: r => fdt(r.paidAt)}, {h: 'ช่องทาง', f: r => r.method},
      {h: 'งวด', f: r => psum(r.periods || [])}, {h: 'จำนวน', n: 1, f: r => baht(r.amountSatang)}], d.receipts || [])),
    el('div', {class: 'card'}, el('h3', null, 'ประวัติการเปลี่ยนแปลง'), App.table([
      {h: 'เวลา', f: c => fdt(c.at)}, {h: 'ผู้ทำ', f: c => c.staffName || '-'}, {h: 'รายการ', f: c => c.action},
      {h: 'สถานะ', f: c => c.status}, {h: 'การเปลี่ยนแปลง', f: c => App.diff(c.diff)}], d.changes || [])),
  ];
}

App.pages.reviews = async root => {
  const box = el('div'), msg = el('div');
  put(root, el('h2', null, 'คิวตรวจสอบ'), msg, box);
  async function load() {
    const r = await App.call(msg, 'GET', '/api/staff/reviews');
    if (!r || !r.ok) return;
    const items = r.data.items || [];
    put(box, items.length ? items.map(c => {
      const n = el('input', {type: 'text', placeholder: 'หมายเหตุ (ไม่บังคับ)'});
      const decide = dec => async () => {
        const x = await App.call(msg, 'POST', '/api/staff/reviews/' + c.id, {decision: dec, note: n.value.trim()});
        if (x && x.ok) { put(msg, note('ok', dec === 'APPROVE' ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว (ย้อนข้อมูลกลับ)')); load(); }
      };
      return el('div', {class: 'card'}, el('div', {class: 'row between wrap'}, el('a', {href: '#house/' + c.houseId}, el('b', null, (c.code || '') + ' ' + (c.address || c.houseNo))),
        el('span', {class: 'muted'}, c.action + ' · ' + (c.staffName || '-') + ' · ' + fdt(c.at))), App.diff(c.diff), el('div', {style: 'margin-top:8px'}, n),
        el('div', {class: 'row', style: 'margin-top:8px'}, el('button', {class: 'btn', onclick: decide('APPROVE')}, 'อนุมัติ'), el('button', {class: 'btn red', onclick: decide('REJECT')}, 'ปฏิเสธ')));
    }) : note('card muted', 'ไม่มีรายการรอตรวจสอบ'));
  }
  await load();
};
