const fs = require('fs');
function numOr(v){ return typeof v==='number'&&isFinite(v)?v:null; }
const src = fs.readFileSync('astrolabe.user.js','utf8');
const a = src.indexOf('  var PVP_STATS =');
const b = src.indexOf('  /* ============================================================\n     13. UI');
eval(src.slice(a,b) + ';globalThis.A = { readPvp, pvPool, pvPlanKey, arKey, pvReplay };');
const pv = A.readPvp(JSON.parse(fs.readFileSync('t/root.json','utf8')));

// 200 records, the new ceiling
const recs = [];
for (let i = 0; i < 200; i++) recs.push({ v: 3, t: 1789819200000 + i, i: ('66f2a1b4c3d5e6f70809' + (1000 + i)),
  w: i % 3 ? 1 : 0, f: i % 2, r: 12 + (i % 9),
  o: { n: 8, d: 25072, h: 179088, p: 873, e: 850, s: [0,0,0,20], c: [[26.5,23.5,24]], x: 0, q: [38+(i%5),60,30+(i%4),58] },
  e: { n: 8, d: 24800+i*20, h: 178000+i*90, p: 1850+i*3, e: 1520+i*2, s: [0,0,0,5], c: [[25,30,0]], x: 0, q: [30+(i%4),58,38+(i%5),60] } });

const before = JSON.stringify(recs).length;
A.pvPool(recs);                       // this is what the planner does
const after = JSON.stringify(recs).length;
console.log('--- does planning mutate the stored records? ---');
console.log('battles JSON before planning :', before, 'bytes');
console.log('battles JSON after  planning :', after, 'bytes',
  after > before ? ('  <-- grew ' + (after - before) + ' bytes (' + (+(100*(after-before)/before).toFixed(1)) + '%)') : '');
console.log('fields added to a record     :', Object.keys(recs[0].e).filter(k => /Ref$/.test(k)).join(',') || 'none');

console.log('\n--- pvPlanKey, rebuilt on every render of the Battle tab ---');
let t0 = process.hrtime.bigint();
let key;
for (let i = 0; i < 200; i++) key = A.pvPlanKey(pv, 0, recs);
let ms = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
console.log('key length                   :', key.length, 'chars');
console.log('cost per render              :', ms.toFixed(2), 'ms');

console.log('\n--- model check backlog on the Duels tab ---');
t0 = process.hrtime.bigint();
A.pvReplay(recs[0], 100);
ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log('one record, 100 replays      :', ms.toFixed(1), 'ms');
console.log('200 records, 30ms apart      :', ((200 * (30 + ms)) / 1000).toFixed(1), 's to finish the backlog');
