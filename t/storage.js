// How big does the recorded history get? Mock shaped like the real account:
// 75 lifetime counters that never move, 6 that do, 23 resources that do.
const { chromium } = require('playwright');
const fs = require('fs');
const SCRIPT = fs.readFileSync(process.env.SCRIPT || 'astrolabe.user.js', 'utf8');
const HTML = `<!doctype html><html><body><div id="q-app"></div></body></html>`;
const STATIC = ['craftedItems','catalystsMerged','catalystsInstalled','labClaims','labItemsProduced','equipmentDrops','blueprintsFound','dungeonsCleared','bossesKilled','tradesMade'];
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  await page.route('http://test.local/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  await page.route('https://*.stellarodyssey.app/**', (r) => r.abort());
  await page.clock.install({ time: new Date('2026-09-19T00:00:00Z') });
  await page.goto('http://test.local/');
  await page.evaluate((names) => {
    const stats = {};
    names.forEach((n, i) => { for (let k = 0; k < 8; k++) stats[n + (k || '')] = 1000 + i * 7 + k; });   // ~80 frozen counters
    stats.gatheringActions = 0; stats.battlingActions = 0; stats.kills = 0;
    const cur = { credits: 1e9, cosmic_dust: 5 };
    ['diamond','ruby','emerald','sapphire','cobalt','copper','gold','silver','platinum','water','nitrogen','sulfur','carbon','ammonia','hydrogen','helium','methane','argon','silicon','dark_matter','scrap','alloy','plasma'].forEach((r, i) => { cur[r] = 1000 * (i + 1); });
    const state = { UserStore: { username: 't', apikey: 'A'.repeat(32), squadron: { name: 'A', buildings: [], power: { spaceStations: 1 } },
        player: { droids: Array.from({ length: 7 }, () => ({ efficiency: 20, storage: 21, maneuverability: 21 })), statistics: stats, gathering_level: 97 } },
      GatherStore: { isGathering: true, gathering_level: 97, nextActionAt: 0, currentGatheringBody: JSON.stringify({ nodeType: 'crystal' }), lastReward: null },
      ShipStore: {}, CurrencyStore: cur, PetsStore: { pets: [], petSlots: [] }, CraftStore: { crafting_level: 95 }, MaterialsStore: { materialsList: [] } };
    window.__mock = state;
    document.getElementById('q-app').__vue_app__ = { config: { globalProperties: { $pinia: { state: { value: state } }, $router: { currentRoute: { value: { fullPath: '/g' } }, push() { return Promise.resolve(); } } } } };
  }, STATIC);
  await page.addScriptTag({ content: SCRIPT });
  await page.clock.runFor(2000);
  // 30 hours: the movers move, the rest never do
  for (let m = 0; m < 180; m++) {
    await page.evaluate(() => { const s = window.__mock; s.UserStore.player.statistics.gatheringActions += 10;
      s.UserStore.player.statistics.kills += 1; s.CurrencyStore.credits += 5e6;
      Object.keys(s.CurrencyStore).forEach((k) => { if (k !== 'credits' && k !== 'cosmic_dust') s.CurrencyStore[k] += 12345; }); });
    await page.clock.runFor(10 * 60000); await page.waitForTimeout(8);
  }
  await page.click('#btn');
  await page.click('button[data-tab="act"]');
  await page.waitForTimeout(120);
  const act = await page.locator('#body').innerText();
  fs.writeFileSync('t/act_' + (process.env.TAG || 'x') + '.txt', act);
  const r = await page.evaluate(() => {
    const g = (k) => localStorage.getItem('socalc:' + k) || '';
    const series = JSON.parse(g('series') || '[]');
    let tot = 0; Object.keys(localStorage).forEach((k) => { if (k.indexOf('socalc:') === 0) tot += localStorage.getItem(k).length; });
    return { samples: series.length, perSample: series.length ? Math.round(g('series').length / series.length) : 0,
      keysInLast: series.length ? Object.keys(series[series.length - 1].c).length : 0,
      seriesKb: Math.round(g('series').length / 1024), dailyKb: Math.round(g('daily').length / 1024),
      seen0Kb: Math.round(g('seen0').length / 1024), moversKb: Math.round(g('movers').length / 1024), totalKb: Math.round(tot / 1024) };
  });
  console.log((process.env.SCRIPT || 'astrolabe.user.js') + ' after 30h: ' + JSON.stringify(r));
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
