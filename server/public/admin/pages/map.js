'use strict';
App.pages.map = async root => {
  const o = await App.opts();
  const comm = sel([['', 'ทุกชุมชน']].concat((o.communities || []).map(c => [c, c])), '', {onchange: load});
  const ps = sel([['', 'ทุกสถานะ']].concat(Object.keys(PAY).map(k => [k, PAY[k][0]])), '', {onchange: load});
  const mapDiv = el('div', {class: 'bigmap'}), legend = el('div', {class: 'legend muted'}), top = el('div');
  put(root, el('h2', null, 'แผนที่'), top, el('div', {class: 'card'},
    el('div', {class: 'grid'}, field('ชุมชน', comm), field('สถานะการชำระ', ps)), legend), mapDiv);
  const map = L.map(mapDiv).setView([16, 102.6], 13);
  App.osm(map);
  const layer = L.layerGroup().addTo(map);
  let first = true;
  setTimeout(() => map.invalidateSize(), 100);

  async function load() {
    const r = await api('GET', '/api/staff/map?' + qs({community: comm.value, payStatus: ps.value}));
    if (r.status === 403) { put(top, note('warn', 'ผู้ดูแลระบบปิดการแสดงแผนที่อยู่ (MAP_DISABLED)')); return; }
    if (!r.ok) { put(top, note('err', errMsg(r.data))); return; }
    put(top);
    const d = r.data, pts = d.points || [], counts = {};
    layer.clearLayers();
    pts.forEach(p => {
      counts[p.payStatus] = (counts[p.payStatus] || 0) + 1;
      const color = d.showStatus ? (PAY[p.payStatus] || PAY.NONE)[1] : '#1565c0';
      const pop = el('div', null, el('b', null, p.address), el('div', null, (CAT[p.category] || '') + (p.community ? ' · ' + p.community : '')),
        d.showStatus ? el('div', null, payBadge(p.payStatus)) : null, d.showStatus ? el('div', null, 'ยอดค้าง ' + baht(p.outstandingSatang)) : null,
        el('a', {href: '#house/' + p.id}, 'ดูรายละเอียดบ้าน'));
      L.circleMarker([p.lat, p.lng], {radius: 7, color: '#fff', weight: 1, fillColor: color, fillOpacity: .9}).bindPopup(pop).addTo(layer);
    });
    put(legend, el('span', null, 'ทั้งหมด ' + num(pts.length) + ' หลัง'), d.showStatus ? Object.keys(PAY).map(k =>
      el('span', null, el('i', {class: 'dot', style: 'background:' + PAY[k][1]}), PAY[k][0] + ' ' + num(counts[k] || 0))) : null);
    if (first && d.center) map.setView([d.center.lat, d.center.lng], d.center.zoom || 13);
    if (pts.length) map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), {padding: [30, 30], maxZoom: 18});
    first = false;
  }
  await load();
  return () => map.remove();
};
