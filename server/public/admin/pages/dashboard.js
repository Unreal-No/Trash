'use strict';
App.pages.dashboard = async root => {
  const cur = App.currentFY();
  let charts = [], sort = {k: 'outstandingSatang', d: -1}, data;
  const body = el('div');
  const fy = sel([cur, cur - 1, cur - 2].map(y => [y, 'ปีงบประมาณ ' + y]), cur, {onchange: load, style: 'width:auto'});
  put(root, el('div', {class: 'row between wrap'}, el('h2', null, 'ภาพรวม'), fy), body);

  const tile = (l, v, s) => el('div', {class: 'kpi'}, el('span', {class: 'muted'}, l), el('b', null, v), s ? el('span', {class: 'muted'}, s) : null);
  const go = id => () => { location.hash = '#house/' + id; };

  function render() {
    charts.forEach(c => c.destroy()); charts = [];
    const d = data, h = d.houses, b = d.billing;
    const bar = el('canvas'), pie = el('canvas');
    const comm = [...d.byCommunity].sort((a, c) => (a[sort.k] > c[sort.k] ? 1 : a[sort.k] < c[sort.k] ? -1 : 0) * sort.d);
    put(body,
      el('div', {class: 'kpis'}, tile('บ้านทั้งหมด', num(h.total), 'ใช้งาน ' + num(h.active)),
        tile('ที่อยู่อาศัย', num(h.residential)), tile('ร้านค้า/กิจการ', num(h.commercial)),
        tile('เก็บได้แล้ว', baht(b.paidSatang)), tile('ค้างชำระ', baht(b.outstandingSatang)),
        tile('อัตราการจัดเก็บ', (b.collectionRate <= 1 ? b.collectionRate * 100 : b.collectionRate).toFixed(1) + '%'),
        tile('รอตรวจสอบ', num(h.pendingReview))),
      el('div', {class: 'cols'},
        el('div', {class: 'card'}, el('h3', null, 'ออกใบแจ้งหนี้ / ชำระ รายเดือน'), el('div', {class: 'chart'}, bar)),
        el('div', {class: 'card'}, el('h3', null, 'สถานะการชำระ'), el('div', {class: 'chart'}, pie))),
      el('div', {class: 'card'}, el('h3', null, 'แยกตามชุมชน'), App.table([
        {h: 'ชุมชน', k: 'community', f: r => r.community || '-'}, {h: 'บ้าน', k: 'houses', n: 1, f: r => num(r.houses)},
        {h: 'ชำระแล้ว', k: 'paid', n: 1, f: r => num(r.paid)}, {h: 'รอชำระ', k: 'due', n: 1, f: r => num(r.due)},
        {h: 'ค้างชำระ', k: 'overdue', n: 1, f: r => num(r.overdue)}, {h: 'ยอดค้าง', k: 'outstandingSatang', n: 1, f: r => baht(r.outstandingSatang)},
      ], comm, {sortKey: sort.k, sortDir: sort.d, onSort: k => { sort = {k, d: sort.k === k ? -sort.d : -1}; render(); }})),
      el('div', {class: 'cols'},
        el('div', {class: 'card'}, el('h3', null, 'ผู้ค้างชำระสูงสุด'), App.table([
          {h: 'บ้าน', f: r => el('a', {href: '#house/' + r.id}, r.address || r.code)}, {h: 'งวดเลยกำหนด', n: 1, f: r => num(r.overdueCount)},
          {h: 'ยอดค้าง', n: 1, f: r => baht(r.outstandingSatang)}], d.topDebtors || [])),
        el('div', {class: 'card'}, el('h3', null, 'รับชำระล่าสุด'), App.table([
          {h: 'เวลา', f: r => fdt(r.paidAt)}, {h: 'บ้าน', f: r => r.address || r.code}, {h: 'ช่องทาง', f: r => r.method},
          {h: 'จำนวน', n: 1, f: r => baht(r.amountSatang)}], d.recentPayments || []))));
    const m = d.monthly || [];
    charts.push(new Chart(bar, {type: 'bar', data: {labels: m.map(x => fper(x.period)), datasets: [
      {label: 'ออกใบแจ้งหนี้ (บาท)', data: m.map(x => x.invoicedSatang / 100), backgroundColor: '#9ccfb0'},
      {label: 'ชำระแล้ว (บาท)', data: m.map(x => x.paidSatang / 100), backgroundColor: '#1b7f4b'}]}, options: {responsive: true, maintainAspectRatio: false}}));
    const ks = Object.keys(PAY);
    charts.push(new Chart(pie, {type: 'doughnut', data: {labels: ks.map(k => PAY[k][0]), datasets: [{data: ks.map(k => (d.payStatus || {})[k] || 0), backgroundColor: ks.map(k => PAY[k][1])}]},
      options: {responsive: true, maintainAspectRatio: false}}));
  }
  async function load() {
    put(body, note('muted', 'กำลังโหลด...'));
    const r = await App.call(body, 'GET', '/api/staff/dashboard?fy=' + fy.value);
    if (r && r.ok) { data = r.data; render(); }
  }
  await load();
  return () => charts.forEach(c => c.destroy());
};
