// Run once against locally captured Seller Hub DOM snapshots in .artifacts.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('.artifacts/ebay-slab-evaluation');
const out = path.resolve('docs/ebay-slab-evaluation');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
function unquote(s) {
  s = s.trim().replace(/:$/, '');
  if (s.startsWith("'")) s = s.slice(1, -1).replaceAll("''", "'");
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  return s;
}
function rows(o) {
  if (o.activeFallback || /No sold results found/.test(o.snapshot)) return [];
  const parts = o.snapshot.split(/\n    - (?=['"]?row )/).slice(1);
  if (!parts.length) return (o.rows ?? []).map(r => ({...r, cells: [r.links[0]?.text ?? r.cells[0], ...r.cells.slice(1)]}));
  return parts.flatMap(p => {
    const cells = p.split('\n').filter(l => /^      - ['"]?cell[ :]/.test(l)).map(l => unquote(l.replace(/^      - /, '')).replace(/^cell ?/, '')).map(unquote);
    if (cells.length !== (o.sample >= 200 ? 7 : 8)) return [];
    cells[0] = cells[0].split(', preview full size image')[0].trim();
    const url = p.match(/\/url: (https:\/\/www\.ebay\.com\/itm\/[^\n]+)/)?.[1];
    return [{cells, links: url ? [{text: cells[0], url}] : []}];
  });
}
const money = s => { const m = s.match(/\$([\d,]+\.\d{2})/); return m ? Number(m[1].replaceAll(',', '')) : null; };
function normalize(o) {
  const active = o.sample >= 200;
  const result = {...o}; delete result.snapshot; delete result.rows;
  result.possiblyPageLimited = /button "Go to next page"(?! \[disabled\])/.test(o.snapshot);
  result.rows = rows(o).map((r, i) => ({row: i + 1, title: r.cells[0], url: r.links[0]?.url ?? null,
    itemId: r.links[0]?.url.match(/\/itm\/(\d+)/)?.[1] ?? r.cells[0].match(/Item ID:?[ #]*(\d+)/i)?.[1] ?? null,
    price: money(r.cells[2]), shipping: active ? money(r.cells[2].replace(/^\$[\d,.]+/, '')) ?? (/Free shipping/i.test(r.cells[2]) ? 0 : null) : money(r.cells[3]), format: active ? (r.cells[3] === '-' ? 'unspecified-ask' : 'auction-bid') : /Auction/i.test(r.cells[2]) ? 'auction' : /Fixed price/i.test(r.cells[2]) ? 'fixed' : 'unknown',
    quantity: !active && /^\d+$/.test(r.cells[4]) ? Number(r.cells[4]) : null, date: r.cells[active ? 6 : 7], sourceCells: r.cells.slice(1), evidence: active ? 'active' : 'sold-listing-average'}));
  return result;
}
const base = read('observations.json');
const evidence = {observedAt: base.observedAt, seller: base.seller, inventoryObserved: base.inventoryObserved, slabCandidates: base.slabCandidates, sample: base.sample,
  window: {start: '2026-06-07', end: '2026-09-05', marketplace: 'EBAY-US'},
  observations: base.observations.map(normalize), gradeGaps: read('grade-gap-observations.json').observations.map(normalize), supply: read('supply-observations.json').observations.map(normalize)};
if (evidence.observations.length !== 50 || new Set(evidence.observations.map(o => o.sample)).size !== 50) throw Error('Incomplete sample');
for (const o of evidence.observations) {
  const original = base.observations.find(x => x.sample === o.sample);
  if (o.rows.length !== original.rows.length) throw Error(`Row count mismatch ${o.sample}: ${o.rows.length}/${original.rows.length}`);
}
for (const o of [...evidence.observations, ...evidence.gradeGaps]) for (const r of o.rows) {
  if (r.title.includes('\n') || r.price === null || r.shipping === null || !/2026$/.test(r.date)) throw Error(`Malformed row ${o.sample}/${r.row}`);
}
fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({sample: evidence.sample.length, rows: evidence.observations.reduce((s,o)=>s+o.rows.length,0), gaps: evidence.gradeGaps.map(o=>[o.sample,o.rows.length]), supply: evidence.supply.map(o=>[o.sample,o.rows.length])}));
