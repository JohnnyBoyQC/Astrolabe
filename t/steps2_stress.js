const fs = require('fs');
function numOr(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
// pull the battlefield sections straight out of the built script
const src = fs.readFileSync('astrolabe.user.js', 'utf8');
const a = src.indexOf('  var PVP_STATS =');
const b = src.indexOf('  /* ============================================================\n     13. UI');
eval(src.slice(a, b) + ';globalThis.P = { readPvp, pvPlanRun, pvReplay };');
const root = JSON.parse(fs.readFileSync('t/root.json', 'utf8'));
const pv = P.readPvp(root);
// twenty arena duels against a varied field, in the 3.10 record shape
const recs = [];
for (let i = 0; i < 200; i++) recs.push({ v: 3, t: i, i: 'S' + i, w: i % 3 ? 1 : 0, f: i % 2, r: 12 + (i % 9),
  o: { n: 8, d: 25072, h: 179088, p: 873, e: 850, s: [0, 0, 0, 20], c: [[26.5, 23.5, 24]], x: 0, q: [38 + (i % 5), 60, 30 + (i % 4), 58] },
  e: { n: 8, d: 24900 + (i % 7) * 60, h: 178500 + (i % 5) * 900, p: 880 + (i % 9) * 6, e: 856 + (i % 6) * 5, s: [0, 0, 0, 18], c: [[26, 24, 22]], x: 0, q: [30 + (i % 4), 58, 38 + (i % 5), 60] } });
const real = setTimeout; const steps = [];
global.setTimeout = (fn, ms) => real(() => { const t0 = Date.now(); fn(); steps.push(Date.now() - t0); }, ms);
const t0 = Date.now();
P.pvPlanRun(pv, recs, 0, (plan, err) => {
  global.setTimeout = real;
  if (err) { console.log('ERR', err); return; }
  const top = steps.map((ms,i)=>[ms,i]).sort((a,b)=>b[0]-a[0]).slice(0,6);
  console.log('slowest slices (ms@index):', top.map(x=>x[0]+'@'+x[1]).join(' '));
  console.log('contested', plan.contested, 'of', plan.pool, '| total', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'slices', steps.length, 'longest slice', Math.max(...steps) + 'ms');
  console.log('cur', plan.cur.score.toFixed(1), 'free', plan.free.score.toFixed(1), 'gain', plan.free.gain.toFixed(2),
    'skills', plan.free.build.gear.map(g => g.skill.slice(0, 3)).join('+'), 'pts', JSON.stringify(plan.free.build.pts),
    'next rows', plan.next.length, 'top gain', Math.max(...plan.next.map(r => r.gain)).toFixed(2));
});
