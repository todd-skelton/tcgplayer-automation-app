// Reproduce the narrow evaluation from normalized visible Seller Hub evidence.
// This is a research diagnostic, not an application pricing algorithm.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir = new URL('./', import.meta.url);
const d = JSON.parse(fs.readFileSync(new URL('evidence.json', dir), 'utf8'));
const median = values => { const s = [...values].sort((a,b)=>a-b); const n=s.length; return n ? (s[Math.floor((n-1)/2)] + s[Math.floor(n/2)]) / 2 : null; };
const round = n => Math.round((n+1e-9)*100)/100;
const delivered = r => r.price + r.shipping;
const observation = n => [...d.observations, ...d.gradeGaps].find(o=>o.sample===n);
const ownIds = new Set(d.sample.map(s=>s.url.match(/\/itm\/(\d+)/)[1]));
function choose(n, indices) {
  const o = observation(n);
  const rows = indices.map(i=>o.rows.find(r=>r.row===i));
  assert(rows.every(Boolean), `Missing source row ${n}`);
  assert(rows.every(r=>r.evidence==='sold-listing-average' && r.quantity===1 && r.shipping!==null && !ownIds.has(r.itemId)));
  return rows;
}
// Explicit decisions after reviewing all titles in these eight queries.
// Require target card number, Japanese identity, correct PSA grade; defer conflicting set names.
// These are title-compatible observations, not image/certification-verified ground truth.
const selections = [
  {card:'Flareon 022/187', ten:17, nine:107, excludeTen:[6,10,11,13,27], excludeNine:[]},
  {card:'Vaporeon 031/187', ten:25, nine:109, excludeTen:[4,5,6,8,9,10,12,14,15,17,27,28,30,31,33,34,35,36,37,38,40], excludeNine:[]},
  {card:'Leafeon 003/187', ten:28, nine:108, excludeTen:[5,7,11,12,13,16,19,24,27,28,31,33,34,36,37,43,44,45,46], excludeNine:[1]},
  {card:'Glaceon 041/187', ten:39, nine:110, excludeTen:[5,7,8,9,12,14,15,17,20,21,25,26,28,30,32,35,36,39,40,42,43,45,46], excludeNine:[2]},
];
const pairs = selections.map(s=> {
  const ten = choose(s.ten, observation(s.ten).rows.filter(r=>!s.excludeTen.includes(r.row)).map(r=>r.row));
  const nine = choose(s.nine, observation(s.nine).rows.filter(r=>!s.excludeNine.includes(r.row)).map(r=>r.row));
  assert(ten.every(r=>/PSA\s+(?:Graded\s+)?10\b/i.test(r.title)));
  assert(nine.every(r=>/PSA\s+9\b/i.test(r.title)));
  const median10=median(ten.map(delivered)), median9=median(nine.map(delivered));
  return {...s, count10:ten.length, count9:nine.length, median10, median9, ratio:median10/median9,
    accepted10:ten.map(r=>r.row), accepted9:nine.map(r=>r.row)};
});
for (const p of pairs) {
  const others = pairs.filter(q=>q!==p);
  // Fit on OTHER cards only; the held-out card contributes its PSA 10 evidence.
  p.fittedRatio = Math.exp(median(others.map(q=>Math.log(q.ratio))));
  p.predicted9 = p.median10/p.fittedRatio;
  p.absolutePercentageError = Math.abs(p.predicted9/p.median9-1)*100;
  p.unadjustedGrade10Error = Math.abs(p.median10/p.median9-1)*100;
}
const cases = [
  {sample:19, name:'Slaking PSA 9', rows:[1,2]},
  {sample:34, name:'Buneary Master Ball PSA 10', rows:[1,2]},
  {sample:10, name:'Okidogi CGC 10, label unconfirmed in comp titles', rows:[1,3]},
  {sample:14, name:'Sentomaru CGC Pristine 10', rows:observation(14).rows.filter(r=>/CGC/i.test(r.title)&&/pristine/i.test(r.title)).map(r=>r.row)},
].map(c=> {const rows=choose(c.sample,c.rows); return {...c, askingItemPrice:d.sample[c.sample-1].askingPrice, soldListingCount:rows.length, medianItemPrice:median(rows.map(r=>r.price)), medianDeliveredPrice:median(rows.map(delivered)), minDelivered:Math.min(...rows.map(delivered)), maxDelivered:Math.max(...rows.map(delivered))};});
assert.equal(d.observations.length,50);
assert.equal(observation(2).rows.length,0); // Active fallback must never become a sold comp.
assert.equal(d.observations.reduce((s,o)=>s+o.rows.length,0),800);
const unique = d.observations.filter(o=>o.sample!==40);
const metrics = {
  sampleListings:50, uniqueValuationGroups:49, rawRows:800, rawRowsWithoutRepeatedQuery:unique.reduce((s,o)=>s+o.rows.length,0),
  noSoldResults:d.observations.filter(o=>!o.rows.length).map(o=>o.sample),
  queriesWithMorePages:d.observations.filter(o=>o.possiblyPageLimited).map(o=>o.sample),
  pairs, meanAbsolutePercentageError:pairs.reduce((s,p)=>s+p.absolutePercentageError,0)/pairs.length,
  unadjustedGrade10MeanError:pairs.reduce((s,p)=>s+p.unadjustedGrade10Error,0)/pairs.length, cases,
};
fs.writeFileSync(new URL('results.json',dir),JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify({...metrics,pairs:pairs.map(({card,count10,count9,median10,median9,ratio,predicted9,absolutePercentageError})=>({card,count10,count9,median10:round(median10),median9:round(median9),ratio:round(ratio),predicted9:round(predicted9),absolutePercentageError:round(absolutePercentageError)}))},null,2));
