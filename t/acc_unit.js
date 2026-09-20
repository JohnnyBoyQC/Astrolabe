// How sure is the advice? Checks the uncertainty work added in 3.10.0:
// the spread of plausible opponents, the error bar on a win rate, the
// paired gap between two builds, and the "already settled" filter.
const fs = require('fs');
function numOr(v){ return typeof v==='number'&&isFinite(v)?v:null; }
const src = fs.readFileSync('astrolabe.user.js','utf8');
const a = src.indexOf('  var PVP_STATS =');
const b = src.indexOf('  /* ============================================================\n     13. UI');
eval(src.slice(a,b) + ';globalThis.A = { readPvp, pvCopy, pvPool, pvScoreOf, pvGap, pvNeedFor, arDraws, pvTotals, PV_DECIDED, PV_FLOOR, PV_CONTESTED };');

let fails = 0;
function ok(name, got, want, tol) {
  const good = tol === undefined ? got === want : Math.abs(got - want) <= tol;
  if (!good) fails++;
  console.log((good ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(40) + String(got).padStart(10) +
    (want === undefined ? '' : '   want ' + want + (tol ? ' ±' + tol : '')));
}
const say = s => console.log('   ' + s);

const pv = A.readPvp(JSON.parse(fs.readFileSync('t/root.json','utf8')));
const t0 = A.pvTotals(pv);

// ---- a duel, so the hit counts are real and not invented -------------
const me = { n: pv.N, hp: 121324, dmg: 16674, prec: Math.round(t0.precision), eva: Math.round(t0.evasion),
  crit: 0.265, cm: 1.535, block: 0.20 };
function duelCounts(op, seed) {
  let s = seed >>> 0; const rnd = () => ((s = (s*1664525+1013904223)>>>0)/4294967296);
  let mh=0, ma=0, th=0, ta=0, hpMe = me.n * me.hp, hpOp = op.n * op.hp, round = 0;
  while (round < 40 && hpMe > 0 && hpOp > 0) {
    round++;
    for (let c = 0; c < me.n && hpOp > 0; c++) { ma++; if (rnd() < me.prec/(me.prec+op.eva)) { mh++; hpOp -= me.dmg; } }
    for (let c = 0; c < op.n && hpMe > 0; c++) { ta++; if (rnd() < op.prec/(op.prec+me.eva)) { th++; hpMe -= op.dmg; } }
  }
  return [th, ta, mh, ma];
}
function fighterOf(op, seed) {
  return { n: op.n, d: op.dmg, h: op.hp, p: op.prec, e: op.eva, s: [0,0,0,5], c: [[25,0,0]], x: 0,
    q: duelCounts(op, seed), pRef: me.prec, eRef: me.eva };
}

console.log('-- the spread brackets the truth --');
const op = { n: 8, hp: 109480, dmg: 15760, prec: 1892, eva: 1553 };
let inside = 0, single = 0, tries = 40;
for (let i = 0; i < tries; i++) {
  const f = fighterOf(op, 4242 + i * 7919);
  const d = A.arDraws(f, me.prec, me.eva), ps = d.map(x => x.prec);
  if (op.prec >= Math.min(...ps) && op.prec <= Math.max(...ps)) inside++;
  if (Math.abs(d[2].prec - op.prec) < 0.1 * op.prec) single++;
}
ok('draws per opponent', A.arDraws(fighterOf(op, 1), me.prec, me.eva).length, 5);
// an old record with no swing counts still gets a spread, a wider one
const old = { n: 8, d: op.dmg, h: op.hp, p: op.prec, e: op.eva, s: [0,0,0,5], c: [[25,0,0]], x: 0, pRef: me.prec, eRef: me.eva };
const dOld = A.arDraws(old, me.prec, me.eva), dNew = A.arDraws(fighterOf(op, 99), me.prec, me.eva);
const width = d => Math.max(...d.map(x => x.prec)) - Math.min(...d.map(x => x.prec));
ok('an old record still gets a spread', dOld.length, 5);
say('assumed spread ' + Math.round(width(dOld)) + ' vs measured ' + Math.round(width(dNew)));
ok('and a wider one, being less sure', width(dOld) > width(dNew), true);
ok('nothing at all to go on, one draw', A.arDraws({ n:8, d:1, h:1, p:0, e:0, s:[0,0,0,0], c:[[0,0,0]] }, 0, 0).length, 1);
say('true precision inside the spread: ' + inside + '/' + tries + '; single guess within 10%: ' + single + '/' + tries);
ok('the spread catches it more often', inside > single, true);

console.log('-- the error bar shrinks with more duels --');
function poolOf(n, seed) {
  const recs = [];
  for (let k = 0; k < n; k++) {
    const o = { n: 8, hp: 100000 + (k % 7) * 9000, dmg: 12000 + (k % 5) * 1700,
      prec: 1400 + (k % 6) * 190, eva: 1300 + (k % 4) * 210 };
    const f = fighterOf(o, seed + k * 613);
    recs.push({ v: 3, t: k, i: 'X' + k, w: 1, f: k % 2, r: 10, o: { p: me.prec, e: me.eva }, e: f });
  }
  return A.pvPool(recs);
}
const s4 = A.pvScoreOf(pv, poolOf(4, 11));
const s16 = A.pvScoreOf(pv, poolOf(16, 11));
say('4 opponents: ' + s4.win.toFixed(2) + ' win, ±' + s4.se.toFixed(1) +
    '    16 opponents: ' + s16.win.toFixed(2) + ' win, ±' + s16.se.toFixed(1));
ok('more opponents, tighter bar', s16.se < s4.se, true);
ok('per-opponent rate for each one', s16.per.length, 16);

console.log('-- how many more duels would it take --');
ok('already there', A.pvNeedFor(4, 10, 5), 0);
ok('twice too wide needs 4x the duels', A.pvNeedFor(10, 8, 5), 24);
ok('nothing to go on', A.pvNeedFor(50, 0, 5), 0);

console.log('-- a build is only better if it beats its own noise --');
const pool = poolOf(12, 77);
const same = A.pvScoreOf(A.pvCopy(pv), pool);
const gSame = A.pvGap(A.pvScoreOf(pv, pool), same);
say('identical build: gain ' + gSame.gain.toFixed(2) + ' ± ' + gSame.se.toFixed(2));
ok('no gain against itself', Math.abs(gSame.gain) < 1e-9, true);
ok('and never called sure', gSame.gain > 2 * gSame.se, false);

const strong = A.pvCopy(pv);
Object.keys(strong.pts).forEach(k => { strong.pts[k] *= 3; });
const gStrong = A.pvGap(A.pvScoreOf(pv, pool), A.pvScoreOf(strong, pool));
say('three times the stat points: gain ' + gStrong.gain.toFixed(2) + ' ± ' + gStrong.se.toFixed(2));
ok('a real gain clears the bar', gStrong.gain > 2 * gStrong.se, true);

console.log('-- settled fights are set aside --');
const easy = poolOf(6, 5).concat(A.pvPool([{ v:3, t:0, i:'E', w:1, f:1, r:4,
  o: { p: me.prec, e: me.eva },
  e: { n: 1, d: 1, h: 1, p: 20, e: 20, s:[0,0,0,0], c:[[0,0,0]], x:0, q:[1,40,38,40] } }]));
const se = A.pvScoreOf(pv, easy);
const idx = []; se.per.forEach((w, i) => { if (w > A.PV_DECIDED && w < 1 - A.PV_DECIDED) idx.push(i); });
say('7 opponents, ' + idx.length + ' still in the balance, ' + (7 - idx.length) + ' settled');
ok('the free win is dropped', idx.indexOf(6), -1);
ok('the floor is 8 duels', A.PV_FLOOR, 8);

console.log('-- a mangled record does not bring the plan down --');
const junk = [
  null, {}, { v: 3, o: {}, e: {} }, { v: 3, o: { p: 1 }, e: { n: 'x', d: null, h: undefined, p: 'q', e: [], s: 'no', c: 'no' } },
  { v: 2, o: { p: 900, e: 900 }, e: { n: 8, d: 1000, h: 5000, p: 900, e: 900, s: [1, 2], c: [], q: 'nope' } },
  { v: 3, o: { p: 0, e: 0 }, e: { n: 8, d: 1000, h: 5000, p: 0, e: 0, s: [0,0,0,0], c: [[0,0,0]], q: [0, 0, 0, 0] } }
];
let threw = null;
let jpool = [];
try { jpool = A.pvPool(junk); A.pvScoreOf(pv, jpool.length ? jpool : poolOf(2, 3)); } catch (e) { threw = e.message; }
ok('no exception from junk records', threw, null);
ok('every usable one still scores', jpool.every(d => d.length >= 1 && d.every(x => isFinite(x.prec) && isFinite(x.eva) && isFinite(x.hp))), true);

console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
