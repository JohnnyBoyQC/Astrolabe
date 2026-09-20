// Does searching against a sample of 40 opponents pick the same build as
// searching against all of them? The reported numbers are taken over the
// full pool either way; this is only about whether the SEARCH still lands
// in the same place.
const fs = require('fs');
function numOr(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
const raw = fs.readFileSync('astrolabe.user.js', 'utf8');
const a = raw.indexOf('  var PVP_STATS ='), b = raw.indexOf('  /* ============================================================\n     13. UI');
function build(cap) {
  const src = raw.slice(a, b).replace('var PV_SEARCH_MAX = 40;', 'var PV_SEARCH_MAX = ' + cap + ';');
  return (new Function('numOr', 'return (function(){' + src + ';return { readPvp, pvPlanRun, pvTotals };})()'))(numOr);
}
const CAPPED = build(40), FULL = build(100000);
const ROOT = () => JSON.parse(fs.readFileSync('t/root.json', 'utf8'));

function pool(kind, n, seed) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const recs = [];
  for (let i = 0; i < n; i++) {
    let d, h, p, e;
    if (kind === 'mirror')       { d = 24900 + rnd() * 900;   h = 178000 + rnd() * 9000;   p = 880 + rnd() * 90;    e = 856 + rnd() * 80; }
    else if (kind === 'evasive') { d = 19000 + rnd() * 3000;  h = 150000 + rnd() * 20000;  p = 1100 + rnd() * 400;  e = 1900 + rnd() * 700; }
    else if (kind === 'bruiser') { d = 34000 + rnd() * 6000;  h = 230000 + rnd() * 30000;  p = 700 + rnd() * 200;   e = 560 + rnd() * 150; }
    else                         { d = 18000 + rnd() * 22000; h = 130000 + rnd() * 130000; p = 600 + rnd() * 1700;  e = 500 + rnd() * 1700; }
    recs.push({ v: 3, t: i, i: kind + i, w: i % 3 ? 1 : 0, f: i % 2, r: 12 + (i % 9),
      o: { n: 8, d: 25072, h: 179088, p: 873, e: 850, s: [0, 0, 0, 20], c: [[26.5, 23.5, 24]], x: 0, q: [38 + (i % 5), 60, 30 + (i % 4), 58] },
      e: { n: 8, d: Math.round(d), h: Math.round(h), p: Math.round(p), e: Math.round(e),
           s: [0, 0, 0, 18], c: [[26, 24, 22]], x: 0, q: [28 + (i % 7), 58, 36 + (i % 6), 60] } });
  }
  return recs;
}
const desc = (bld) => bld.gear.map(g => g.stat.slice(0, 3) + '.' + g.skill.slice(0, 3)).join(' ');
const pts = (bld) => ['power', 'precision', 'evasion', 'hull'].map(k => k.slice(0, 3) + Math.round(bld.pts[k])).join(' ');

const cases = [['mirror', 120, 11], ['evasive', 120, 22], ['bruiser', 120, 33], ['mixed', 200, 44], ['mixed', 60, 55]];
let idx = 0, same = 0, fails = 0;
(function next() {
  if (idx >= cases.length) {
    console.log('\n' + same + ' of ' + cases.length + ' pools picked an identical build');
    console.log(fails ? fails + ' POOL(S) DIFFERED BEYOND THE ERROR BAR' : 'no pool differed beyond its own error bar');
    process.exit(fails ? 1 : 0);
  }
  const [kind, n, seed] = cases[idx++];
  const recs = pool(kind, n, seed);
  FULL.pvPlanRun(FULL.readPvp(ROOT()), recs, 0, (pf) => {
    CAPPED.pvPlanRun(CAPPED.readPvp(ROOT()), recs, 0, (pc) => {
      const label = (kind + ' x' + n).padEnd(14);
      if (!pf || !pc || pf.stop || pc.stop) { console.log('ok   ' + label + 'both declined to advise'); same++; return next(); }
      const gf = pf.free, gc = pc.free;
      const identical = desc(gf.build) === desc(gc.build) && pts(gf.build) === pts(gc.build);
      // the honest test: is the capped pick worse than the full pick by more than the noise?
      const within = Math.abs(gf.gain - gc.gain) <= 2 * Math.max(gf.se, gc.se);
      if (identical) same++;
      if (!within) fails++;
      console.log((within ? 'ok   ' : 'FAIL ') + label +
        (identical ? 'identical build' : 'different build') +
        '  | full ' + gf.gain.toFixed(2) + '±' + gf.se.toFixed(2) +
        '  capped ' + gc.gain.toFixed(2) + '±' + gc.se.toFixed(2) +
        '  searched ' + pc.searched + '/' + pc.contested);
      if (!identical) console.log('       full   ' + desc(gf.build) + '  ' + pts(gf.build) +
                                '\n       capped ' + desc(gc.build) + '  ' + pts(gc.build));
      next();
    });
  });
})();
