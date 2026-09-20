// How much of the battle simulator's cost is relay machinery the arena never uses?
const fs = require('fs');
function numOr(v){ return typeof v==='number'&&isFinite(v)?v:null; }
const src = fs.readFileSync('astrolabe.user.js','utf8');
const a = src.indexOf('  var PVP_STATS =');
const b = src.indexOf('  /* ============================================================\n     13. UI');
eval(src.slice(a,b) + ';globalThis.A = { rlBattle, pvRng, RL_MAX_ROUNDS };');

const mk = (n, hp, dmg, prec, eva) => ({ N: n, hp, dmg, prec, eva,
  sk: { dot: 0.10, focus: 0.05, stun: 0.05, block: 0.20 },
  cl: [{ crit: 0.265, cm: 1.535, dual: 0.24 }] });
const me = mk(8, 22386, 3134, 873, 850);
const op = mk(8, 23000, 3180, 900, 880);

// ---- current engine ----
function runCurrent(sims) {
  let w = 0;
  for (let i = 0; i < sims; i++) {
    const r = A.rlBattle([me], [op], i % 2 === 0, A.pvRng(7 + i * 7919));
    w += r.win;
  }
  return w;
}

// ---- prototype: 1v1 only, scratch buffers reused, no kill multiplier ----
const MAXN = 64;
const hpA = new Float64Array(MAXN), hpB = new Float64Array(MAXN);
const chA = new Int8Array(MAXN), chB = new Int8Array(MAXN);
const stA = new Uint8Array(MAXN), stB = new Uint8Array(MAXN);
const F = { S: null, hp: null, ch: null, st: null, mark: -1, alive: 0 };
function load(f, S, hp, ch, st) {
  f.S = S; f.hp = hp; f.ch = ch; f.st = st; f.mark = -1; f.alive = S.N;
  for (let i = 0; i < S.N; i++) { hp[i] = S.hp; ch[i] = 0; st[i] = 0; }
}
function phase(a, d, rnd) {
  const S = a.S, T = d.S;
  for (let i = 0; i < S.N; i++) {
    if (d.alive <= 0) return;
    if (a.hp[i] <= 0) continue;
    if (a.st[i]) { a.st[i] = 0; continue; }
    const cl = S.cl[i % S.cl.length];
    const shots = rnd() < cl.dual ? 2 : 1;
    for (let s = 0; s < shots && d.alive > 0; s++) {
      let t;
      if (d.mark >= 0 && d.hp[d.mark] > 0) t = d.mark;
      else { let pick = Math.floor(rnd() * d.alive); t = -1;
        for (let k = 0; k < T.N; k++) if (d.hp[k] > 0) { if (pick === 0) { t = k; break; } pick--; } }
      if (rnd() >= S.prec / (S.prec + T.eva)) continue;
      if (T.sk.block > 0 && rnd() < T.sk.block) continue;
      const base = S.dmg;
      let dmg = base * (rnd() < cl.crit ? cl.cm : 1);
      if (d.ch[t] > 0) { d.ch[t]--; dmg += base * 0.5; }
      d.hp[t] -= dmg;
      if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; }
      else {
        if (S.sk.dot > 0 && rnd() < S.sk.dot) { d.ch[t] = 2; d.hp[t] -= base * 0.5;
          if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; } }
        if (d.hp[t] > 0) {
          if (S.sk.stun > 0 && !d.st[t] && rnd() < S.sk.stun) d.st[t] = 1;
          if (S.sk.focus > 0 && d.mark < 0 && rnd() < S.sk.focus) d.mark = t;
        }
      }
    }
  }
}
const fa = Object.assign({}, F), fb = Object.assign({}, F);
function frac(f) { if (f.alive <= 0) return 0; let s = 0; for (let i = 0; i < f.S.N; i++) if (f.hp[i] > 0) s += f.hp[i]; return s / (f.S.N * f.S.hp); }
function duel(SA, SB, aFirst, rnd) {
  load(fa, SA, hpA, chA, stA); load(fb, SB, hpB, chB, stB);
  const first = aFirst ? fa : fb, second = aFirst ? fb : fa;
  let r;
  for (r = 1; r <= A.RL_MAX_ROUNDS && fa.alive > 0 && fb.alive > 0; r++) {
    phase(first, second, rnd);
    if (second.alive <= 0) break;
    phase(second, first, rnd);
  }
  const la = frac(fa), lb = frac(fb);
  return { win: fb.alive <= 0 ? 1 : (fa.alive <= 0 ? 0 : (la >= lb ? 1 : 0)),
    rounds: r > A.RL_MAX_ROUNDS ? A.RL_MAX_ROUNDS : r, fracA: la, fracB: lb };
}
function runNew(sims) {
  let w = 0;
  for (let i = 0; i < sims; i++) { const r = duel(me, op, i % 2 === 0, A.pvRng(7 + i * 7919)); w += r.win; }
  return w;
}

const SIMS = 40000;
runCurrent(2000); runNew(2000);   // warm up
let t0 = process.hrtime.bigint(); const wc = runCurrent(SIMS); let t1 = process.hrtime.bigint();
const msCur = Number(t1 - t0) / 1e6;
t0 = process.hrtime.bigint(); const wn = runNew(SIMS); t1 = process.hrtime.bigint();
const msNew = Number(t1 - t0) / 1e6;
console.log('sims            ', SIMS);
console.log('current engine  ', msCur.toFixed(0) + ' ms', ' win rate', (wc / SIMS * 100).toFixed(2) + '%');
console.log('1v1 + reuse     ', msNew.toFixed(0) + ' ms', ' win rate', (wn / SIMS * 100).toFixed(2) + '%');
console.log('speed-up        ', (msCur / msNew).toFixed(2) + 'x', ' (' + (100 - msNew / msCur * 100).toFixed(0) + '% less time)');
console.log('win rates agree ', Math.abs(wc - wn) / SIMS < 0.02 ? 'yes' : 'NO - ' + wc + ' vs ' + wn);

// Strict equivalence: every sim must agree on win, rounds and both health fractions.
let bad = 0, checked = 0, firstBad = null;
for (const [P, Q] of [[me, op], [op, me], [mk(4,90000,9000,1200,600), mk(8,40000,4000,700,1400)]]) {
  for (let i = 0; i < 4000; i++) {
    const r1 = A.rlBattle([P], [Q], i % 2 === 0, A.pvRng(31 + i * 7919));
    const r2 = duel(P, Q, i % 2 === 0, A.pvRng(31 + i * 7919));
    checked++;
    const same = r1.win === r2.win && r1.rounds === r2.rounds &&
      Math.abs(r1.fracA - r2.fracA) < 1e-12 && Math.abs(r1.fracB - r2.fracB) < 1e-12;
    if (!same) { bad++; if (!firstBad) firstBad = { i, r1: {w:r1.win,r:r1.rounds,a:r1.fracA,b:r1.fracB}, r2 }; }
  }
}
console.log('\nstrict per-sim equivalence over', checked, 'battles:', bad === 0 ? 'IDENTICAL' : bad + ' MISMATCHES');
if (firstBad) console.log('first mismatch', JSON.stringify(firstBad));
