// Counts how many full store walks the script does per poll tick, using the real script.
const { chromium } = require('playwright');
const fs = require('fs');
let SCRIPT = fs.readFileSync(process.env.SCRIPT || 'astrolabe.user.js', 'utf8');
SCRIPT = SCRIPT.replace('  function walk(obj, visit, maxDepth, maxNodes) {',
  '  function walk(obj, visit, maxDepth, maxNodes) {\n    try { window.__W = (window.__W || 0) + 1; window.__WD = (window.__WD || []); window.__WD.push(maxDepth || 9); } catch (e) {}');
if (SCRIPT.indexOf('window.__W') < 0) throw new Error('walk not instrumented');
const HTML = `<!doctype html><html><body><div id="q-app"></div></body></html>`;
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  await page.route('http://test.local/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  await page.route('https://*.stellarodyssey.app/**', (r) => r.abort());
  await page.clock.install({ time: new Date('2026-09-19T12:00:00Z') });
  await page.goto('http://test.local/');
  await page.evaluate((root) => {
    const state = {
      UserStore: { username: 't', apikey: 'A'.repeat(32), squadron: { name: 'Alpha', buildings: [], power: { spaceStations: 17 } },
        player: Object.assign({ droids: Array.from({ length: 7 }, () => ({ name: 'd', efficiency: 20, storage: 21, maneuverability: 21, _id: 'x' })), skills: {}, statistics: { gatheringActions: 100 } }, root.UserStore.player), pvp_badges: 500 },
      GatherStore: { isGathering: true, gathering_level: 97, nextActionAt: 0, currentGatheringBody: JSON.stringify({ nodeType: 'crystal' }), lastReward: null },
      ShipStore: { laser_slot: { name: 'L', bonuses: [], catalysts: [] } },
      CurrencyStore: { credits: 1e9, diamond: 1, ruby: 1 },
      PetsStore: { pets: [], petSlots: [] }, MarketStore: { current: '' }, CraftStore: root.CraftStore, MaterialsStore: root.MaterialsStore,
      InventoryStore: { itemList: [] }, PremiumStore: { active: true }, GlobalBoostsStore: { currentBoosts: [] },
    };
    // pad the state so a walk is not trivially small
    state.Big = {}; for (let i = 0; i < 40; i++) { const o = {}; for (let j = 0; j < 40; j++) o['k' + j] = { a: j, b: 'x', c: [1, 2, 3] }; state.Big['s' + i] = o; }
    window.__mock = state;
    const app = { config: { globalProperties: { $pinia: { state: { value: state } }, $router: { currentRoute: { value: { fullPath: '/gathering' } }, push() { return Promise.resolve(); } } } } };
    document.getElementById('q-app').__vue_app__ = app;
  }, JSON.parse(fs.readFileSync('t/root.json', 'utf8')));
  await page.addScriptTag({ content: SCRIPT });
  await page.clock.runFor(1500);
  const boot = await page.evaluate(() => ({ n: window.__W, d: window.__WD.slice() }));
  await page.evaluate(() => { window.__W = 0; window.__WD = []; });
  await page.clock.runFor(10500);            // exactly one poll tick
  const tick = await page.evaluate(() => ({ n: window.__W, d: window.__WD.slice() }));
  await page.evaluate(() => { window.__W = 0; window.__WD = []; });
  await page.clock.runFor(60000);            // six more ticks (one minute)
  const six = await page.evaluate(() => ({ n: window.__W, d: window.__WD.slice() }));
  console.log('walks per minute (6 ticks):', six.n, 'depths', JSON.stringify(six.d));
  await page.evaluate(() => { window.__W = 0; });
  await page.clock.runFor(11 * 60000);       // past the 10-minute sample point
  console.log('walks over the next 11 minutes:', await page.evaluate(() => window.__W));
  // time one tick for real
  const t = await page.evaluate(() => { const t0 = performance.now(); return new Promise((r) => setTimeout(() => r(performance.now() - t0), 0)); });
  console.log('walks during boot :', boot.n, 'depths', JSON.stringify(boot.d));
  console.log('walks per 10s tick:', tick.n, 'depths', JSON.stringify(tick.d));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
