'use strict';
/* รับชำระเงินสด (ย้ายจาก staff/index.html เดิม) */
App.pages.counter = async (root, presetCode) => {
  const code = el('input', {type: 'text', placeholder: 'รหัสผู้ชำระ', autocomplete: 'off', value: presetCode || ''});
  const hno = el('input', {type: 'text', placeholder: 'เลขที่บ้าน (ตรงตัว)', autocomplete: 'off'});
  const result = el('div'), picks = el('div');
  const enter = fn => e => { if (e.key === 'Enter') fn(); };
  code.addEventListener('keydown', enter(byCode)); hno.addEventListener('keydown', enter(byHouse));
  put(root, el('h2', null, 'รับชำระเงินสด'), el('div', {class: 'card'},
    el('div', {class: 'row'}, code, el('button', {class: 'btn', onclick: byCode}, 'ค้นหารหัส')),
    el('div', {class: 'row', style: 'margin-top:8px'}, hno, el('button', {class: 'btn sec', onclick: byHouse}, 'ค้นหาเลขที่บ้าน')), picks), result);
  $('print').replaceChildren();

  async function byCode() { put(picks); await loadPayer(code.value.trim()); }
  async function loadPayer(c) {
    if (!c) return;
    put(result, note('muted', 'กำลังค้นหา...'));
    const r = await App.call(result, 'GET', '/api/staff/payers/' + encodeURIComponent(c));
    if (r && r.ok) { code.value = c; showPayer(result, r.data); }
  }
  async function byHouse() {
    const v = hno.value.trim(); if (!v) return;
    put(result); put(picks, note('muted', 'กำลังค้นหา...'));
    const r = await App.call(picks, 'GET', '/api/staff/houses?' + qs({houseNo: v, pageSize: 20}));
    if (!r || !r.ok) return;
    const items = r.data.items || [];
    put(picks, items.length ? [note('muted', 'เลือกบ้านที่ต้องการ'), items.map(h => el('div', {class: 'sep row between'},
      el('span', null, h.address + (h.ownerName ? ' · ' + h.ownerName : '') + ' (' + h.code + ')'),
      el('button', {class: 'btn sm', onclick: () => { put(picks); loadPayer(h.code); }}, 'เลือก')))] : note('err', 'ไม่พบบ้านเลขที่นี้'));
  }
  if (presetCode) await loadPayer(presetCode);
  return () => $('print').replaceChildren();
};

function showPayer(root, d) {
  const p = d.payer, fy = d.currentFiscalYear, un = d.invoices.filter(i => i.status === 'UNPAID');
  const inv = new Set(un.map(i => i.id)), yr = new Map();
  let q = {ok: false, amt: 0, items: [], err: '', busy: false}, timer = 0, seq = 0;
  const list = el('div'), recv = el('input', {type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00'});
  const qBox = el('div'), change = el('div', {class: 'muted'}), msg = el('div');
  const btn = el('button', {class: 'btn full', onclick: pay}, 'รับชำระเงินสด');
  const received = () => Math.round(parseFloat(recv.value || '0') * 100) || 0;
  const body = () => ({invoiceIds: [...inv], years: [...yr.values()]});

  function paint() {
    put(qBox, q.busy ? note('muted', 'กำลังคำนวณ...') : null, q.err ? note('err', q.err) : null,
      q.ok ? [q.items.map(i => el('div', {class: 'row between muted'}, el('span', null, fper(i.period)), el('span', null, baht(i.amountSatang)))),
        el('div', {class: 'row between sep'}, el('b', null, 'รวม ' + q.items.length + ' งวด'), el('span', {class: 'amt'}, baht(q.amt)))] : null);
    const c = received() - q.amt;
    change.textContent = 'เงินทอน: ' + (!q.ok || !received() ? '-' : c >= 0 ? baht(c) : 'ไม่พอ (ขาด ' + baht(-c) + ')');
    btn.disabled = !(q.ok && q.amt > 0 && received() >= q.amt);
  }
  function requote() {
    clearTimeout(timer); const s = ++seq, b = body();
    if (!b.invoiceIds.length && !b.years.length) { q = {ok: false, amt: 0, items: [], err: '', busy: false}; paint(); return; }
    q = {ok: false, amt: 0, items: [], err: '', busy: true}; paint();
    timer = setTimeout(async () => {
      let n;
      try {
        const r = await api('POST', '/api/staff/quote', b);
        n = r.ok ? {ok: true, amt: r.data.amountSatang, items: r.data.items || [], err: '', busy: false} : {ok: false, amt: 0, items: [], err: errMsg(r.data), busy: false};
      } catch (e) { if (e.message === '401') return; n = {ok: false, amt: 0, items: [], err: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', busy: false}; }
      if (s === seq) { q = n; paint(); }
    }, 300);
  }
  const opt = (checked, text, fn) => {
    const c = el('input', {type: 'checkbox', checked, onchange: () => { fn(c.checked); requote(); }});
    return el('label', {class: 'opt'}, c, el('span', null, text));
  };
  const yopt = (y, text) => opt(false, text, on => { if (on) yr.set(y, {payerCode: p.code, fiscalYear: y}); else yr.delete(y); });

  async function pay() {
    put(msg); btn.disabled = true;
    const r = await App.call(msg, 'POST', '/api/staff/counter/pay', Object.assign(body(), {receivedSatang: received()}));
    if (r && r.ok) done(root, r.data, p); else paint();
  }

  recv.addEventListener('input', paint);
  put(list, un.length ? un.map(i => opt(true, fper(i.period) + ' · ' + baht(i.amountSatang), on => { if (on) inv.add(i.id); else inv.delete(i.id); }))
    : note('muted', 'ไม่มีรายการค้างชำระ'),
    el('div', {class: 'sep'}), yopt(fy, 'ทั้งปีงบประมาณ ' + fy), yopt(fy + 1, 'ล่วงหน้าทั้งปี ' + (fy + 1)));
  put(root,
    el('div', {class: 'card'}, el('b', null, p.name), ' ', badge(CAT[p.category] || p.category, '#1b7f4b'),
      el('div', {class: 'muted'}, 'รหัส: ' + p.code), el('div', {class: 'muted'}, p.address), el('div', {class: 'muted'}, 'อัตรา ' + baht(p.rateSatang) + '/เดือน')),
    el('div', {class: 'card'}, list),
    el('div', {class: 'card'}, qBox, el('label', null, 'รับเงิน (บาท)'), recv, change, btn, msg));
  requote();
}

function done(root, res, p) {
  const now = new Date().toLocaleString('th-TH', {dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok'});
  const rs = res.receipts || [];
  put(root, el('div', {class: 'card'}, note('ok', 'บันทึกการชำระเงินแล้ว'),
    rs.map(r => el('div', {class: 'sep'}, el('b', null, 'ใบเสร็จ ' + r.receiptNo), el('div', null, baht(r.amountSatang) + ' · งวด ' + psum(r.periods || [])),
      r.verifyUrl ? el('a', {href: r.verifyUrl, target: '_blank', rel: 'noopener'}, 'ลิงก์ตรวจสอบใบเสร็จ') : null)),
    el('p', null, 'ยอดชำระ ' + baht(res.amountSatang) + ' · เงินทอน ' + baht(res.changeSatang || 0)),
    el('p', {class: 'muted'}, res.lineNotified ? 'ส่งแจ้งเตือนทาง LINE แล้ว' : 'ไม่ได้ส่งแจ้งเตือนทาง LINE (ผู้ชำระยังไม่เชื่อมบัญชี หรือส่งไม่สำเร็จ)'),
    el('button', {class: 'btn full', onclick: () => window.print()}, 'พิมพ์ใบเสร็จ'),
    el('button', {class: 'btn sec full', onclick: () => App.route()}, 'รายการใหม่')));
  const recvTotal = (res.amountSatang || 0) + (res.changeSatang || 0), mu = (App.me.settings.municipality || {}).name || 'เทศบาล';
  put($('print'), rs.map(r => el('section', null,
    el('h2', null, mu), el('p', null, 'ใบเสร็จรับเงินค่าธรรมเนียมขยะ'), el('hr'),
    el('p', null, 'เลขที่ใบเสร็จ: ' + r.receiptNo), el('p', null, 'รหัสผู้ชำระ: ' + (r.payerCode || p.code)), el('p', null, 'ชื่อ: ' + p.name),
    el('p', null, 'งวด: ' + (r.periods || []).map(fper).join(', ')), el('p', null, 'จำนวนเงิน: ' + baht(r.amountSatang)),
    rs.length === 1 ? [el('p', null, 'รับเงิน: ' + baht(recvTotal)), el('p', null, 'เงินทอน: ' + baht(res.changeSatang || 0))] : null,
    el('p', null, 'วันที่: ' + now), el('hr'), el('p', null, 'ผู้รับเงิน: ______________________ (' + App.user.name + ')'))));
}
