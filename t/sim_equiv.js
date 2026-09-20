// The 3.11 duel engine must agree with the 3.10.1 relay engine exactly.
const fs = require('fs');
function numOr(v){ return typeof v==='number'&&isFinite(v)?v:null; }
function load(file, exports) {
  const src = fs.readFileSync(file, 'utf8');
  const a = src.indexOf('  var PVP_STATS =');
  const b = src.indexOf('  /* ============================================================\n     13. UI');
  const sandbox = {};
  (new Function('numOr', 'return (function(){' + src.slice(a, b) + ';return {' + exports + '};})()'))(numOr);
  return (new Function('numOr', 'return (function(){' + src.slice(a, b) + ';return {' + exports + '};})()'))(numOr);
}
const OLD = load('releases/astrolabe-3.10.1.user.js', 'rlBattle, pvRng');
const NEW = load('astrolabe.user.js', 'rlDuel, pvRng');

const mk = (n, hp, dmg, prec, eva, sk, cl) => ({ N: n, hp, dmg, prec, eva, sk, cl });
const S1 = { dot: 0.10, focus: 0.05, stun: 0.05, block: 0.20 };
const S2 = { dot: 0, focus: 0, stun: 0, block: 0 };
const S3 = { dot: 0.4, focus: 0.3, stun: 0.3, block: 0.45 };
const C1 = [{ crit: 0.265, cm: 1.535, dual: 0.24 }];
const C2 = [{ crit: 0, cm: 1, dual: 0 }];
const C3 = [{ crit: .3, cm: 1.6, dual: .2 }, { crit: .1, cm: 1.2, dual: .5 }, { crit: 0, cm: 1, dual: 0 }];

const cases = [
  [mk(8,22386,3134,873,850,S1,C1),  mk(8,23000,3180,900,880,S1,C1),  'even match'],
  [mk(8,22386,3134,873,850,S1,C1),  mk(8,90000,9000,2500,2400,S1,C1),'hopeless'],
  [mk(8,90000,9000,2500,2400,S1,C1),mk(8,22386,3134,873,850,S1,C1),  'walkover'],
  [mk(1,50000,5000,1000,1000,S2,C2),mk(1,50000,5000,1000,1000,S2,C2),'single clone, no skills'],
  [mk(7,40000,4000,700,1400,S3,C3), mk(9,38000,4200,1500,650,S3,C3), 'heavy skills, mixed clones'],
  [mk(12,9000,1200,400,400,S3,C1),  mk(3,60000,7000,1800,300,S1,C3), 'lopsided clone counts'],
];
let bad = 0, checked = 0;
for (const [P, Q, label] of cases) {
  let mism = 0;
  for (let i = 0; i < 6000; i++) {
    const first = i % 2 === 0;
    const o = OLD.rlBattle([P], [Q], first, OLD.pvRng(31 + i * 7919));
    const n = NEW.rlDuel(P, Q, first, NEW.pvRng(31 + i * 7919));
    checked++;
    if (o.win !== n.win || o.rounds !== n.rounds ||
        Math.abs(o.fracA - n.fracA) > 1e-12 || Math.abs(o.fracB - n.fracB) > 1e-12) { mism++; bad++; }
  }
  console.log((mism ? 'FAIL ' : 'ok   ') + label.padEnd(28) + (mism ? mism + ' mismatches' : 'identical'));
}
console.log('\n' + checked + ' battles compared, ' + bad + ' mismatches');
process.exit(bad ? 1 : 0);
