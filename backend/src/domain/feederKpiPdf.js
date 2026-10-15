// PDF report of the PFC feeder KPIs for one or more feeders: per feeder, a
// summary table (17 indices x R / Y / B / Total for the period) and a trend
// chart for every index, drawn as vectors with pdfkit (same library as the
// reliability report). Pure layout: the caller passes the computed data.
//
// input: { range: { label, period }, generatedAt, defs: KPI_DEFS,
//          feeders: [{ feeder, substation, kpis, coverage, rating, granularity, points: [{ label, kpis }] }] }
import PDFDocument from 'pdfkit';

const PHASE_COLOR = { R: '#d7382a', Y: '#d99a14', B: '#2f6fd6', T: '#0f2847' };
const INK = '#0b2033', MUTED = '#61798a', GRID = '#dfe5ea';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const unitOf = (d) => (d.unit === '% of nominal' ? '%' : d.unit);
function fmt(v, unit) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  if (unit === 'Nos') return Number.isInteger(n) ? String(n) : n.toFixed(1);
  if (Math.abs(n) >= 10000) return Math.round(n).toLocaleString('en-IN');
  return n.toFixed(unit === 'min' ? 0 : 1);
}
const xLabel = (l, g) => (g === 'hour' ? l : `${+l.slice(8, 10)} ${MON[+l.slice(5, 7) - 1]}`);
const keysOf = (d) => (d.phased === false ? [['T', d.code]] : ['R', 'Y', 'B', 'T'].map((p) => [p, `${d.code}_${p}`]));

export function buildFeederKpiPdf(input) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, info: { Title: `Feeder PQ KPIs - ${input.range.label}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    input.feeders.forEach((f, k) => {
      if (k > 0) doc.addPage();
      summaryPage(doc, input, f);
      chartPages(doc, input, f);
    });

    // Footer on every page.
    const { start, count } = doc.bufferedPageRange();
    for (let p = start; p < start + count; p++) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0; // the footer sits below the margin; without this pdfkit adds a page
      doc.fontSize(7.5).fillColor(MUTED).font('Helvetica')
        .text(`PFC feeder KPIs - ${input.range.label} - generated ${input.generatedAt} - page ${p + 1} of ${count}`,
          36, doc.page.height - 28, { width: doc.page.width - 72, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

function header(doc, input, f, sub) {
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(f.feeder, 36, 36);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
    .text(`${f.substation || 'Substation not set'}  |  ${input.range.label} (${input.range.period})${sub ? `  |  ${sub}` : ''}`);
  doc.moveDown(0.6);
}

function summaryPage(doc, input, f) {
  header(doc, input, f);
  const c = f.coverage || {};
  const r = f.rating || {};
  doc.fontSize(9).fillColor(INK).font('Helvetica')
    .text(`Data completeness ${c.completenessPct ?? 0}%   |   ${c.samples ?? 0} readings   |   live ${fmt(c.liveMinutes, 'min')} min, without supply ${fmt(c.deadMinutes, 'min')} min`);
  doc.fillColor(MUTED)
    .text(`Rating: ${fmt(r.v_nominal_v)} V and ${fmt(r.i_nominal_a)} A nominal; V band ${r.v_lo_pct}-${r.v_hi_pct}%, I low ${r.i_lo_pct}%, I high ${r.i_hi_pct}%, V sag below ${r.v_sag_pct}%, I sag drop ${r.i_sag_drop_pct}%`);
  doc.moveDown(0.8);

  // Table: index | name | unit | R | Y | B | Total
  const x0 = 36, cols = [52, 210, 62, 46, 46, 46, 61], rowH = 15;
  const head = ['Index', 'Name', 'Unit', 'R', 'Y', 'B', 'Total'];
  let y = doc.y;
  const cell = (txt, i, yy, opts = {}) => {
    const x = x0 + cols.slice(0, i).reduce((a, b) => a + b, 0);
    doc.text(txt, x + 4, yy + 4, { width: cols[i] - 8, align: i >= 3 ? 'right' : 'left', lineBreak: false, ...opts });
  };
  const width = cols.reduce((a, b) => a + b, 0);
  doc.rect(x0, y, width, rowH).fill('#eef2f5');
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
  head.forEach((h, i) => cell(h, i, y));
  y += rowH;
  doc.font('Helvetica').fontSize(8.5);
  input.defs.forEach((d, n) => {
    if (n % 2) doc.rect(x0, y, width, rowH).fill('#f8fafb');
    doc.fillColor(INK);
    cell(d.code, 0, y, { characterSpacing: 0.2 });
    cell(d.name.replace(/^Feeder\s+/i, ''), 1, y);
    cell(d.unit, 2, y);
    const unit = unitOf(d);
    if (d.phased === false) { cell('', 3, y); cell('', 4, y); cell('', 5, y); cell(fmt(f.kpis?.[d.code], unit), 6, y); }
    else ['R', 'Y', 'B', 'T'].forEach((p, i) => cell(fmt(f.kpis?.[`${d.code}_${p}`], unit), 3 + i, y));
    y += rowH;
  });
  doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.5).strokeColor(GRID).stroke();
  doc.fillColor(MUTED).fontSize(8)
    .text('Total: incidents and durations count the feeder as in breach when any phase is; stress adds R + Y + B; max takes the highest phase; min and sag the lowest. "-" = no data or no event. Minutes without supply are excluded from every index.',
      x0, y + 8, { width });
}

function chartPages(doc, input, f) {
  const perPage = 6, W = (doc.page.width - 72 - 16) / 2, H = 214;
  input.defs.forEach((d, n) => {
    if (n % perPage === 0) {
      doc.addPage();
      header(doc, input, f, `trends per ${f.granularity || 'day'}`);
    }
    const slot = n % perPage;
    const x = 36 + (slot % 2) * (W + 16);
    const y = 86 + Math.floor(slot / 2) * (H + 18);
    chart(doc, { x, y, w: W, h: H }, d, f);
  });
}

function chart(doc, box, d, f) {
  const { x, y, w, h } = box;
  const unit = unitOf(d);
  doc.roundedRect(x, y, w, h, 5).lineWidth(0.6).strokeColor(GRID).stroke();
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(d.code, x + 8, y + 7, { lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text(`${d.name.replace(/^Feeder\s+/i, '')} (${d.unit})`, x + 8, y + 19, { width: w - 16, lineBreak: false, ellipsis: true });

  const series = keysOf(d).map(([p, key]) => ({ p, values: (f.points || []).map((pt) => pt.kpis?.[key] ?? null) }));
  const labels = (f.points || []).map((pt) => pt.label);
  const vals = series.flatMap((s) => s.values).filter((v) => v != null && Number.isFinite(v));
  const L = x + 40, R = x + w - 10, T = y + 44, B = y + h - 22;

  // Legend
  let lx = x + w - 8;
  for (const s of [...series].reverse()) {
    const name = s.p === 'T' ? (d.phased === false ? 'RYB' : 'Total') : s.p;
    const tw = doc.widthOfString(name) + 14;
    lx -= tw;
    doc.rect(lx, y + 32, 8, 2.5).fill(PHASE_COLOR[s.p]);
    doc.fillColor(MUTED).fontSize(7).text(name, lx + 10, y + 29.5, { lineBreak: false });
    lx -= 4;
  }

  if (!vals.length) return note(doc, box, 'No data in this period');
  if (d.agg === 'sum' && vals.every((v) => v === 0)) return note(doc, box, `No ${d.name.replace(/^Feeder\s+/i, '').replace(/\s*\(.*\)$/, '').toLowerCase()} in this period`);

  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (d.agg === 'sum') lo = Math.min(lo, 0);
  const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.1;
  if (d.agg !== 'sum') lo -= pad;
  hi += pad;
  const n = labels.length;
  const X = (i) => (n === 1 ? (L + R) / 2 : L + (i / (n - 1)) * (R - L));
  const Y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);

  doc.fontSize(6.8).font('Helvetica');
  for (let k = 0; k <= 4; k++) {
    const t = lo + ((hi - lo) * k) / 4;
    doc.moveTo(L, Y(t)).lineTo(R, Y(t)).lineWidth(0.4).strokeColor(GRID).stroke();
    doc.fillColor(MUTED).text(fmt(t, unit), x + 2, Y(t) - 3, { width: L - x - 5, align: 'right', lineBreak: false });
  }
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    doc.fillColor(MUTED).text(xLabel(labels[i], f.granularity), X(i) - 20, B + 5, { width: 40, align: 'center', lineBreak: false });
  }

  for (const s of series) {
    doc.lineWidth(s.p === 'T' ? 1.6 : 1).strokeColor(PHASE_COLOR[s.p]);
    let open = false;
    s.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { if (open) doc.stroke(); open = false; return; }
      if (!open) { doc.moveTo(X(i), Y(v)); open = true; } else doc.lineTo(X(i), Y(v));
    });
    if (open) doc.stroke();
    if (n <= 31) s.values.forEach((v, i) => { if (v != null && Number.isFinite(v)) doc.circle(X(i), Y(v), 1.3).fill(PHASE_COLOR[s.p]); });
  }
}

function note(doc, { x, y, w, h }, text) {
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(text, x + 10, y + h / 2, { width: w - 20, align: 'center', lineBreak: false });
}
