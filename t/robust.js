// Feeds the script broken/hostile game states and checks it does not throw.
const { chromium } = require('playwright');
const fs = require('fs');
const SCRIPT = fs.readFileSync(process.env.SCRIPT || 'astrolabe.user.js', 'utf8');
const HTML = `<!doctype html><html><body><div id="q-app"></div></body></html>`;
const CASES = {
  empty: () => ({}),
  nulls: () => ({ UserStore: null, GatherStore: null, ShipStore: null, CurrencyStore: null, squadronStore: null }),
  wrongTypes: () => ({ UserStore: { player: { droids: 'nope', pvpstats: 5, pvp_gear: {} }, squadron: 7, apikey: 12 },
    GatherStore: { lastReward: '{{{', currentGatheringBody: 'null', nextActionAt: 'soon' },
    CurrencyStore: { credits: 'lots' }, MaterialsStore: { materialsList: [null, { item: 5 }] }, CraftStore: { crafting_level: {} },
    PetsStore: { pets: [null], petSlots: 'x' }, squadronStore: { group1: 'x', lastBattleStats: { logs: [{}], attacking_members: '[]', defending_members: 'nope' } } }),
  cyclic: () => { const a = { name: 'a' }; a.self = a; a.list = [a, a]; return { Weird: a, UserStore: { player: { droids: [{ efficiency: 1, storage: 1, maneuverability: 1 }] } } }; },
  throwers: () => { const o = {}; Object.defineProperty(o, 'boom', { get() { throw new Error('boom'); }, enumerable: true });
    return { Evil: o, UserStore: { player: { droids: [{ efficiency: 1, storage: 1, maneuverability: 1 }], statistics: o } } }; },
  brokenBase: () => ({ UserStore: { player: { skills: { base_module_efficiency_boost: 'lots' }, droids: [] } }, CurrencyStore: { credits: null },
    BaseBuildingStore: { base: { stellarium: 'x', modules: [{ name: 'Resource miner' }, null, { name: 'Laboratory enhancer', level: -5, tier: 'q' }] } },
    LaboratoryStore: { buildings: [{ building: 'Foundry' }, null], base: 'nope', labQueue: null }, MaterialsStore: { materialsList: 'no' } }),
  brokenArena: () => ({ UserStore: { username: 5, player: { skills: {}, droids: [], pvpstats: { power: 1, available: 0 }, pvp_gear: [{ name: 'helmet', stat: 'hull', skill: 'block', statLevel: 1, statTier: 1 }], clones: [] } },
    CurrencyStore: { credits: 1 },
    PvPArenaStore: { currentDuel: { _id: 7, created: 'soon', attackerName: null, defenderName: 'x', winner: null,
      logs: [{ action: 'round', value: 'one' }, { attacker: "A's Clone 1", defender: "B's Clone q", action: 'attacks', value: 'lots', hpLeft: 'broken' },
             { attacker: null, defender: null, action: 'won' }] } } }),
  partialBattle: () => ({ UserStore: { squadron: { name: 'A' }, player: { droids: [], pvpstats: { power: 1, available: 0 }, pvp_gear: [{ name: 'helmet', stat: 'hull', skill: 'block', statLevel: 1, statTier: 1 }], clones: [] } },
    squadronStore: { group1: [{ username: 'u', pvpstats: null, pvp_gear: null, clones: null }], group2: [], group3: [],
      lastBattleStats: { logs: [{ action: 'won', attacker: 'A' }], attacking_members: '[{"user":"u","damage":1,"maxhp":1,"clones":[]}]', defending_members: '[{"user":"v","damage":1,"maxhp":1,"clones":[]}]', attacking_squadron: { name: 'A' }, defending_squadron: { name: 'B' } } } }),
};
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ['--no-sandbox', '--disable-background-networking', '--no-first-run'] });
  let bad = 0;
  for (const name of (process.env.CASE ? [process.env.CASE] : Object.keys(CASES))) {
    const page = await (await browser.newContext()).newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80) + ' @@ ' + String(e.stack || '').split('\n').slice(1, 4).map((x) => x.trim()).join(' <- ')));
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to load/.test(m.text())) errs.push('console: ' + m.text().slice(0, 120)); });
    await page.route('http://test.local/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
    await page.route('https://*.stellarodyssey.app/**', (r) => r.abort());
    await page.clock.install({ time: new Date('2026-09-19T12:00:00Z') });
    const P = (m) => { if (process.env.V) console.log('   .. ' + m); };
    P('goto'); await page.goto('http://test.local/');
    await page.evaluate((n) => {
      const CASES = { __src: null };
      window.__name = n;
    }, name);
    await page.evaluate(new Function('name', 'const CASES = {' + Object.keys(CASES).map(k => k + ':' + CASES[k].toString()).join(',') + '}; const st = CASES[name](); window.__mock = st; document.getElementById("q-app").__vue_app__ = { config: { globalProperties: { $pinia: { state: { value: st } }, $router: { currentRoute: { value: { fullPath: "/x" } }, push(){ return Promise.resolve(); } } } } };'), name);
    P('inject'); await page.addScriptTag({ content: SCRIPT });
    P('boot'); await page.clock.runFor(1500);
    // open the panel and visit every tab and sub-tab
    P('open'); await page.click('#btn', { timeout: 5000 }).catch((e) => errs.push('btn: ' + e.message.slice(0, 50)));
    for (const t of ['out', 'cal', 'gear', 'battle', 'base', 'act', 'in']) {
      await page.click(`button[data-tab="${t}"]`, { timeout: 5000 }).catch((e) => errs.push('click ' + t + ': ' + e.message.slice(0, 60))); P('tab ' + t);
      if (t === 'battle') for (const s of ['cur', 'best', 'up', 'fights']) await page.click(`.seg button[data-sub="${s}"]`, { timeout: 4000 }).catch(() => {});
      if (t === 'base') for (const s of ['next', 'mods', 'lab']) await page.click(`.seg button[data-bsub="${s}"]`, { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(60);
    }
    P('ticks'); await page.clock.runFor(60000); await page.waitForTimeout(200); P('done ticks: errors so far ' + errs.length);
    const alive = await page.evaluate(() => !!document.querySelector('div')).catch(() => false);
    const tabOk = await page.evaluate(() => { try { const h = document.querySelector('div'); return true; } catch (e) { return false; } });
    console.log((errs.length ? 'FAIL ' : 'ok   ') + name.padEnd(14) + (errs.length ? errs.slice(0, 3).join(' || ') : 'no errors, panel alive=' + alive));
    if (errs.length) bad++;
    await page.context().close();
  }
  console.log(bad ? bad + ' case(s) with errors' : 'all robustness cases clean');
  await browser.close();
})().catch((e) => { console.error('HARNESS FAILURE', e); process.exit(1); });
