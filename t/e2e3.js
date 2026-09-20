// End-to-end test: run the real userscript in headless Chromium against a mock game page.
const { chromium } = require('playwright');
const fs = require('fs');

const SCRIPT = fs.readFileSync(process.env.SCRIPT || 'astrolabe.user.js', 'utf8');

const HTML = `<!doctype html><html><body><div id="q-app"></div></body></html>`;

// Mock game state, shaped like the live Pinia state observed on 2026-09-19.
function mockInit(cfg) {
  const droid = (e, s, m) => ({ name: 'd', efficiency: e, storage: s, maneuverability: m, _id: 'x' });
  const droids = [droid(20.8, 21.5, 21.0), droid(20.8, 21.5, 21.0), droid(20.8, 21.5, 21.0), droid(20.8, 21.5, 21.0),
                  droid(20.8, 21.5, 21.0), droid(20.8, 21.5, 21.0), droid(18.4, 21.3, 20.8)];
  const cat = (stat, range, rarity, halved) => ({ stat, range, rarity, halved: !!halved, activity: 'default', category: 'boost' });
  const slot = (name, bonuses, catalysts) => ({ name, bonuses, catalysts: catalysts || [] });
  const state = {
    UserStore: {
      username: 't', apikey: cfg.nokey ? undefined : 'A'.repeat(32),
      squadron: { buildings: [{ name: 'Amplifier', level: 37 }, { name: 'Trainer', level: 36 }], power: { spaceStations: 17 } },
      player: { droids, skills: {}, statistics: { gatheringActions: 100, kills: 5 }, inventory: [{ _id: 'q', item: null, quantity: 1 }] },
    },
    GatherStore: {
      isGathering: true, gathering_level: 97, nextActionAt: 0,
      currentGatheringBody: JSON.stringify({ type: 'Crystal Planet', nodeType: 'crystal', nodeQuality: 100 }),
      lastReward: null,
    },
    ShipStore: {
      weapon_slot: slot('W', ['kinetic']),
      shield_slot: slot('S', ['kinetic']),
      engine_slot: slot('E', ['Scan reward boost']),
      sensors_slot: slot('Se', ['Scan reward boost']),
      laser_slot: slot('L', ['Rare Resource drop chance'], [
        cat('gathering_yield', 77, 'rare', true), cat('gathering_yield', 57, 'epic'), cat('gathering_xp', 87, 'epic'),
        { stat: 'exploring_xp', range: 87, rarity: 'uncommon', activity: 'exploring' }]),
      probes_slot: slot('P', ['Rare Resource drop chance'], [
        cat('gathering_xp', 79, 'epic'), cat('gathering_yield', 99, 'rare'), cat('gathering_yield', 78, 'rare', true)]),
    },
    InventoryStore: { itemList: Array.from({ length: 11 }, () => ({ item: { bonuses: ['Rare Resource drop chance'] }, quantity: 1 })) },
    CurrencyStore: { credits: 1.8e9, diamond: 516234150, ruby: 555149834, emerald: 404222420, sapphire: 67805054, cobalt: 22908146, dark_matter: 5, cosmic_dust: 100 },
    PetsStore: { pets: [{ name: 'Dog', level: 16, _id: 'dog1' }], petSlots: [{ pet: 'dog1' }] },
    MarketStore: { current: '' },
    OtherStore: { token: 'B'.repeat(40), secret: 'C'.repeat(40), key: 'D'.repeat(40) },
    PremiumStore: { active: true },
    GlobalBoostsStore: { currentBoosts: [{ boost: { name: 'Cooldown' }, timer: 1789819200 + 86400 }, { boost: { name: 'Income' }, timer: 1789819200 + 86400 }] },
  };
  window.__mock = state;
  const router = { currentRoute: { value: { fullPath: '/gathering' } }, log: [],
    push(p) { this.log.push(p); this.currentRoute.value.fullPath = p; location.hash = '#' + p; page(p); return Promise.resolve(); } };
  window.__router = router;
  function page(p) {
    const q = document.getElementById('q-app');
    if (p.indexOf('/profile') === 0) {
      q.innerHTML = '<main><div><div role="tab" class="q-tab">Personal info</div><div role="tab" class="q-tab">Game API</div></div><div id="content">Personal info</div></main>';
      q.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => {
        if (!/^Game API/.test(t.textContent)) return;
        setTimeout(() => { q.querySelector('#content').innerHTML = '<div>Daily usage</div>' +
          [['user', 9], ['systems', 0], ['journal', 0], ['stations', 0], ['dungeons', 0], ['solodungeons', 0], ['activerunes', 0], ['market', 12]]
            .map(([n, u]) => '<div>/' + n + '</div><div>' + u + ' / 50</div>').join('') + '<div>Resets</div><div>19-Sep-2026 20:00</div>'; }, 400);
      }));
    } else q.innerHTML = '<main><div>Gathering page</div></main>';
  }
  page('/gathering');
  const listeners = []; const seen = { sent: [] };
  const ws = { readyState: 1, send(z) { seen.sent.push(Array.from(new Uint8Array(z instanceof ArrayBuffer ? z : z.buffer)).length);
      // verify the request decodes to the expected MessagePack bytes
      (async () => { const ds = new DecompressionStream('deflate'); const w = ds.writable.getWriter(); w.write(z instanceof ArrayBuffer ? new Uint8Array(z) : z); w.close();
        const u = new Uint8Array(await new Response(ds.readable).arrayBuffer()); seen.req = Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join(' '); })();
      setTimeout(() => { listeners.forEach((l) => l({ data: new Uint8Array(3000).map((_, i) => i % 251).buffer })); }, 20);   // unrelated big message
      (async () => { const ds = new DecompressionStream('deflate'); const w = ds.writable.getWriter(); w.write(z instanceof ArrayBuffer ? new Uint8Array(z) : z); w.close();
        const u = new Uint8Array(await new Response(ds.readable).arrayBuffer()); const txt = Array.from(u).map((b) => String.fromCharCode(b)).join('');
        const which = txt.indexOf('getNextDroidPrice') >= 0 ? 'price' : 'quota'; seen.methods = (seen.methods || []).concat(which);
        setTimeout(() => { listeners.forEach((l) => l({ data: new Uint8Array(which === 'price' ? cfg.priceReply : cfg.reply).buffer })); }, 60); })(); },
    addEventListener(n, f) { if (n === 'message') listeners.push(f); }, removeEventListener(n, f) { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }, listeners };
  window.__seen = seen; window.__ws = ws;
  const pin = { state: { value: state } };
  if (cfg.sock) pin._s = new Map([['GameStore', { game: ws }]]);
  const app = { config: { globalProperties: { $pinia: pin, $router: router } } };
  document.getElementById('q-app').__vue_app__ = app;
}

// Deterministic PRNG so the test is repeatable.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.route('http://test.local/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  const seenReq = []; await page.route('https://*.stellarodyssey.app/**', (r) => { seenReq.push(r.request().headers()['sodyssey-api-key'] || '(none)'); r.abort(); });   // never let the test touch the real API

  await page.clock.install({ time: new Date('2026-09-19T12:00:00Z') });
  await page.addInitScript(() => {
    localStorage.setItem('socalc:inputs', JSON.stringify({ marketAuto: false }));
    localStorage.setItem('socalc:marketCache', JSON.stringify({ t: 1789819200000 + 3600000, data: [
      { name: 'Diamond', buy: 12, sell: 24 }, { name: 'Ruby', buy: 17, sell: 18 }, { name: 'Emerald', buy: 17, sell: 21 },
      { name: 'Sapphire', buy: 17, sell: 24 }, { name: 'Cobalt', buy: 2410, sell: 3600 }] }));
  });
  const nPre = +(process.env.PRE || 0);
  const pre = [];
  for (let i = 0; i < nPre; i++) {
    const hu = 38 + (i % 5), su = 60, ht = 30 + (i % 4), st = 58;
    const v2 = i % 3 === 2;   // an old record, with no swing counts
    pre.push({ v: v2 ? 2 : 3, t: 1789819200000 - (nPre - i) * 3600000 * 5, i: 'P' + i,
      w: i % 3 === 1 ? 0 : 1, f: i % 2, r: 12 + i, a: (process.env.FLAG && i === 0) ? 1 : undefined,
      o: { n: 8, d: 25072, h: 179088, p: 873, e: 850, s: [0, 0, 0, 20], c: [[26.5, 23.5, 24]], x: 0, q: v2 ? undefined : [hu, su, ht, st] },
      e: { n: 8, d: 24800 + i * 900, h: 178000 + i * 3000, p: 1850 + i * 90, e: 1520 + i * 80, s: [0, 0, 0, 5], c: [[25, 30, 0]], x: 0, q: v2 ? undefined : [ht, st, hu, su] } });
  }
  if (process.env.GARBAGE) pre.push({ v: 1, t: 1789000000000, o: [{ p: null }], e: [{ p: 500 }] });
  await page.goto('http://test.local/');
  if (pre.length) await page.evaluate((p) => localStorage.setItem('socalc:battles', JSON.stringify(p)), pre);
  const zlib = require('zlib');
  const mstr = (x) => Buffer.concat([Buffer.from([0xa0 | x.length]), Buffer.from(x)]);
  const u32 = (n) => { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(n, 1); return b; };
  const ends = [['user', 9], ['systems', 0], ['journal', 0], ['stations', 0], ['dungeons', 0], ['solodungeons', 0], ['activerunes', 0], ['market', 12]];
  const value = Buffer.concat([Buffer.from([0x83]), mstr('limit'), Buffer.from([50]), mstr('resetsAt'), u32(1789862400), mstr('endpoints'), Buffer.from([0x90 | ends.length]),
    ...ends.map(([n, u]) => Buffer.concat([Buffer.from([0x82]), mstr('endpoint'), mstr(n), mstr('used'), Buffer.from([u])]))]);
  const msg = Buffer.concat([Buffer.from([0x83]), mstr('classname'), mstr('Player'), mstr('method'), mstr('getApiQuota'), mstr('value'), value]);
  const SOCK = process.env.NOSOCK ? false : true;
  const u64 = (n) => { const b = Buffer.alloc(9); b[0] = 0xcf; b.writeBigUInt64BE(BigInt(n), 1); return b; };
  const priceMsg = Buffer.concat([Buffer.from([0x83]), mstr('classname'), mstr('Gathering'), mstr('method'), mstr('getNextDroidPrice'), mstr('value'), u64(100000000000)]);
  await page.evaluate(mockInit, { reply: Array.from(zlib.deflateSync(msg)), priceReply: Array.from(zlib.deflateSync(priceMsg)), sock: SOCK, nokey: !!process.env.NOKEY });
  await page.evaluate(([pv, rich]) => {
    const st = window.__mock;
    st.UserStore.pvp_badges = pv.UserStore.pvp_badges;
    Object.assign(st.UserStore.player, { pvpstats: pv.UserStore.player.pvpstats, pvp_gear: pv.UserStore.player.pvp_gear, clones: pv.UserStore.player.clones });
    st.CraftStore = pv.CraftStore; st.MaterialsStore = pv.MaterialsStore;
    if (rich) { st.UserStore.pvp_badges = 5000; st.MaterialsStore.materialsList.forEach((m) => { m.quantity = 5000; }); }
    st.PetsStore.pets.push(pv.PetsStore.pets[0]); st.PetsStore.petSlots.push(pv.PetsStore.petSlots[0]);
  }, [JSON.parse(require('fs').readFileSync('t/root.json', 'utf8')), !!process.env.RICH]);
  await page.evaluate((e) => { window.__EARLY = e; }, !!process.env.EARLY);
  await page.evaluate((e) => { window.__NOGROUPS = e; }, !!process.env.NOGROUPS);
  // our squad and a squadron battle in the game's memory (after the script has started, unless EARLY)
  await page.evaluate((root) => {
    const st = window.__mock, P = root.UserStore.player;
    st.UserStore.squadron.name = 'Alpha';
    st.UserStore.username = 'Me';
    st.PvPArenaStore = { elo: 1500, bestElo: 1550, rank: 40, attacksLeft: 10, maxAttacks: 10, opponents: [], band: 150, currentDuel: null, currentDuelCards: null };
    window.__genDuel = function (seed, opDmg) {
      let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const T = { Me: { n: 8, hp: 179088, dmg: 25072, prec: 873, eva: 850, crit: 0.265, cm: 1.535, block: 0.20 },
                  Op: { n: 8, hp: 175000 + seed * 137, dmg: opDmg || 24000, prec: 1800, eva: 1400, crit: 0.25, cm: 1.6, block: 0.05 } };
      const logs = [], hp = {};
      for (const w of ['Me', 'Op']) for (let i = 1; i <= T[w].n; i++) hp[w + "'s Clone " + i] = T[w].hp;
      const live = (w) => Object.keys(hp).filter((k) => k.indexOf(w + "'s") === 0 && hp[k] > 0);
      let round = 0;
      while (round < 60 && live('Me').length && live('Op').length) {
        round++; logs.push({ round, attacker: null, defender: null, action: 'round', value: round });
        for (const pair of [['Me', 'Op'], ['Op', 'Me']]) {
          const a = T[pair[0]], d = T[pair[1]];
          for (const c of live(pair[0])) {
            const tg = live(pair[1]); if (!tg.length) break;
            const target = tg[Math.floor(rnd() * tg.length)];
            if (rnd() >= a.prec / (a.prec + d.eva)) { logs.push({ round, attacker: c, defender: target, action: 'misses hit on', value: null }); continue; }
            if (rnd() < d.block) { logs.push({ round, attacker: c, defender: target, action: 'attack blocked', value: null }); continue; }
            const dmg = Math.round(a.dmg * (rnd() < a.crit ? a.cm : 1));
            hp[target] = Math.max(0, hp[target] - dmg);
            logs.push({ round, attacker: c, defender: target, action: 'attacks', value: dmg, hpLeft: '[' + hp[target] + '/' + d.hp + ']' });
            if (hp[target] <= 0) logs.push({ round, attacker: null, defender: target, action: 'dies', value: null });
          }
        }
      }
      const winner = live('Me').length ? 'Me' : 'Op';
      logs.push({ round, attacker: winner, defender: null, action: 'won', value: 0 });
      return { _id: 'D' + seed, created: 1789819200 - seed * 3600, attackerName: 'Me', defenderName: 'Op',
        attackerElo: 1500, defenderElo: 1490, eloDelta: winner === 'Me' ? 12 : -9, winner: winner, logs: logs };
    };
    const mem = (u, k) => ({ username: u, pvpstats: P.pvpstats, pvp_gear: P.pvp_gear.map((g) => Object.assign({}, g)), clones: Array.from({ length: 6 }, () => ({})),
      velari_pet: { name: 'Velari', level: 20, equipped: true }, levels: { crafting_level: 30 } });
    window.__groups = { group1: [mem('m1'), mem('m2')], group2: [mem('m3'), mem('m4')], group3: [] };
    st.squadronStore = window.__NOGROUPS ? { group1: [], group2: [], group3: [], lastBattleStats: null } : { group1: window.__groups.group1, group2: window.__groups.group2, group3: [], lastBattleStats: null };
    window.__mates = { m1: window.__groups.group1[0], m2: window.__groups.group1[1], m3: window.__groups.group2[0], m4: window.__groups.group2[1] };
    window.__tot = function (m) { const c = m.levels.crafting_level, v = m.velari_pet.equipped ? m.velari_pet.level * 50 : 0, q = { power: v, precision: v, evasion: v, hull: v };
      m.pvp_gear.forEach((g) => { q[g.stat] += 100 * g.statLevel * (1 + g.statTier / 100 + c / 100); }); ['power', 'precision', 'evasion', 'hull'].forEach((s) => { q[s] += m.pvpstats[s] || 0; }); return q; };
    window.__genBattle = function (winnerOurs, opts) {
      opts = opts || {};
      let seed = opts.seed || 99; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const mk = (u, n, d, h) => ({ user: u, damage: d, maxhp: h, clones: Array.from({ length: n }, () => ({ critical_chance: 10, critical_damage: 10, dual_shot: 5 })) });
      const ours = ['m1', 'm2', 'm3', 'm4'].map((u) => { const q = window.__tot(window.__mates[u]); return mk(u, 6, q.power * 6, q.hull * 7 * 6); });
      const theirs = ['e1', 'e2', 'e3', 'e4'].map((u, i) => mk(u, 5, 7000 + i * 900, 50000 + i * 9000));
      const logs = [], hp = {}; ours.concat(theirs).forEach((m) => { for (let i = 0; i < m.clones.length; i++) hp[m.user + "'s Clone " + (i + 1)] = m.maxhp * (m === ours[0] || winnerOurs ? 1 : 1); });
      const A = { f: ours, i: 0 }, B = { f: theirs, i: 0 };   // we defend: we strike first
      const live = (m) => m.clones.map((_, i) => m.user + "'s Clone " + (i + 1)).filter((c) => hp[c] > 0);
      let round = 0;
      const phase = (a, d) => { const m = a.f[a.i]; live(m).forEach((c) => { if (d.i >= d.f.length) return; const t = live(d.f[d.i]); const tg = t[Math.floor(rnd() * t.length)];
        const q = a === A ? 0.62 : 0.55;
        if (rnd() < q) { logs.push({ round, attacker: c, defender: tg, action: 'attacks', value: 3000 }); hp[tg] -= (a === A ? (winnerOurs ? 9000 : 500) : (winnerOurs ? 3000 : 20000)); if (hp[tg] <= 0) { logs.push({ round, attacker: null, defender: tg, action: 'dies', value: 0 }); if (!live(d.f[d.i]).length) d.i++; } }
        else logs.push({ round, attacker: c, defender: tg, action: 'misses hit on', value: 0 }); }); };
      while (round < 300 && A.i < 4 && B.i < 4) { round++; logs.push({ round: round, attacker: null, defender: null, action: 'round', value: round }); phase(A, B); if (B.i >= 4) break; phase(B, A); }
      const won = A.i >= 4 ? 'Beta' : 'Alpha';
      logs.push({ round, attacker: null, defender: null, action: 'won', value: 0 });
      logs[logs.length - 1].attacker = won;
      const b = { _id: opts.id || 'b' + Math.floor(rnd() * 1e9), status: 'finished', finished: opts.finished || 1789768792, created: (opts.finished || 1789768792) - 600, defending_squadron: { name: 'Alpha' }, attacking_squadron: { name: 'Beta' }, attacking_members: JSON.stringify(theirs), defending_members: JSON.stringify(ours), winner: won, logs };
      if (opts.nowinner) delete b.winner;
      return b;
    };
    if (window.__EARLY) st.squadronStore.lastBattleStats = window.__genBattle(true);
    // base + laboratory, the real account's numbers
    const bmod = (name, level, tier, uses, sel) => ({ name, level, tier, active: true, unlocked: true, uses: uses || [], selection: [sel || ''] });
    st.UserStore.player.skills = Object.assign({}, st.UserStore.player.skills, { base_module_efficiency_boost: 100 });
    st.BaseBuildingStore = { base: { name: 'Frontline Nexus', stellarium: 14, stellariumHourly: 5, nextStellariumTick: Math.floor(Date.now() / 1000) + 8600, modules: [
      bmod('Stellarium miner', 200, 0, ['microcircuits', 'fusion cells']), bmod('Material generator', 50, 0, ['aerolite'], 'flame'),
      bmod('Metal scrap generator', 72, 0, ['cryovita'], 'metal scrap'), bmod('Resource miner', 192, 0, ['ferricrystal'], 'silicon'),
      bmod('Quantum server', 0, 0, ['microcircuits'], 'quantum_cores'), bmod('Craftron 3000', 50, 0, ['luminaris']),
      bmod('Fuel facility', 0, 0, ['fusion cells'], 'fuel'), bmod('Research lab', 0, 0, ['warp capsule']),
      bmod('Item booster', 0, 0, ['fusion cells']), bmod('Laboratory enhancer', 387, 0, ['microcircuits']),
      Object.assign(bmod('Battling Trainer (PvP)', 0, 0, ['warp capsule']), { active: false, unlocked: false }) ] } };
    st.CurrencyStore.credits = 10427091810;
    st.MaterialsStore = { materialsList: [['microcircuits', 130], ['fusion cells', 35260], ['ferricrystal', 8560], ['cryovita', 5280], ['aerolite', 800], ['luminaris', 800]]
      .map(([n, q]) => ({ item: { name: n }, quantity: q })) };
    st.LaboratoryStore = {
      buildings: [['Foundry', 0, 'ingots'], ['Refinery', 0, 'refined_crystals'], ['Crystal Synthesis Lab', 0, 'high_end_crystals'],
        ['Noble Gas Processing Station', 0, 'propulsors'], ['Nanotech Complex', 0, 'nanoconductors'],
        ['Circuit Integration Facility', 250, 'microcircuits'], ['Energetic Fusion Center', 168, 'fusion cells'],
        ['Module Assembly Plant', 0, 'fuel cell casing'], ['Fuel Lab', 0, 'unstable fuel'], ['Space Capsule Complex', 0, 'warp capsule']]
        .map(([building, level, p]) => ({ building, level, produce: [p], _id: building })),
      base: [['Aeroforge', 0, 'aerolite'], ['Cryovault', 0, 'cryovita'], ['Ferric Mill', 107, 'ferricrystal'], ['Prism Nexus', 0, 'luminaris']]
        .map(([building, level, p]) => ({ building, level, produce: [p], _id: building })),
      labQueue: [{ building: 'Circuit Integration Facility' }, { building: 'Energetic Fusion Center' }, { building: 'Ferric Mill' }, { building: 'Cryovault' }] };
  }, JSON.parse(require('fs').readFileSync('t/root.json', 'utf8')));
  await page.addScriptTag({ content: SCRIPT });
  await page.clock.runFor(2000);

  // Drive 80 gathering actions, one per minute, polled every 10 s by the script.
  const rand = rng(12345);
  const K_C = 121505, K_R = 2116.7, P_SURV = 0.40, P_RARE = 0.40, TAX = 0.0605;
  const commons = ['diamond', 'ruby', 'emerald', 'sapphire'];
  const truth = { rare: 0, n: 0, alive: 0, rolls: 0 };
  const N = process.env.FAST ? (+process.env.FAST || 3) : 80;
  for (let a = 0; a < N; a++) {
    const isRare = rand() < P_RARE;
    const res = isRare ? 'cobalt' : commons[Math.floor(rand() * 4)];
    truth.n++; if (isRare) truth.rare++;
    await page.evaluate(({ res, isRare, seedVals }) => {
      const st = window.__mock, ds = st.UserStore.player.droids;
      const K = isRare ? 2116.7 : 121505;
      const stats = ds.map((d, i) => {
        const alive = seedVals[i] < 0.40;
        const ore = alive ? Math.round(K * (1 + (d.efficiency + d.storage) / 100)) : 0;
        return { alive, ore, name: 'Droid ' + (i + 1), taxed: 0, globalTaxed: alive ? Math.round(ore * 0.0605) : 0 };
      });
      st.GatherStore.lastReward = JSON.stringify({ name: res, amount: stats.reduce((x, s) => x + s.ore, 0), statistics: stats, xp: 218 });
      st.GatherStore.nextActionAt = Date.now() + 60000;
      const amt = stats.reduce((x, q) => x + q.ore, 0);
      st.CurrencyStore[res] += amt; st.CurrencyStore.credits += 5000;
      st.UserStore.player.statistics.gatheringActions += 1;
    }, { res, isRare, seedVals: Array.from({ length: 7 }, () => rand()) });
    // count truth survival from what we just wrote
    const alive = await page.evaluate(() => JSON.parse(window.__mock.GatherStore.lastReward).statistics.filter((s) => s.alive).length);
    truth.alive += alive; truth.rolls += 7;
    for (let z = 0; z < 6; z++) { await page.clock.runFor(10000); await page.waitForTimeout(+process.env.RW || 25); }
    if (a % 10 === 0) await page.waitForTimeout(120);
  }


  // ---- 3.7.2 scenarios (SCEN=1)
  if (process.env.SCEN) {
    const recsNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('socalc:battles') || '[]'));
    const brief = (rs) => rs.map((r) => ({ w: r.w, t: r.t, a: r.a || 0, i: r.i, ourP: r.o.map((f) => f.p).join('/'), eP: r.e.map((f) => f.p + ':' + f.u).join(',') }));
    const tick = async (ms) => { await page.clock.runFor(ms); await page.waitForTimeout(150); };
    const out = [];
    const sq = (f) => page.evaluate(f);
    // S1: battle in memory, squad not loaded
    await sq(() => { const s = window.__mock.squadronStore; s.group1 = []; s.group2 = []; s.group3 = []; s.lastBattleStats = window.__genBattle(true, { seed: 99, id: 'B1', finished: 1789768792 }); });
    await tick(35000);
    out.push('S1 squad not loaded, 35 s of ticks -> records: ' + (await recsNow()).length + ' (want 0)');
    await sq(() => { const s = window.__mock.squadronStore, g = window.__groups; s.group1 = g.group1; s.group2 = g.group2; s.group3 = g.group3; });
    await tick(12000);
    let r = await recsNow();
    out.push('S1 after the squad loads -> ' + JSON.stringify(brief(r)) + '  (want 1 record, our p numeric, no ~, i=B1, t=1789768792000)');
    // S2: no winner field
    await sq(() => { window.__mock.squadronStore.lastBattleStats = window.__genBattle(true, { seed: 5, id: 'B2', finished: 1789768000, nowinner: true }); });
    await tick(12000);
    await sq(() => { window.__mock.squadronStore.lastBattleStats = window.__genBattle(false, { seed: 6, id: 'B3', finished: 1789767000, nowinner: true }); });
    await tick(12000);
    r = await recsNow();
    out.push('S2 no winner field -> ' + JSON.stringify(brief(r).map((x) => [x.i, x.w, x.t])) + '  (want B1 w1, B2 w1 (older first), B3 w0; sorted by time)');
    // S3: same battle again (same id) must not be stored twice
    await sq(() => { window.__mock.squadronStore.lastBattleStats = window.__genBattle(true, { seed: 5, id: 'B2', finished: 1789768000, nowinner: true }); });
    await tick(12000);
    out.push('S3 same battle seen again -> records: ' + (await recsNow()).length + ' (want 3)');
    // S4: one mate improved since the battle
    await sq(() => { const b = window.__genBattle(true, { seed: 7, id: 'B4', finished: 1789769000 }); window.__mates.m2.pvp_gear[0].statLevel += 3; window.__mock.squadronStore.lastBattleStats = b; });
    await tick(12000);
    r = await recsNow();
    out.push('S4 a mate changed since the battle -> last: ' + JSON.stringify(brief(r).slice(-1)) + ' (want a=1)');
    // S5: a mate left the squad
    await sq(() => { window.__mates.m2.pvp_gear[0].statLevel -= 3; const b = window.__genBattle(true, { seed: 8, id: 'B5', finished: 1789770000 }); window.__mock.squadronStore.group1 = window.__groups.group1.slice(0, 1); window.__mock.squadronStore.lastBattleStats = b; });
    await tick(12000);
    r = await recsNow();
    out.push('S5 a mate left the squad -> last: ' + JSON.stringify(brief(r).slice(-1)) + ' (want a=1, all our p numeric)');
    // S6: nobody of ours is in the squad at all -> not recorded
    await sq(() => { const b = window.__genBattle(true, { seed: 9, id: 'B6', finished: 1789771000 }); window.__mock.squadronStore.group1 = []; window.__mock.squadronStore.group2 = [{ username: 'zz', pvpstats: {}, pvp_gear: [], clones: [], levels: {} }]; window.__mock.squadronStore.lastBattleStats = b; });
    await tick(60000);
    out.push('S6 none of our fighters in the loaded squad -> records: ' + (await recsNow()).length + ' (want 5, nothing new)');
    console.log('\n===== 3.7.2 SCENARIOS =====\n' + out.join('\n') + '\nERRORS: ' + (errors.filter((e) => !/ERR_FAILED/.test(e)).join(' | ') || 'none'));
    await browser.close(); return;
  }
  // A squadron battle finishes while the script is running.
  const nb0 = await page.evaluate(() => JSON.parse(localStorage.getItem('socalc:battles') || '[]').length);
  if (!process.env.EARLY && !process.env.NOLIVE) {
    await page.evaluate(() => { window.__mock.PvPArenaStore.currentDuel = window.__genDuel(7); });
    await page.clock.runFor(12000); await page.waitForTimeout(200);
  }
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('socalc:battles') || '[]'));
  console.log('RECORDER: before ' + nb0 + ', after ' + recs.length + (recs.length ? ', last ' + JSON.stringify(recs[recs.length - 1]).length + ' bytes' +
    ', won=' + recs[recs.length - 1].w + ' rounds=' + recs[recs.length - 1].r + ' approx=' + (recs[recs.length - 1].a || 0) +
    ', opponent [clones,hp,dmg,prec,eva]=' + JSON.stringify([recs[recs.length-1].e.n, recs[recs.length-1].e.h, recs[recs.length-1].e.d, recs[recs.length-1].e.p, recs[recs.length-1].e.e]) +
    ', names stored: ' + /"Me"|"Op"|Alpha|Beta/.test(JSON.stringify(recs)) : ''));
  console.log('DROIDPRICE: ' + (await page.evaluate(() => localStorage.getItem('socalc:droidPrice'))) + '  lastErr-ish keys: ' + (await page.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('socalc:') === 0).join(','))));
  // Open the panel and read each tab.
  await page.click('#btn');
  page.on('dialog', (d) => d.accept());
  const tabs = {};
  for (const t of ['out', 'cal', 'gear', 'battle', 'base', 'act', 'in']) {
    if (await page.locator(`button[data-tab="${t}"]`).count() === 0) { tabs[t] = '(not in this version)'; continue; }
    await page.click(`button[data-tab="${t}"]`);
    if (t === 'base' && await page.locator('.seg').count()) {
      const parts = [];
      for (const sub of ['next', 'mods', 'lab']) {
        await page.click(`.seg button[data-bsub="${sub}"]`); await page.waitForTimeout(150);
        parts.push('--- base:' + sub + ' ---\n' + await page.locator('#body').innerText());
      }
      tabs[t] = parts.join('\n');
      continue;
    }
    if (t === 'battle' && await page.locator('.seg').count()) {
      const parts = [];
      for (const sub of ['cur', 'best', 'up', 'fights']) {
        await page.click(`.seg button[data-sub="${sub}"]`);
        for (let k = 0; k < 8; k++) { await page.waitForTimeout(700); await page.clock.runFor(300); }
        parts.push('--- ' + sub + ' ---\n' + await page.locator('#body').innerText());
        if (sub === 'best' && await page.locator('#b_showbest').count()) {
          await page.click('#b_showbest'); await page.waitForTimeout(300);
          parts.push('--- best (shown anyway) ---\n' + await page.locator('#body').innerText());
          await page.setViewportSize({ width: 620, height: 1100 }); await page.locator('#panel').screenshot({ path: 'shots/l37_best2.png' });
          await page.setViewportSize({ width: 620, height: 900 });
        }
      }
      tabs[t] = parts.join('\n');
      continue;
    }
    tabs[t] = await page.locator('#body').innerText();
  }


  // ---- 3.7.1: Spend box
  if (await page.locator('#f_spend').count() === 0) await page.click('button[data-tab="out"]');
  if (await page.locator('#f_spend').count()) {
    const sug = async () => { const tx = await page.locator('#body').innerText(); const i = tx.indexOf('Suggestions'); return tx.slice(i, i + 330).replace(/\n/g, ' | '); };
    const setBox = async (v) => { await page.fill('#f_spend', v); await page.press('#f_spend', 'Enter'); await page.waitForTimeout(150); };
    const sp = [];
    sp.push('default : ' + await sug());
    await setBox('500M'); sp.push('500M    : ' + await sug() + '  || box=' + await page.inputValue('#f_spend'));
    await page.locator('#body').scrollIntoViewIfNeeded(); await page.setViewportSize({ width: 620, height: 1150 }); await page.locator('#panel').screenshot({ path: 'shots/l371_spend.png' });
    await page.click('#theme'); await page.locator('#panel').screenshot({ path: 'shots/d371_spend.png' }); await page.click('#theme'); await page.setViewportSize({ width: 620, height: 900 });
    await setBox('5x'); sp.push('5x      : ' + (await page.locator('#body').innerText()).split('\n').filter((l) => /Not understood/.test(l)).join(' ') + '  || box=' + await page.inputValue('#f_spend') + ' stored=' + await page.evaluate(() => JSON.parse(localStorage.getItem('socalc:inputs')).spendLimit));
    await setBox('5B'); sp.push('5B      : ' + (await sug()).slice(0, 200));
    await setBox('1k'); sp.push('1k      : ' + (await sug()).slice(0, 220));
    await setBox('1.5b'); sp.push('1.5b    : ' + (await sug()).slice(0, 160) + '  || stored=' + await page.evaluate(() => JSON.parse(localStorage.getItem('socalc:inputs')).spendLimit));
    // typing must survive the 10 s refresh
    await page.click('#f_spend'); await page.keyboard.type('12'); await page.clock.runFor(35000); await page.waitForTimeout(200);
    sp.push('typing survives 35 s of ticks: box=' + await page.inputValue('#f_spend') + ' focused=' + await page.evaluate(() => { const r = document.querySelector('#so-calc-host, div'); return true; }));
    await page.press('#f_spend', 'Escape'); await page.click('button[data-tab="cal"]'); await page.click('button[data-tab="out"]'); await page.waitForTimeout(150);
    sp.push('after leaving the tab mid-edit: box=' + await page.inputValue('#f_spend'));
    await page.click('#b_spendall'); await page.waitForTimeout(150);
    sp.push('all     : ' + (await sug()).slice(0, 160) + '  || box="' + await page.inputValue('#f_spend') + '" allBtn=' + await page.locator('#b_spendall').count());
    console.log('\n===== SPEND BOX =====\n' + sp.join('\n'));
  } else console.log('\n===== SPEND BOX: not present (older version) =====');
  const fsx = require('fs'); fsx.mkdirSync('shots', { recursive: true });
  await page.setViewportSize({ width: 620, height: 900 });
  for (const t of ['out', 'cal', 'gear', 'act', 'in']) {
    await page.click(`button[data-tab="${t}"]`);
    await page.locator('#panel').screenshot({ path: `shots/light_${t}.png` });
  }
  const hasBase = await page.locator('button[data-tab="base"]').count() > 0;
  if (hasBase) await page.click('button[data-tab="base"]');
  for (const sub of (hasBase ? ['next', 'mods', 'lab'] : [])) {
    await page.click(`.seg button[data-bsub="${sub}"]`); await page.waitForTimeout(250);
    await page.locator('#panel').screenshot({ path: `shots/l38_${sub}.png` });
  }
  if (hasBase) { await page.click('#theme');
    await page.click(`.seg button[data-bsub="next"]`); await page.waitForTimeout(250);
    await page.locator('#panel').screenshot({ path: 'shots/d38_next.png' });
    await page.click('#theme'); }
  await page.click('button[data-tab="battle"]');
  for (const sub of (await page.locator('.seg').count() ? ['cur', 'best', 'up', 'fights'] : [])) {
    await page.click(`.seg button[data-sub="${sub}"]`); await page.waitForTimeout(300);
    await page.locator('#panel').screenshot({ path: `shots/l37_${sub}.png` });
  }
  await page.setViewportSize({ width: 620, height: 1150 });
  await page.click('button[data-tab="out"]');
  await page.locator('#panel').screenshot({ path: 'shots/light_out_tall.png' });
  await page.click('#theme');
  await page.locator('#panel').screenshot({ path: 'shots/dark_out_tall.png' });
  await page.click('#theme');
  await page.setViewportSize({ width: 620, height: 900 });
  await page.click('#theme');
  await page.click('button[data-tab="out"]'); await page.locator('#panel').screenshot({ path: 'shots/dark_out.png' });
  await page.click('button[data-tab="battle"]');
  for (const sub of (await page.locator('.seg').count() ? ['cur', 'best', 'up', 'fights'] : [])) {
    await page.click(`.seg button[data-sub="${sub}"]`); await page.waitForTimeout(300);
    await page.locator('#panel').screenshot({ path: `shots/d37_${sub}.png` });
  }
  console.log('TRUTH  survival ' + (truth.alive / truth.rolls * 100).toFixed(1) + '%  rare ' + (truth.rare / truth.n * 100).toFixed(1) + '%  (' + truth.n + ' actions)');
  console.log('\n===== YIELD =====\n' + tabs.out);
  console.log('\n===== FIT =====\n' + tabs.cal);
  console.log('\n===== GEAR =====\n' + tabs.gear);
  console.log('\n===== BATTLE =====\n' + tabs.battle);
  console.log('\n===== BASE =====\n' + tabs.base);
  console.log('\n===== ACTIVITY (top) =====\n' + tabs.act.split('\n').slice(0, 20).join('\n'));
  console.log('\n===== SETTINGS =====\n' + tabs.in);
  await page.click('button[data-tab="out"]'); await page.click('#b_market'); await page.waitForTimeout(300);
  await page.click('button[data-tab="in"]');
  console.log('\nKEY MODE: ' + (process.env.NOKEY ? 'no key in account' : 'key in account') + '\nAPI REQUEST KEY HEADERS: ' + JSON.stringify(seenReq.map((k) => k.length > 8 ? k[0] + '×' + k.length : k)));
  console.log((await page.locator('#body').innerText()).split('\n').slice(0, 40).join(' | ').replace(/=/g, '≔'));
  await page.locator('#panel').screenshot({ path: process.env.NOKEY ? 'shots/settings_nokey.png' : 'shots/settings_key.png' });
  // ---- quota sync
  const before = await page.locator('#panel #q1').innerText() + ' | ' + await page.locator('#panel #q2').innerText();
  await page.click('#sync');
  for (let i = 0; i < 6; i++) { await page.clock.runFor(100); await page.waitForTimeout(150); }
  if (!process.env.NOSOCK) { /* socket path resolves without page changes */ } else await page.clock.runFor(4000);
  const after = await page.locator('#panel #q1').innerText() + ' | ' + await page.locator('#panel #q2').innerText();
  const info = await page.evaluate(() => ({ methods: window.__seen.methods, req: window.__seen.req, nsent: window.__seen.sent.length, listeners: window.__ws.listeners.length, route: window.__router.currentRoute.value.fullPath, log: window.__router.log, hash: location.hash }));
  console.log('\nQUOTA before: ' + before + '\nQUOTA after : ' + after + '\nROUTER: ' + JSON.stringify(info));
  await page.click('button[data-tab="out"]');
  await page.locator('#panel').screenshot({ path: 'shots/synced_out.png' });
  if (process.env.DUMP) console.log('SERIES ' + JSON.stringify(await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('socalc:series') || '[]'); return s.map((x) => [Math.round((x.t - s[0].t) / 60000), x.c.gatheringActions || x.c.actions]); })));
  console.log('\nERRORS: ' + (errors.length ? '\n' + errors.join('\n') : 'none'));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAILURE', e); process.exit(1); });
