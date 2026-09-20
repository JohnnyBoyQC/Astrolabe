// Which slice is the slow one? Wrap setTimeout and fingerprint each step.
const fs = require('fs');
function numOr(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
const src = fs.readFileSync('astrolabe.user.js', 'utf8');
const a = src.indexOf('  var PVP_STATS ='), b = src.indexOf('  /* ============================================================\n     13. UI');
eval(src.slice(a, b) + ';globalThis.P = { readPvp, pvPlanRun };');
const root = JSON.parse(fs.readFileSync('t/root.json', 'utf8'));
const pv = P.readPvp(root);
const recs = [];
for (let i = 0; i < 200; i++) recs.push({ v: 3, t: i, i: 'S' + i, w: i % 3 ? 1 : 0, f: i % 2, r: 12 + (i % 9),
  o: { n: 8, d: 25072, h: 179088, p: 873, e: 850, s: [0,0,0,20], c: [[26.5,23.5,24]], x: 0, q: [38+(i%5),60,30+(i%4),58] },
  e: { n: 8, d: 24900+(i%7)*60, h: 178500+(i%5)*900, p: 880+(i%9)*6, e: 856+(i%6)*5, s: [0,0,0,18], c: [[26,24,22]], x: 0, q: [30+(i%4),58,38+(i%5),60] } });
const real = setTimeout;
const log = [];
global.setTimeout = (fn, ms) => real(() => {
  const t0 = Date.now(); fn(); const d = Date.now() - t0;
  log.push(d);
}, ms);
// fingerprint: patch Function.prototype.toString capture via a proxy on the steps array is messy,
// so instead time the named helpers directly
const marks = {};
['pvScoreOf','pvBestAssign','pvSpend','pvUpgradeRows','pvCompositions','pvPool','pvGap'].forEach(n => {
  const f = eval(n); marks[n] = { n: 0, ms: 0 };
  eval(n + ' = function(){ const t=Date.now(); const r=f.apply(null,arguments); marks["'+n+'"].ms += Date.now()-t; marks["'+n+'"].n++; return r; }');
});
const t0 = Date.now();
P.pvPlanRun(pv, recs, 0, (plan, err) => {
  global.setTimeout = real;
  if (err) { console.log('ERR', err); return; }
  console.log('total', ((Date.now()-t0)/1000).toFixed(1)+'s', 'longest slice', Math.max(...log)+'ms');
  console.log('\nwhere the time goes:');
  Object.keys(marks).sort((x,y)=>marks[y].ms-marks[x].ms).forEach(k => {
    if (marks[k].n) console.log('  ' + k.padEnd(16) + String(marks[k].ms).padStart(6) + ' ms over ' + marks[k].n + ' calls');
  });
});
