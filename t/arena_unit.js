const fs = require('fs');
function numOr(v){ return typeof v==='number'&&isFinite(v)?v:null; }
const src = fs.readFileSync('astrolabe.user.js','utf8');
const a = src.indexOf('  var PVP_STATS =');
const b = src.indexOf('  /* ============================================================\n     13. UI');
eval(src.slice(a,b) + ';globalThis.A = { arBuild, arKey, arSide, arDamage, rlDuel, rlMe, pvTotals, pvRng };');

// A duel with known truth, so we can check what the recorder gets back.
function makeDuel(truth, seed) {
  let s = seed >>> 0; const rnd = () => ((s = (s*1664525+1013904223)>>>0)/4294967296);
  const logs = [], hp = {};
  const mk = (who, t) => { for (let i=1;i<=t.n;i++) hp[`${who}'s Clone ${i}`] = t.hp; };
  mk('Me', truth.me); mk('Op', truth.op);
  const live = who => Object.keys(hp).filter(k => k.startsWith(who+"'s") && hp[k] > 0);
  let round = 0, winner = null;
  while (round < 60 && live('Me').length && live('Op').length) {
    round++; logs.push({ round, attacker: null, defender: null, action: 'round', value: round });
    for (const [me, op] of [['Me','Op'],['Op','Me']]) {
      const t = truth[me === 'Me' ? 'me' : 'op'], o = truth[me === 'Me' ? 'op' : 'me'];
      for (const c of live(me)) {
        const tg = live(op); if (!tg.length) break;
        const target = tg[Math.floor(rnd()*tg.length)];
        const hitChance = t.prec/(t.prec+o.eva);
        if (rnd() >= hitChance) { logs.push({ round, attacker: c, defender: target, action: 'misses hit on', value: null }); continue; }
        if (rnd() < o.block) { logs.push({ round, attacker: c, defender: target, action: 'attack blocked', value: null }); continue; }
        const crit = rnd() < t.crit;
        const dmg = Math.round(t.dmg * (crit ? t.cm : 1));
        hp[target] = Math.max(0, hp[target] - dmg);
        logs.push({ round, attacker: c, defender: target, action: 'attacks', value: dmg, hpLeft: `[${hp[target]}/${o.hp}]` });
        if (hp[target] <= 0) logs.push({ round, attacker: null, defender: target, action: 'dies', value: null });
      }
    }
  }
  winner = live('Me').length ? 'Me' : 'Op';
  logs.push({ round, attacker: winner, defender: null, action: 'won', value: 0 });
  return { _id: 'D'+seed, created: 1789000000, attackerName: 'Me', defenderName: 'Op',
    attackerElo: 1500, defenderElo: 1490, eloDelta: 10, winner, logs };
}

const truth = { me: { n: 7, hp: 121324, dmg: 16674, prec: 873, eva: 850, crit: 0.265, cm: 1.535, block: 0.20 },
                op: { n: 8, hp: 109480, dmg: 15760, prec: 1892, eva: 1553, crit: 0.25, cm: 1.6, block: 0.0 } };
// our build "now" reproduces the logged damage and hp exactly
const pv = { pts:{power:0,precision:873,evasion:850,hull:0}, pool:0, craft:0, vel:0, N:7, mats:{}, badges:0, clones:[],
  gear:[{name:'helmet',stat:'power',skill:'block',L:0,T:0,mat:''}] };
pv.pts.power = truth.me.dmg / truth.me.n; pv.pts.hull = truth.me.hp / (7*truth.me.n);

const duel = makeDuel(truth, 11);
const rec = A.arBuild(duel, 'Me', pv, Date.now());
let bad = 0;
const ok = (label, got, want, tol) => { const good = Math.abs(got-want) <= (tol||0); if(!good) bad++;
  console.log((good?'ok   ':'FAIL ')+label.padEnd(36)+String(got).padStart(10)+'   want '+want+(tol?' ±'+tol:'')); };
console.log('-- recovered exactly from the log --');
ok('our clones', rec.o.n, truth.me.n);
ok('their clones', rec.e.n, truth.op.n);
ok('our max hp', rec.o.h, truth.me.hp);
ok('their max hp', rec.e.h, truth.op.hp);
ok('our base damage', rec.o.d, truth.me.dmg);
ok('their base damage', rec.e.d, truth.op.dmg);
ok('winner recorded', rec.w, duel.winner === 'Me' ? 1 : 0);
ok('build matches, no ~ flag', rec.a || 0, 0);
console.log('-- inferred --');
// one duel gives a noisy read of these, so check the average over many
const many = [];
for (let k = 0; k < 20; k++) { const d = makeDuel(truth, 100 + k * 13); const r = A.arBuild(d, 'Me', pv, Date.now()); if (r) many.push(r); }
const avg = f => many.reduce((a, r) => a + f(r), 0) / many.length;
const spread = f => { const m = avg(f); return Math.sqrt(many.reduce((a, r) => a + (f(r) - m) ** 2, 0) / many.length); };
console.log('   (' + many.length + ' duels; one duel alone is noisy, the average is what matters)');
ok('their precision, mean of 20', Math.round(avg(r => r.e.p)), truth.op.prec, truth.op.prec * 0.15);
ok('their evasion, mean of 20', Math.round(avg(r => r.e.e)), truth.op.eva, truth.op.eva * 0.15);
console.log('   spread across single duels: precision ±' + Math.round(spread(r => r.e.p)) + ', evasion ±' + Math.round(spread(r => r.e.e)));
ok('exact fields never drift', Math.max(...many.map(r => Math.abs(r.e.h - truth.op.hp) + Math.abs(r.e.n - truth.op.n))), 0);
ok('our block share %', rec.o.s[3], truth.me.block*100, 8);
ok('their crit share %', rec.e.c[0][0], truth.op.crit*100, 12);
console.log('-- the score is a win rate --');
const pool = [A.arSide(rec.e)];
const meSide = A.rlMe({ ...pv, clones:[{crit:truth.me.crit, cm:truth.me.cm, dual:0}] });
let wins = 0, rnds = 0; const SIMS = 400;
for (let i = 0; i < SIMS; i++) { const r = A.rlDuel(meSide, pool[0], i % 2 === 0, A.pvRng(7 + i * 7919)); wins += r.win; rnds += r.rounds; }
console.log('   simulated win rate vs this opponent: ' + Math.round(wins/SIMS*100) + '%  (real duel: ' + (rec.w?'won':'lost') + ', ' + rec.r + ' rounds, sim ' + Math.round(rnds/SIMS) + ')');
console.log(bad ? '\n'+bad+' FAILED' : '\nall checks passed');

// why did the precision fit land where it did?
(function(){
  const t = {}; 
  duel.logs.forEach(e => { const m = /^(.*)'s Clone/.exec(e.attacker||''); if(!m) return; const o = t[m[1]] || (t[m[1]] = {hit:0,miss:0,blk:0});
    if (e.action==='attacks') o.hit++; else if (e.action==='misses hit on') o.miss++; else if (e.action==='attack blocked') o.blk++; });
  Object.keys(t).forEach(k => { const o=t[k], land=o.hit+o.blk, all=land+o.miss;
    console.log('   ' + k + ': landed ' + land + '/' + all + ' = ' + (land/all*100).toFixed(1) + '%  (attacks ' + o.hit + ', blocked ' + o.blk + ', missed ' + o.miss + ')'); });
  const exp = truth.op.prec/(truth.op.prec+truth.me.eva);
  console.log('   expected Op landing rate ' + (exp*100).toFixed(1) + '%');
})();
