const fs = require('fs');
function numOr(v){ return typeof v==='number'&&isFinite(v)?v:null; }
function fmt(x,dp){ if(x===null||x===undefined||isNaN(x))return '--'; var a=Math.abs(x);
  if(a>=1e9)return (x/1e9).toFixed(2)+'B'; if(a>=1e6)return (x/1e6).toFixed(2)+'M'; if(a>=1e3)return (x/1e3).toFixed(2)+'k';
  return Number(x).toFixed(dp===undefined?1:dp); }
// Read the base section out of the SHIPPING script. (This used to load a loose
// copy, q/base.js, which drifted: it kept passing after a function it tested
// had been deleted from the real script.)
const _src = fs.readFileSync(process.env.SCRIPT || 'astrolabe.user.js', 'utf8');
const _a = _src.indexOf('  var BB_HALF'), _b = _src.indexOf('  /* ============================================================\n     13. UI');
eval(_src.slice(_a, _b) + ';globalThis.B = { readBase, bbCandidates, bbBoost, bbAvgOut, bbTimer, bbLabRate, bbLabAfford, bbLabCost, bbTierCum, bbLevelCum, bbLabMult, BB_RATE };');
// What the game PRINTS on a module card is the guaranteed part only: the base
// rate times one plus the whole hundreds of boost. The script shows the
// average instead (see renderBaseMods), so this helper lives here, as the
// reference the script's numbers are checked against, not in the script.
B.bbShownOut = (m, eff) => (B.BB_RATE[m.name] || 0) * (1 + Math.floor(B.bbBoost(m, eff) / 100));

// the real account, as read from the live game on 2026-09-20
const mod = (name, level, tier, uses, sel) => ({ name, level, tier, active: true, unlocked: true, uses: uses||[], selection: [sel||''] });
const root = {
  UserStore: { player: { skills: { base_module_efficiency_boost: 100 } } },
  CurrencyStore: { credits: 10427091810 },
  MaterialsStore: { materialsList: [
    { item:{name:'microcircuits'}, quantity: 130 }, { item:{name:'fusion cells'}, quantity: 35260 },
    { item:{name:'ferricrystal'}, quantity: 8560 }, { item:{name:'cryovita'}, quantity: 5280 },
    { item:{name:'aerolite'}, quantity: 800 }, { item:{name:'luminaris'}, quantity: 800 } ] },
  BaseBuildingStore: { base: { name:'Frontline Nexus', stellarium: 14, stellariumHourly: 5, nextStellariumTick: 0, modules: [
    mod('Stellarium miner',200,0,['microcircuits','fusion cells']), mod('Material generator',50,0,['aerolite'],'flame'),
    mod('Metal scrap generator',72,0,['cryovita'],'metal scrap'), mod('Resource miner',192,0,['ferricrystal'],'silicon'),
    mod('Quantum server',0,0,['microcircuits'],'quantum_cores'), mod('Craftron 3000',50,0,['luminaris']),
    mod('Fuel facility',0,0,['fusion cells'],'fuel'), mod('Research lab',0,0,['warp capsule']),
    mod('Item booster',0,0,['fusion cells']), mod('Laboratory enhancer',387,0,['microcircuits']),
    Object.assign(mod('Battling Trainer (PvP)',0,0,['warp capsule']), { active:false, unlocked:false }) ] } },
  LaboratoryStore: {
    buildings: [['Foundry',0,'ingots'],['Refinery',0,'refined_crystals'],['Crystal Synthesis Lab',0,'high_end_crystals'],
      ['Noble Gas Processing Station',0,'propulsors'],['Nanotech Complex',0,'nanoconductors'],
      ['Circuit Integration Facility',250,'microcircuits'],['Energetic Fusion Center',168,'fusion cells'],
      ['Module Assembly Plant',0,'fuel cell casing'],['Fuel Lab',0,'unstable fuel'],['Space Capsule Complex',0,'warp capsule']]
      .map(([building,level,p])=>({ building, level, produce:[p], _id:building })),
    base: [['Aeroforge',0,'aerolite'],['Cryovault',0,'cryovita'],['Ferric Mill',107,'ferricrystal'],['Prism Nexus',0,'luminaris']]
      .map(([building,level,p])=>({ building, level, produce:[p], _id:building })),
    labQueue: [{building:'Circuit Integration Facility'},{building:'Energetic Fusion Center'},{building:'Ferric Mill'},{building:'Cryovault'}] } };

const M = B.readBase(root);
const ok = (label, got, want, tol) => { const good = Math.abs(got-want) <= (tol||0.01); console.log((good?'ok   ':'FAIL ') + label.padEnd(42) + String(Math.round(got*100)/100).padStart(12) + '   want ' + want); return good; };
let bad = 0;
console.log('-- against the numbers the game itself displays --');
bad += !ok('lab multiplier (queue shows 5/craft)', M.mult, 5);
const by = n => M.modules.filter(m=>m.name===n)[0];
bad += !ok('Stellarium miner boost (card 400%)', B.bbBoost(by('Stellarium miner'),100), 400);
bad += !ok('Material generator boost (100%)', B.bbBoost(by('Material generator'),100), 100);
bad += !ok('Metal scrap boost (144%)', B.bbBoost(by('Metal scrap generator'),100), 144);
bad += !ok('Resource miner boost (384%)', B.bbBoost(by('Resource miner'),100), 384);
bad += !ok('Lab enhancer boost (387%)', B.bbBoost(by('Laboratory enhancer'),100), 387);
bad += !ok('Material generator shown out (400/h)', B.bbShownOut(by('Material generator'),100), 400);
bad += !ok('Metal scrap shown out (3K/h)', B.bbShownOut(by('Metal scrap generator'),100), 3000);
bad += !ok('Resource miner shown out (80K/h)', B.bbShownOut(by('Resource miner'),100), 80000);
bad += !ok('Fuel facility shown out (5/h)', B.bbShownOut(by('Fuel facility'),100), 5);
bad += !ok('Quantum server shown out (4/h)', B.bbShownOut(by('Quantum server'),100), 4);
bad += !ok('Stellarium miner drop (5)', B.bbShownOut(by('Stellarium miner'),100), 5);
const lab = n => M.labs.filter(l=>l.name===n)[0];
console.log('-- against the live queue timers --');
bad += !ok('Circuit facility timer (5.0s)', lab('Circuit Integration Facility').timer, 5);
bad += !ok('Fusion Center timer (13.2s)', lab('Energetic Fusion Center').timer, 13.2);
bad += !ok('Ferric Mill timer (34.3s)', lab('Ferric Mill').timer, 34.3);
bad += !ok('Cryovault timer (45s)', lab('Cryovault').timer, 45);
bad += !ok('Circuit facility rate/h', lab('Circuit Integration Facility').rate, 3600, 1);
console.log('-- cost formulas --');
bad += !ok('tier 0->4 cumulative (user read 10)', B.bbTierCum(0,4), 10);
bad += !ok('tier 0->1 / 0->2 / 0->3', B.bbTierCum(0,1)*100+B.bbTierCum(0,2)*10+B.bbTierCum(0,3), 1*100+3*10+6);
bad += !ok('base level 200->201 (dialog needed 201)', B.bbLevelCum(201)-B.bbLevelCum(200), 201);
bad += !ok('lab 168->250 credits, in billions', B.bbLabCost(168,250)/1e9, 19.756, 0.01);
bad += !ok('lab affordable at 168 with 10.43B', B.bbLabAfford(168, 10427091810), 47);
console.log('\n-- ranked suggestions --');
B.bbCandidates(M).slice(0,8).forEach((c,i)=>console.log((i+1)+'. '+c.what.slice(0,26).padEnd(27)+c.how.padEnd(26)+
  (fmt(c.cost,0)+' '+c.unit).padEnd(18)+(c.afford?'OK   ':(c.shared?'purse':'short'))+'  +'+(c.pct*100).toFixed(0)+'%  '+c.note));
console.log(bad? '\n'+bad+' CHECK(S) FAILED' : '\nall checks passed');
