// Does the droid-price socket call still land? Clock advanced in small or big jumps.
const { chromium } = require('playwright');
const fs = require('fs'); const zlib = require('zlib');
const SCRIPT = fs.readFileSync(process.env.SCRIPT || 'astrolabe.user.js', 'utf8');
const HTML = `<!doctype html><html><body><div id="q-app"></div></body></html>`;
const mstr = (x) => Buffer.concat([Buffer.from([0xa0 | x.length]), Buffer.from(x)]);
const u64 = (n) => { const b = Buffer.alloc(9); b[0] = 0xcf; b.writeBigUInt64BE(BigInt(n), 1); return b; };
const priceMsg = Buffer.concat([Buffer.from([0x83]), mstr('classname'), mstr('Gathering'), mstr('method'), mstr('getNextDroidPrice'), mstr('value'), u64(100000000000)]);
const ends = [['user', 9], ['market', 12]];
const value = Buffer.concat([Buffer.from([0x83]), mstr('limit'), Buffer.from([50]), mstr('resetsAt'), (() => { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(1789862400, 1); return b; })(), mstr('endpoints'), Buffer.from([0x90 | ends.length]), ...ends.map(([n, u]) => Buffer.concat([Buffer.from([0x82]), mstr('endpoint'), mstr(n), mstr('used'), Buffer.from([u])]))]);
const quotaMsg = Buffer.concat([Buffer.from([0x83]), mstr('classname'), mstr('Player'), mstr('method'), mstr('getApiQuota'), mstr('value'), value]);
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  await page.route('http://test.local/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  await page.route('https://*.stellarodyssey.app/**', (r) => r.abort());
  await page.clock.install({ time: new Date('2026-09-19T12:00:00Z') });
  await page.goto('http://test.local/');
  await page.addInitScript(() => { window.__DECOY = true; });
  await page.evaluate(() => { window.__DECOY = true; });
  await page.evaluate(({ root, q, p }) => {
    const state = { UserStore: { username: 't', apikey: 'A'.repeat(32), squadron: { name: 'A', buildings: [], power: { spaceStations: 1 } },
        player: Object.assign({ droids: Array.from({ length: 7 }, () => ({ efficiency: 20, storage: 21, maneuverability: 21 })), statistics: { gatheringActions: 1 } }, root.UserStore.player) },
      GatherStore: { isGathering: true, gathering_level: 97, nextActionAt: 0, currentGatheringBody: JSON.stringify({ nodeType: 'crystal' }), lastReward: null },
      ShipStore: {}, CurrencyStore: { credits: 1e9 }, PetsStore: { pets: [], petSlots: [] }, CraftStore: root.CraftStore, MaterialsStore: root.MaterialsStore };
    const listeners = []; window.__methods = [];
    const ws = { readyState: 1, addEventListener(n, f) { if (n === 'message') listeners.push(f); }, removeEventListener(n, f) { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
      send(z) { (async () => { const ds = new DecompressionStream('deflate'); const w = ds.writable.getWriter(); w.write(z instanceof ArrayBuffer ? new Uint8Array(z) : z); w.close();
        const u = new Uint8Array(await new Response(ds.readable).arrayBuffer()); const txt = Array.from(u).map((b) => String.fromCharCode(b)).join('');
        const which = txt.indexOf('getNextDroidPrice') >= 0 ? 'price' : 'quota'; window.__methods.push(which);
        if (window.__DECOY) setTimeout(() => listeners.forEach((l) => l({ data: new Uint8Array(3000).buffer })), 20);
        setTimeout(() => listeners.forEach((l) => l({ data: new Uint8Array(which === 'price' ? p : q).buffer })), 60); })(); } };
    const pin = { state: { value: state }, _s: new Map([['GameStore', { game: ws }]]) };
    document.getElementById('q-app').__vue_app__ = { config: { globalProperties: { $pinia: pin, $router: { currentRoute: { value: { fullPath: '/g' } }, push() { return Promise.resolve(); } } } } };
  }, { root: JSON.parse(fs.readFileSync('t/root.json', 'utf8')), q: Array.from(zlib.deflateSync(quotaMsg)), p: Array.from(zlib.deflateSync(priceMsg)) });
  await page.addScriptTag({ content: SCRIPT });
  const big = !!process.env.BIG;
  for (let m = 0; m < 12; m++) {
    if (big) { await page.clock.runFor(60000); }
    else if (process.env.STEP10) { for (let k = 0; k < 6; k++) { await page.clock.runFor(10000); await page.waitForTimeout(25); } }
    else { for (let k = 0; k < 12; k++) { await page.clock.runFor(5000); await page.waitForTimeout(25); } }
    await page.waitForTimeout(60);
  }
  const dp = await page.evaluate(() => localStorage.getItem('socalc:droidPrice'));
  const ms = await page.evaluate(() => window.__methods.join(','));
  console.log((big ? 'big 60s jumps ' : (process.env.STEP10 ? '10s steps    ' : 'small 5s steps')) + ' -> droidPrice ' + (dp ? 'SET ' + dp : 'MISSING') + '  | calls: ' + ms);
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
