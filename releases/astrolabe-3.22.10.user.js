// ==UserScript==
// @name         Astrolabe for Stellar Odyssey (beta)
// @namespace    stellarodyssey-calc
// @version      3.22.10
// @description  Gathering, battling, equipment, market and arena calculator for Stellar Odyssey. Reads live game state from the page (free, unlimited) and spends the rate-limited API only on the market. Beta: actively being added to and tested.
// @match        *://steam.stellarodyssey.app/*
// @connect      steamapi.stellarodyssey.app
// @connect      api.stellarodyssey.app
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* Astrolabe. The history of changes lives in docs/CHANGELOG.md, not here, so this file
     stays short to read. Add each release's entry there. */

  /* ============================================================
     WHY THIS READS THE PAGE INSTEAD OF THE API

     The public API allows 50 calls per endpoint per day. But the
     game is a Vue app and its entire state lives in Pinia stores
     in this very page. Droids, ship mods, skills and inventory can
     be read from there for free, as often as we like, and they are
     always current. The API budget is then spent only on /market,
     which is the one thing the page does not always hold.
     ============================================================ */

  /* ============================================================
     1. CONSTANTS
     ============================================================ */

  // Web and Steam are separate realms with separate databases and keys (the
  // API docs), and a key is only known to its own realm's host. The page
  // says which realm this is, and only that host is ever called: the other
  // realm does not know this key, so asking it during an outage here only
  // got "API Key missing" back and marked a good key as refused.
  var REALM_HOST = /^steam\./i.test(location.hostname) ? 'https://steamapi.stellarodyssey.app' : 'https://api.stellarodyssey.app';
  var HOSTS = [REALM_HOST];
  var PATHS = { market: '/api/public/market' };
  var DAILY_LIMIT = 50;

  var NODES = {
    rocky:   { commons: ['Copper', 'Gold', 'Silver', 'Platinum'],     rare: 'Dark Matter' },
    icy:     { commons: ['Water', 'Nitrogen', 'Sulfur', 'Carbon'],    rare: 'Silicon' },
    gas:     { commons: ['Ammonia', 'Hydrogen', 'Helium', 'Methane'], rare: 'Argon' },
    crystal: { commons: ['Diamond', 'Ruby', 'Emerald', 'Sapphire'],   rare: 'Cobalt' }
  };

  // Starting points only: once enough actions are logged on a node, survival,
  // rare chance and ore per survivor are measured instead.
  //   attemptsPerHour  300   one action every 12 s, the game's pace. Never
  //                          measured (a straight multiplier in simulate()), so
  //                          it must be kept in step with the game by hand.
  //   baseDodge        50    from the game bundle: dodge = 50 + man/2 + mods
  //   manToDodge       0.5   from the game bundle; 46 of 77 live droid rolls
  //                          survived (59.7%) against 60.5% predicted
  //   baseRare         20    GUESS: with the +20 from laser and probes, 40%;
  //                          5 of the first 11 actions were rare
  //   kCommon, kRare         ore per survivor per action for eff+sto = 0, at
  //                          the player's bonuses: 121,508 and 2,117 measured
  //                          at one action a minute, divided by 5 for one
  //                          every 12 s. They change with the bonuses, which
  //                          is why the script measures them.
  var DEFAULT_MODEL = {
    baseDodge: 50,
    manToDodge: 0.5,
    attemptsPerHour: 300,
    baseRare: 20,
    kCommon: 24300,
    kRare: 423
  };

  var MOD_DEFAULTS = { bDodge: 5, bRareChance: 10 };

  // Catalyst effect, taken from the game's own code and checked against the
  // totals it displays. Base per stat and a multiplier per rarity; a
  // catalyst is worth base x rarity x range / 100 (catVal), half when the
  // game marks it halved. One table for the gathering bonus, the PvE fight
  // and the Equipment tab alike.
  var CAT_MAX = {
    defense: 10, armor_penetration: 10, lifesteal: 3, stun: 10, block: 10, dot: 10,
    precision: 5, evasion: 5, battling_xp: 10, battling_credits: 10, gathering_xp: 10,
    gathering_yield: 10, exploring_xp: 10, cosmic_dust_bonus: 10, crafting_xp: 10,
    crafting_scrap: 10, catalyst_drop_chance: 5, fuel_efficiency: 5,
    voyager_jumps_bonus: 5, base_upkeep_reduction: 5
  };
  var RARITY_MULT = { normal: 1, common: 1, uncommon: 1.5, rare: 2, unique: 2.5, epic: 3, legendary: 4 };
  function catVal(c) { return (CAT_MAX[c.stat] || 0) * (RARITY_MULT[c.rarity] || 1) * (numOr(c.range) || 0) / 100; }
  var SHIP_SLOTS = ['weapon_slot', 'shield_slot', 'engine_slot', 'sensors_slot', 'laser_slot', 'probes_slot'];

  var AR_MAX = 200;   // duels kept; a duel is about 290 bytes, so keeping a lot costs nothing

  // Galaxy tab: one small totals object per day, no per-jump log (the user
  // does not want jump times kept). 35 days: a month plus slack.
  var GALAXY_MAX_DAYS = 35;

  // Credits for a published discovery = gross cosmic dust (net + the taxed
  // slice) x this: the game's own `atlasPublicRewardMultiplier` (1000), the
  // same for manual jumps (original_cosmic_dust x 1000) and Voyager.
  var ATLAS_CREDIT_MULTIPLIER = 1000;

  var DEFAULT_INPUTS = {
    node: 'crystal', hours: 24,
    autoNode: true,       // follow the node currently being gathered
    useObserved: true,    // use measured values once enough actions are logged
    minActions: 20,       // actions needed before measured values are trusted
    autofill: true, activeOnly: true,
    storePoll: 10,        // seconds between free page-state reads
    marketAuto: true,     // spend budget automatically on the market
    reserve: 2,           // calls held back for manual use; the rest (48) is
                           // spent automatically at 2/hour, which already
                           // covers the day evenly, so little is left to want
                           // a manual Refresh for
    keepCredits: 0,       // credits the upgrade plan must leave untouched
    spendLimit: 0,        // most the upgrade plan may spend (0 = everything above the reserve)
    keepBadges: 0,        // PvP badges the gear upgrade plan must leave untouched
    bestGap: 2,           // floor on the gain; the real bar is twice the error bar
    recBattles: true,     // keep a record of arena duels
    recAnomalies: true,   // tally rare anomaly drops seen in Main chat
    maxPaybackDays: 30,   // upgrade steps that pay back slower than this are not suggested
    droidCount: 7, droidEff: 20.5, droidSto: 21.5, droidMan: 21,
    gatheringLevel: 97,
    bRareChance: 0, bRareAmount: 0, bGatherYield: 0, bNodeQuality: 0, bDodge: 0
  };

  /* ============================================================
     2. UTILITIES
     ============================================================ */

  function clamp(lo, hi, v) { return v < lo ? lo : (v > hi ? hi : v); }

  function numOr(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      var m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return null;
  }

  function fmt(x, dp) {
    if (x === null || x === undefined || isNaN(x)) return '--';
    var a = Math.abs(x);
    if (a >= 1e12) return (x / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (x / 1e3).toFixed(2) + 'k';
    return Number(x).toFixed(dp === undefined ? 1 : dp);
  }

  // "500M", "1.5b", "250k", "1,200,000" -> number; "" or "all" -> 0; anything else -> null
  function parseAmount(str) {
    var t = String(str === null || str === undefined ? '' : str).toLowerCase().replace(/[\s,_]/g, '');
    if (t === '' || t === 'all' || t === 'max') return 0;
    var m = /^(\d+\.?\d*|\.\d+)([kmbt]?)$/.exec(t);
    if (!m) return null;
    var mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]];
    var v = parseFloat(m[1]) * mult;
    return isFinite(v) ? Math.round(v) : null;
  }

  function amountText(x) {
    if (!(x > 0)) return '';
    var u = x >= 1e12 ? [1e12, 'T'] : x >= 1e9 ? [1e9, 'B'] : x >= 1e6 ? [1e6, 'M'] : x >= 1e3 ? [1e3, 'k'] : [1, ''];
    return String(parseFloat((x / u[0]).toFixed(3))) + u[1];
  }

  // Safe in text and in a double-quoted attribute alike (player names from
  // chat and the game's own strings pass through here).
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function hhmm(ms) {
    if (ms === null || ms < 0) return '--';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (var i = 0; i < keys.length; i++) {
      var v;
      try { v = obj[keys[i]]; } catch (e) { continue; }
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }

  // Bounded walk. The Pinia store is large and full of reactive proxies,
  // so depth and node count are capped to keep a poll under a millisecond.
  function walk(obj, visit, maxDepth, maxNodes) {
    var seen = new WeakSet(), n = 0;
    maxDepth = maxDepth || 9; maxNodes = maxNodes || 60000;
    (function rec(node, path, depth) {
      if (!node || typeof node !== 'object' || depth > maxDepth || n > maxNodes) return;
      if (seen.has(node)) return;
      seen.add(node);
      var keys;
      try { keys = Array.isArray(node) ? null : Object.keys(node); } catch (e) { return; }
      if (keys === null) {
        for (var i = 0; i < node.length && n < maxNodes; i++) { n++; visit(String(i), node[i], path, node); rec(node[i], path.concat(i), depth + 1); }
        return;
      }
      for (var j = 0; j < keys.length && n < maxNodes; j++) {
        var k = keys[j], v;
        try { v = node[k]; } catch (e) { continue; }
        n++; visit(k, v, path, node); rec(v, path.concat(k), depth + 1);
      }
    })(obj, [], 0);
  }

  // Reads "UserStore.player.statistics.kills" straight out of the state.
  // Every step is guarded: a property that throws must not stop a tick.
  function getByPath(root, path) {
    var parts = String(path).split('.'), cur = root;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== 'object') return null;
      try { cur = cur[parts[i]]; } catch (e) { return null; }
    }
    return numOr(cur);
  }

  function findNumberByKey(obj, re) {
    var out = null;
    walk(obj, function (k, v) {
      if (out !== null) return;
      if (!re.test(k)) return;
      var num = numOr(v);
      if (num !== null && (typeof v === 'number' || typeof v === 'string')) out = num;
    });
    return out;
  }

  /* ============================================================
     3. PERSISTENCE
     ============================================================ */

  var store = {
    get: function (k, d) {
      var raw;
      // The socalc: prefix is deliberate and must not be "tidied" to match
      // the new name: every user's settings, history and recorded duels
      // live under these keys, and renaming them wipes the lot.
      try { if (typeof GM_getValue === 'function') raw = GM_getValue('socalc:' + k); } catch (e) {}
      if (raw === undefined) { try { raw = localStorage.getItem('socalc:' + k); } catch (e) {} }
      if (raw === undefined || raw === null) return d;
      try { return JSON.parse(raw); } catch (e) { return d; }
    },
    set: function (k, v) {
      var s;
      try { s = JSON.stringify(v); } catch (e) { return; }
      try { if (typeof GM_setValue === 'function') { GM_setValue('socalc:' + k, s); return; } } catch (e) {}
      try { localStorage.setItem('socalc:' + k, s); } catch (e) {}
    }
  };

  /* ============================================================
     4. READING THE PAGE'S PINIA STORE  (free, no quota)
     ============================================================ */

  function unwrap(o) { try { return (o && o.wrappedJSObject) || o; } catch (e) { return o; } }

  var vueApp = null;
  function findVueApp() {
    try { if (vueApp && vueApp._container && document.contains(vueApp._container)) return vueApp; } catch (e) {}
    vueApp = null;
    var roots = [];
    ['#app', '#q-app', '#__nuxt', '#root', 'body > div'].forEach(function (sel) {
      try { document.querySelectorAll(sel).forEach(function (n) { roots.push(n); }); } catch (e) {}
    });
    try { document.querySelectorAll('body div').forEach(function (n, i) { if (i < 60) roots.push(n); }); } catch (e) {}
    for (var i = 0; i < roots.length; i++) {
      var el = unwrap(roots[i]);
      try { if (el && el.__vue_app__) { vueApp = el.__vue_app__; return vueApp; } } catch (e) {}
    }
    return null;
  }

  function findPinia() {
    var app = findVueApp();
    if (!app) return null;
    try {
      var gp = app.config && app.config.globalProperties;
      if (gp && gp.$pinia) return gp.$pinia;
    } catch (e) {}
    try {
      var prov = app._context && app._context.provides;
      if (prov) {
        var syms = Object.getOwnPropertySymbols(prov);
        for (var i = 0; i < syms.length; i++) {
          if (String(syms[i]).toLowerCase().indexOf('pinia') >= 0) return prov[syms[i]];
        }
        for (var j = 0; j < syms.length; j++) {
          var cand = prov[syms[j]];
          if (cand && cand.state && cand.state.value) return cand;
        }
      }
    } catch (e) {}
    return null;
  }

  function readStoreState() {
    var pinia = findPinia();
    if (!pinia) return null;
    try {
      var sv = pinia.state && pinia.state.value;
      if (!sv) return null;
      var out = {};
      Object.keys(sv).forEach(function (id) { try { out[id] = sv[id]; } catch (e) {} });
      return out;
    } catch (e) { return null; }
  }

  /* ============================================================
     5. INTERPRETING STATE
     ============================================================ */

  var BONUS_ARRAY_KEYS = /^(bonus|bonuses|mods|modifiers|modifier|effects|effect|perks|affixes|traits)$/i;

  function textOf(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      return [entry.name, entry.label, entry.description, entry.text, entry.stat, entry.type, entry.key, entry.id]
        .filter(function (x) { return typeof x === 'string'; }).join(' ');
    }
    return String(entry);
  }

  function magnitudeOf(entry) {
    if (entry && typeof entry === 'object') {
      var n = numOr(pick(entry, ['value', 'amount', 'magnitude', 'percent', 'pct', 'val', 'bonus', 'modifier', 'level']));
      if (n !== null) return n;
    }
    return numOr(textOf(entry));
  }

  function classify(text) {
    var t = String(text).toLowerCase();
    function has() { for (var i = 0; i < arguments.length; i++) if (t.indexOf(arguments[i]) >= 0) return true; return false; }
    if (has('rare') && has('chance', 'drop rate', 'drop chance', 'proc')) return 'bRareChance';
    if (has('rare') && has('amount', 'quantity', 'yield', 'size')) return 'bRareAmount';
    if (has('node') && has('quality', 'grade', 'tier')) return 'bNodeQuality';
    if (has('dodge', 'evasion', 'evade')) return 'bDodge';
    if (has('gather', 'mining', 'harvest', 'resource') && has('yield', 'amount', 'output', 'boost')) return 'bGatherYield';
    return null;
  }

  // Only what is EQUIPPED counts. In the game state every item in the bag
  // (InventoryStore.itemList) also carries a bonuses array, and summing
  // those inflated the totals by 6x or more. With the page state the
  // equipped gear lives in ShipStore.*_slot, so the scan is confined to it.
  // Without a ShipStore (if the game ever renames it) the whole state is
  // searched instead, and the bag is skipped by name.
  function scanBonuses(root) {
    var totals = { bRareChance: 0, bRareAmount: 0, bGatherYield: 0, bNodeQuality: 0, bDodge: 0 };
    var matched = 0;
    var ship = root && root.ShipStore && typeof root.ShipStore === 'object' ? root.ShipStore : null;
    var scope = ship || root;
    walk(scope, function (k, v, path) {
      if (!BONUS_ARRAY_KEYS.test(k) || !Array.isArray(v)) return;
      if (!ship) {
        for (var p = 0; p < path.length; p++) {
          if (/^(itemList|inventory|InventoryStore)$/i.test(String(path[p]))) return;
        }
      }
      v.forEach(function (entry) {
        var txt = textOf(entry).trim();
        if (!txt) return;
        var id = classify(txt);
        if (!id) return;
        var mag = magnitudeOf(entry);
        if (mag === null && MOD_DEFAULTS[id] !== undefined) mag = MOD_DEFAULTS[id];
        if (mag === null) return;
        totals[id] += mag;
        matched++;
      });
    }, ship ? 5 : 9);
    return { totals: totals, matched: matched, authoritative: !!ship };
  }

  // Catalysts on the equipped gear, by the game's own formula. Only the
  // "default" activity applies while gathering (the Gathering page itself asks
  // for getEquippedBonusesForShip(..., 'default')). Verified against the
  // totals the game shows: gathering yield 52.40, gathering XP 49.80, block 37.60.
  function catalystTotals(root) {
    var ship = root && root.ShipStore;
    if (!ship || typeof ship !== 'object') return null;
    var out = {}, count = 0;
    SHIP_SLOTS.forEach(function (slot) {
      var item = ship[slot], list = item && item.catalysts;
      if (!Array.isArray(list)) return;
      list.forEach(function (c) {
        if (!c || c.activity !== 'default') return;
        if (CAT_MAX[c.stat] === undefined) return;
        out[c.stat] = (out[c.stat] || 0) + catVal(c) * (c.halved ? 0.5 : 1);
        count++;
      });
    });
    return { totals: out, count: count };
  }

  // Every part of the resource bonus, as the game's own Gathering page lists
  // them (its "Resources" chips, read out of its code in 3.21.5): catalysts
  // (Default profile), Amplifier (level x 2, not in a system another squadron
  // has claimed), Reputation (stations parked in a system, x 5), squadron
  // dungeon runs, the slotted Dog pet (its level), a base on an icy body
  // (+10), the Income boost (5 to 25 by time left), companion collections,
  // Battlefield zones, and the Subscription (+10).
  function resourceSources(root) {
    var out = [];
    var cat = catalystTotals(root);
    if (cat) out.push({ name: 'Catalysts', pct: cat.totals.gathering_yield || 0 });
    var lr = null;
    try { lr = parseMaybeJson(root.GatherStore.lastReward); } catch (e) {}
    try {
      var b = root.UserStore.squadron.buildings || [], amp = null;
      for (var i = 0; i < b.length; i++) if (b[i] && b[i].name === 'Amplifier') amp = b[i];
      if (amp && !(lr && lr.otherSquadInSameSystem)) out.push({ name: 'Amplifier', pct: amp.level * 2 });
    } catch (e) {}
    try {
      var st = root.squadronStore && root.squadronStore.spaceStations, ss = null;
      if (Array.isArray(st) && st.length) ss = st.filter(function (x) { return x && x.system_parked; }).length;
      else ss = numOr(root.UserStore.squadron.power.spaceStations);
      if (ss) out.push({ name: 'Reputation', pct: ss * 5 });
    } catch (e) {}
    try {
      var runs = numOr(root.UserStore.squadron.dungeons.statistics.gatheringRuns.highest) || 0;
      if (runs > 0) out.push({ name: 'Dungeon', pct: dungeonBonus(runs) });
    } catch (e) {}
    var dog = slottedPetLevel(root, 'Dog');
    if (dog !== null) out.push({ name: 'Dog pet', pct: dog });
    try { if (root.BaseBuildingStore.base.bodyType === 'icy') out.push({ name: 'Base', pct: 10 }); } catch (e) {}
    var inc = incomeBoostPct(root);
    if (inc) out.push({ name: 'Income boost', pct: inc });
    try {
      var cs = findPinia()._s.get('CompanionsStore'), cy = cs && cs.collectionBonuses && numOr(cs.collectionBonuses.gathering_yield);
      if (cy) out.push({ name: 'Companions', pct: cy });
    } catch (e) {}
    var pvp = lr ? numOr(lr.pvpGatheringBoost) : null;
    if (pvp) out.push({ name: 'Battlefield', pct: pvp });
    try { if (root.PremiumStore && root.PremiumStore.active) out.push({ name: 'Subscription', pct: 10 }); } catch (e) {}
    return out;
  }

  // The game's dungeonBoostBonusPerLevel: 5 a run for the first 5, then 4,
  // 3 up to 20, and 2 after that.
  function dungeonBonus(n) {
    var t = Math.min(n, 5) * 5;
    if (n > 5) t += Math.min(n - 5, 5) * 4;
    if (n > 10) t += Math.min(n - 10, 10) * 3;
    if (n > 20) t += (n - 20) * 2;
    return t;
  }

  // The Income boost by time left (the game's GlobalBoostTier): under 6 h 5%,
  // under 12 h 10%, under 24 h 15%, under 48 h 20%, 48 h or more 25%.
  // timer is the moment the boost ends, in seconds since 1970.
  function incomeBoostPct(root) {
    var pct = 0;
    try {
      (root.GlobalBoostsStore.currentBoosts || []).forEach(function (x) {
        var t = numOr(x && x.timer);
        if (!x || !x.boost || x.boost.name !== 'Income' || t === null) return;
        var min = Math.floor((t - Date.now() / 1000) / 60);
        if (min > 0) pct = Math.max(pct, 5 * (min < 360 ? 1 : min < 720 ? 2 : min < 1440 ? 3 : min < 2880 ? 4 : 5));
      });
    } catch (e) {}
    return pct;
  }

  /* ============================================================
     5a. GATHERING ACTIONS

     Every 12 s the server runs one action and the result lands in
     GatherStore.lastReward:
       { name, amount, xp, statistics: [ { alive, ore, globalTaxed } ... ] }
     One entry per droid, in droid order. Each survivor's ore is a fixed
     number that scales with (1 + efficiency% + storage%), so it is stored
     divided by that factor. That makes readings from different droids, and
     from before and after an upgrade, directly comparable.
     ============================================================ */

  function parseMaybeJson(v) {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
    return v && typeof v === 'object' ? v : null;
  }

  // The one spelling of a resource or good's name used as a key everywhere:
  // the price book, the goods list, the action log. "Dark Matter",
  // "dark_matter" and "dark-matter" all come out as "dark matter".
  function normName(s) { return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/[_\s-]+/g, ' ').trim(); }

  function readGather(root) {
    var g = root && root.GatherStore;
    if (!g || typeof g !== 'object') return null;
    return {
      isGathering: !!g.isGathering,
      nextActionAt: numOr(g.nextActionAt),
      body: parseMaybeJson(g.currentGatheringBody),
      reward: parseMaybeJson(g.lastReward)
    };
  }

  function resClass(nodeKey, name) {
    var node = NODES[nodeKey];
    if (!node) return null;
    var n = normName(name);
    if (n === normName(node.rare)) return 'rare';
    for (var i = 0; i < node.commons.length; i++) if (n === normName(node.commons[i])) return 'common';
    return null;
  }

  function logAction(gth) {
    var r = gth && gth.reward;
    if (!r || !Array.isArray(r.statistics) || !r.statistics.length) return;
    var key = normName(r.name) + '|' + r.amount + '|' + gth.nextActionAt;
    if (key === S.lastActKey) return;
    S.lastActKey = key;

    // The reward can belong to the previous node for one action after a switch,
    // so it only counts if the resource is one this node can actually give.
    var nodeKey = gth.body && gth.body.nodeType ? String(gth.body.nodeType).toLowerCase() : null;
    if (!nodeKey || !resClass(nodeKey, r.name)) return;

    // Actions are 12 s apart, and nextActionAt is the time of the next one.
    var t = gth.nextActionAt ? gth.nextActionAt - 12000 : Date.now();
    var last = S.acts[S.acts.length - 1];
    // Half the action interval: close enough to be the same action re-read,
    // too close to be a genuinely new one at the game's own pace.
    if (last && Math.abs(t - last.t) < 6000) return;   // the same action seen twice

    var ds = S.droids || [], stats = r.statistics, sameLen = ds.length === stats.length;
    var avgF = ds.length ? ds.reduce(function (a, d) { return a + 1 + (d.eff + d.sto) / 100; }, 0) / ds.length : 1;
    var oreSum = 0, taxSum = 0;
    var k = stats.map(function (s, i) {
      var tax = numOr(s && s.globalTaxed); if (tax !== null) taxSum += tax;
      if (!s || !s.alive) return null;
      var ore = numOr(s.ore);
      if (ore === null) return null;
      oreSum += ore;
      var f = sameLen ? 1 + (ds[i].eff + ds[i].sto) / 100 : avgF;
      return Math.round(ore / f);
    });
    S.acts.push({ t: t, n: nodeKey, r: normName(r.name), k: k, o: oreSum, x: taxSum });
    if (S.acts.length > 1500) S.acts = S.acts.slice(-1500);
    saveActs(false);
  }

  // A full log is about 170 KB and an action lands every 12 s, so it is
  // written at most once a minute (the tick catches up after a quiet spell),
  // and at once when the page is hidden or closed.
  var ACTS_SAVE_MS = 60000, actsSavedAt = 0, actsDirty = false;
  function saveActs(force) {
    if (!force && Date.now() - actsSavedAt < ACTS_SAVE_MS) { actsDirty = true; return; }
    actsSavedAt = Date.now(); actsDirty = false;
    store.set('acts', S.acts); store.set('lastActKey', S.lastActKey);
  }
  function flushActs() { if (actsDirty) saveActs(true); }

  /* ---- Galaxy tab: manual and Voyager jump totals, and mystery boxes ----
     One small object per day, no per-jump log (no jump times: the user's
     wish): jumps, XP, dust and credits, manual and Voyager apart, and the
     mystery boxes. Credits exist only for a discovery published on the
     Atlas: gross dust x ATLAS_CREDIT_MULTIPLIER.
     Manual: ExploreStore.lastRewards is exact the instant you arrive. The
     publish comes a moment later, as a reply on the game socket with the
     exact credits and any box (see logGalaxyReply).
     Voyager: a waypoint's dust is exact once its status is "reached", so it
     is counted then, one jump per waypoint (the user's wish), its credits
     assuming public (see logGalaxyVoyager). XP comes as one lump sum on
     claim, credited once on the claim's day, by watching
     exploring_current_xp jump when counted waypoints leave the queue. The
     claim's own reply carries any box. */

  // The game's day starts at midnight UTC (the API quota resets then too).
  // A day is keyed by the local date it started on: 8 PM the evening before
  // in New York in summer, 7 PM in winter, 2 AM in Paris. Working from UTC
  // keeps that right in any time zone and across a daylight-saving change.
  var DAY_MS = 86400000;
  function gameDayStart(ts) { return Math.floor(ts / DAY_MS) * DAY_MS; }
  function galaxyDayKey(ts) {
    var d = new Date(gameDayStart(ts));
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // A day's totals. m manual, v Voyager: j jumps, x XP, d dust kept, dt dust
  // taxed, c credits; mp publishes and vq claims seen by the box listener,
  // mb and vb the boxes among them; bc box credits; bcm and brm the box
  // resources, common and rare, {name: amount}.
  var GALAXY_NUMS = ['mj', 'mx', 'md', 'mdt', 'mc', 'mp', 'mb', 'vj', 'vx', 'vd', 'vdt', 'vc', 'vq', 'vb', 'bc'];
  var GALAXY_MAPS = ['bcm', 'brm'];

  // Repairs a bucket saved before a field existed, or left at NaN (stored as
  // null) by adding to a missing field: vc exactly to (vd + vdt) x the
  // multiplier, which Voyager credits always are; any other count to 0
  // (which jumps were public, and boxes from before the listener, are not
  // kept); resources to none. A healthy bucket is left alone. Called
  // wherever a bucket is read or written, so it heals on first touch; it also
  // fills in a new day's empty bucket.
  function healGalaxyBucket(b) {
    var changed = false;
    if (typeof b.vc !== 'number' || isNaN(b.vc)) { b.vc = ((b.vd || 0) + (b.vdt || 0)) * ATLAS_CREDIT_MULTIPLIER; changed = true; }
    GALAXY_NUMS.forEach(function (k) { if (typeof b[k] !== 'number' || isNaN(b[k])) { b[k] = 0; changed = true; } });
    GALAXY_MAPS.forEach(function (k) { if (!b[k] || typeof b[k] !== 'object' || Array.isArray(b[k])) { b[k] = {}; changed = true; } });
    return changed;
  }

  function galaxyBucket(ts) {
    var day = galaxyDayKey(ts);
    var b = S.galaxy.length ? S.galaxy[S.galaxy.length - 1] : null;
    // Keys only move forward: a bucket saved under a later key (an older
    // version's boundary, west of UTC-3) stays today's rather than a day
    // being started that sorts before it.
    if (!b || b.d < day) {
      b = { d: day };   // every field is filled in at zero just below
      S.galaxy.push(b);
      if (S.galaxy.length > GALAXY_MAX_DAYS) S.galaxy = S.galaxy.slice(-GALAXY_MAX_DAYS);
    }
    healGalaxyBucket(b);
    return b;
  }

  // now: the timestamp to log against, defaulting to the real clock. An
  // explicit argument exists so tests can drive day-boundary crossings
  // without depending on when they happen to run.
  function logGalaxyManual(root, now) {
    now = now || Date.now();
    var ex = root && root.ExploreStore;
    var lr = ex && ex.lastRewards;
    if (!lr || typeof lr !== 'object') return;
    var xp = numOr(lr.xp_gain), dust = numOr(lr.cosmic_dust), dustTaxed = numOr(lr.cosmic_dust_taxed);
    if (xp === null && dust === null) return;   // nothing worth logging yet
    var key = [xp, dust, dustTaxed, lr.newSystem ? 1 : 0, numOr(lr.original_cosmic_dust)].join('|');
    if (key === S.lastGalaxyKey) return;
    S.lastGalaxyKey = key; store.set('lastGalaxyKey', key);
    var b = galaxyBucket(now);
    b.mj += 1; b.mx += xp || 0; b.md += dust || 0; b.mdt += dustTaxed || 0;
    store.set('galaxy', S.galaxy);
  }

  function logGalaxyVoyager(root, now) {
    now = now || Date.now();
    var vs = root && root.Voyager, ex = root && root.ExploreStore;
    var q = (vs && Array.isArray(vs.queue)) ? vs.queue : [];
    var present = {}, changed = false;
    q.forEach(function (wp) {
      if (!wp || !wp._id) return;
      present[wp._id] = true;
      if (wp.status === 'reached' && S.galaxySeenWp.indexOf(wp._id) === -1) {
        S.galaxySeenWp.push(wp._id);
        var b = galaxyBucket(now);
        var wd = numOr(wp.cosmic_dust_reward) || 0, wdt = numOr(wp.cosmic_dust_reward_taxed) || 0;
        b.vj += 1; b.vd += wd; b.vdt += wdt;
        // A waypoint's publish choice lives only in the claim screen and is
        // never readable afterwards, so this assumes public (the game's
        // default and the user's habit): a waypoint kept private is
        // overcounted.
        b.vc += (wd + wdt) * ATLAS_CREDIT_MULTIPLIER;
        changed = true;
      }
    });

    // A claim: a waypoint already counted has left the queue entirely.
    // Voyager pays XP once for the whole expedition, not per waypoint, so
    // this adds the XP delta once even when several waypoints vanish on
    // the same tick (one claim covering all of them), not once each.
    var claimed = S.galaxySeenWp.filter(function (id) { return !present[id]; });
    if (claimed.length) {
      S.galaxySeenWp = S.galaxySeenWp.filter(function (id) { return present[id]; });
      var xpNow = ex ? numOr(ex.exploring_current_xp) : null;
      if (xpNow !== null && S.lastExploreXp !== null && xpNow > S.lastExploreXp) {
        galaxyBucket(now).vx += xpNow - S.lastExploreXp;
      }
      changed = true;
    }
    var xpSnap = ex ? numOr(ex.exploring_current_xp) : null;
    if (xpSnap !== null) S.lastExploreXp = xpSnap;

    if (changed) { store.set('galaxySeenWp', S.galaxySeenWp); store.set('galaxy', S.galaxy); }
  }

  // A publish or a Voyager claim, from the game's own reply (see boxListen):
  // {classname, method, value}. A publish counts only once its system reads
  // public, with its exact credits (creditReward). Either reply may carry a
  // box: {credits, commonRes: {resource, amount}, rareRes: {...}}, or null.
  function logGalaxyReply(m, now) {
    var v = m && m.value;
    if (!v || typeof v !== 'object') return;
    var pub = m.classname === 'Atlas' && m.method === 'setSystemPerms' && !!v.sys && v.sys.display === 'public';
    if (!pub && !(m.classname === 'Voyager' && m.method === 'getVoyagerReward')) return;
    var b = galaxyBucket(now || Date.now()), box = v.rewardChest;
    if (pub) {
      b.mp += 1;
      var cr = numOr(v.creditReward);
      if (cr > 0) b.mc += cr;
    } else b.vq += 1;
    if (box && typeof box === 'object') {
      if (pub) b.mb += 1; else b.vb += 1;
      var c = numOr(box.credits);
      if (c > 0) b.bc += c;
      addBoxRes(b.bcm, box.commonRes);
      addBoxRes(b.brm, box.rareRes);
    }
    store.set('galaxy', S.galaxy);
  }

  function addBoxRes(map, r) {
    if (!r || typeof r.resource !== 'string') return;
    var a = numOr(r.amount), k = normName(r.resource);
    if (a > 0) map[k] = (map[k] || 0) + a;
  }

  function galaxyToday(now) {
    now = now || Date.now();
    var day = galaxyDayKey(now);
    var b = S.galaxy.length ? S.galaxy[S.galaxy.length - 1] : null;
    if (!b || b.d < day) { b = { d: day }; healGalaxyBucket(b); return b; }
    if (healGalaxyBucket(b)) store.set('galaxy', S.galaxy);   // see healGalaxyBucket() - heals on read too, not just on write
    return b;
  }

  // Sums the last `days` day-buckets kept (there is one per day the tab was
  // open on, not a full calendar - a gap while the game was not played just
  // is not there to sum).
  function galaxySum(days) {
    var rows = S.galaxy.slice(-days), out = { days: rows.length }, healed = false;
    GALAXY_NUMS.forEach(function (k) { out[k] = 0; });
    GALAXY_MAPS.forEach(function (k) { out[k] = {}; });
    rows.forEach(function (b) {
      if (healGalaxyBucket(b)) healed = true;
      GALAXY_NUMS.forEach(function (k) { out[k] += b[k]; });
      GALAXY_MAPS.forEach(function (k) {
        Object.keys(b[k]).forEach(function (r) { out[k][r] = (out[k][r] || 0) + (numOr(b[k][r]) || 0); });
      });
    });
    if (healed) store.set('galaxy', S.galaxy);
    return out;
  }

  // Whether the last `days` buckets still hold everything counted since
  // `since`: not once a day from then on has dropped out of them.
  function galaxySumsSince(days, since) {
    var n = S.galaxy.length;
    return n <= days || S.galaxy[n - days - 1].d < galaxyDayKey(since);
  }

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // What the log says for one node type, most recent 500 actions.
  function actionStats(nodeKey) {
    if (!NODES[nodeKey]) return null;
    var rows = S.acts.filter(function (a) { return a.n === nodeKey; }).slice(-500);
    if (!rows.length) return null;
    var rolls = 0, alive = 0, rare = 0, kc = [], kr = [], ore = 0, tax = 0, perRes = {};
    rows.forEach(function (a) {
      var cls = resClass(nodeKey, a.r);
      perRes[a.r] = (perRes[a.r] || 0) + 1;
      if (cls === 'rare') rare++;
      ore += a.o || 0; tax += a.x || 0;
      (a.k || []).forEach(function (v) {
        rolls++;
        if (v === null || v === undefined) return;
        alive++;
        (cls === 'rare' ? kr : kc).push(v);
      });
    });
    return {
      n: rows.length, rolls: rolls, alive: alive, rare: rare,
      survival: rolls ? alive / rolls : null,
      pRare: rare / rows.length,
      kCommon: median(kc.slice(-200)), kRare: median(kr.slice(-100)),
      nKc: kc.length, nKr: kr.length,
      // ore is what the player kept and tax what the squadron took, so the
      // rate is the share of the gross: tax / (kept + tax).
      taxRate: (ore + tax) ? tax / (ore + tax) : null,
      perRes: perRes, first: rows[0].t, last: rows[rows.length - 1].t
    };
  }

  // Measured values, once there are enough actions and the user has not
  // switched them off. Otherwise null, and the starting estimates are used.
  function empirical() {
    if (!S.inputs.useObserved) return null;
    var st = actionStats(S.inputs.node);
    if (!st || st.survival === null || st.n < Math.max(1, S.inputs.minActions)) return null;
    return st;
  }

  function statOf(d, names) {
    for (var i = 0; i < names.length; i++) {
      var n = numOr(d[names[i]]);
      if (n !== null) return n;
    }
    var f = findNumberByKey(d, new RegExp(names.join('|'), 'i'));
    return f === null ? 0 : f;
  }

  function droidIsActive(d) {
    var s = pick(d, ['status', 'state']);
    if (typeof s === 'string' && /idle|inactive|broken|destroyed|repair|dock|stored|dead/i.test(s)) return false;
    var flags = ['active', 'assigned', 'deployed', 'enabled', 'alive', 'is_active', 'isActive'];
    for (var i = 0; i < flags.length; i++) if (typeof d[flags[i]] === 'boolean') return d[flags[i]];
    return true;
  }

  function readDroids(root) {
    var best = null;
    // Where the game keeps them. The search below is only a fallback.
    try {
      var d = root.UserStore.player.droids;
      if (Array.isArray(d) && d.length && d[0] && typeof d[0] === 'object') best = d;
    } catch (e) {}
    if (!best) {
      walk(root, function (k, v) {
        if (!/^droids?$/i.test(k) || !Array.isArray(v) || !v.length) return;
        if (typeof v[0] !== 'object' || v[0] === null) return;
        if (!best || v.length > best.length) best = v;
      });
    }
    if (!best) return null;
    // A gap (null) in the list would otherwise throw and skip the whole read.
    return best.filter(function (d) { return d && typeof d === 'object'; }).map(function (d, i) {
      return {
        idx: i + 1, name: typeof d.name === 'string' ? d.name : ('Droid ' + (i + 1)),
        eff: statOf(d, ['efficiency', 'eff']),
        sto: statOf(d, ['storage', 'cargo', 'capacity']),
        man: statOf(d, ['maneuverability', 'maneuver', 'agility']),
        active: droidIsActive(d)
      };
    });
  }

  /* ---- shared readers: materials and pets ----
     Each is read by more than one tab. Reading them in one place means a
     change of shape in the game is handled once. Neither ever throws. */

  // Materials as [{name, cat, q}]. The game's entries are
  // {item: {name, category, ...}, quantity}; older ones (and t/root.json)
  // are {item: "name", quantity}. Both are accepted.
  function matList(root) {
    var out = [];
    try {
      var L = root.MaterialsStore.materialsList;
      if (!Array.isArray(L)) return out;
      L.forEach(function (m) {
        var it = m && m.item, nm = typeof it === 'string' ? it : (it && typeof it.name === 'string' ? it.name : null);
        if (nm) out.push({ name: nm, cat: it && typeof it === 'object' ? it.category : null, q: numOr(m.quantity) || 0 });
      });
    } catch (e) {}
    return out;
  }

  // Materials held, by lower-case name.
  function matsHeld(root) {
    var o = {};
    matList(root).forEach(function (m) { o[m.name.toLowerCase()] = m.q; });
    return o;
  }

  // The level of the pet of this name that sits in a slot, or null. A player
  // can own more than one of a kind; only the slotted one counts.
  function slottedPetLevel(root, name) {
    try {
      var P = root.PetsStore, inSlot = {}, lv = null;
      (P.petSlots || []).forEach(function (s) { if (s && s.pet) inSlot[s.pet] = 1; });
      (P.pets || []).forEach(function (p) { if (lv === null && p && p.name === name && inSlot[p._id]) lv = numOr(p.level) || 0; });
      return lv;
    } catch (e) { return null; }
  }

  var NAME_KEYS = ['currency', 'resource', 'resource_name', 'resourceName', 'name', 'item', 'item_name', 'symbol', 'ticker', 'commodity'];

  function readGatheringLevel(root) {
    var direct = getByPath(root, 'GatherStore.gathering_level');
    if (direct !== null) return direct;
    var gl = findNumberByKey(root, /^(gathering_?level|gatheringLvl)$/i);
    if (gl === null) gl = findNumberByKey(root, /gathering.*level|level.*gathering/i);
    return gl;
  }

  /* ---- the API key and the quota counters are shown in the game's own
     UI, so both are already in the page state. Find them rather than
     asking the player to copy anything. ---- */

  // Any token-like string: the key's format is the server's business, and a
  // stricter check once rejected a regenerated key outright, which left an
  // old typed-in key in use and refused for weeks.
  function looksLikeKey(v) {
    return typeof v === 'string' && v.length >= 16 && v.length <= 256 && !/\s/.test(v);
  }

  // The key lives on the player's own account. Only that field, or a field
  // with an unmistakable name, is used. Nothing else in the state is guessed.
  // That field is read on every update; the search of everything else
  // (about 50 ms on a real account) runs at most every 5 minutes while no
  // key has been found.
  var KEY_SEARCH_MS = 5 * 60000, lastKeySearch = 0;
  function readApiKey(root, now) {
    try { var direct = root.UserStore.apikey; if (looksLikeKey(direct)) return direct; } catch (e) {}
    now = now || Date.now();
    if (lastKeySearch && now - lastKeySearch < KEY_SEARCH_MS) return null;
    lastKeySearch = now;
    var found = null;
    walk(root, function (k, v) {
      if (found || !looksLikeKey(v)) return;
      if (/^(sodyssey_?api_?key|api_?key|apikey|public_?api_?key)$/i.test(k)) found = v;
    }, 8);
    return found;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // The single source of truth is the @version line at the top of the file;
  // this just reads it back, the same way Tampermonkey does, so the panel
  // and the Copy report can never show a version older code forgot to bump.
  function scriptVersion() { try { return GM_info.script.version; } catch (e) { return '?'; } }

  /* ============================================================
     6. MARKET PARSING
     ============================================================ */

  var BID_KEYS = ['buy', 'bid', 'highest_buy', 'highestBuy', 'best_bid', 'buy_price', 'buyPrice'];
  var ASK_KEYS = ['sell', 'ask', 'lowest_sell', 'lowestSell', 'best_ask', 'sell_price', 'sellPrice'];
  var TIME_KEYS = ['time', 'timestamp', 'date', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 't'];

  function tsOf(o) {
    var v = pick(o, TIME_KEYS);
    if (v === null) return null;
    var n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    return isFinite(n) ? n : null;
  }

  function rowsOf(market) {
    if (Array.isArray(market)) return market;
    var direct = ['orders', 'markets', 'listings', 'resources', 'items', 'data', 'result'];
    for (var i = 0; i < direct.length; i++) {
      var v = market && market[direct[i]];
      if (Array.isArray(v) && v.length) return v;
      if (v && typeof v === 'object') {
        for (var j = 0; j < direct.length; j++) if (Array.isArray(v[direct[j]]) && v[direct[j]].length) return v[direct[j]];
      }
    }
    var found = null;
    walk(market, function (k, val) { if (!found && Array.isArray(val) && val.length && typeof val[0] === 'object') found = val; });
    return found || [];
  }

  function buildBooks(market) {
    var books = {};
    rowsOf(market).forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      var name = pick(row, NAME_KEYS);
      if (!name || typeof name === 'object') return;
      var key = normName(name);
      if (!key) return;
      var b = books[key] || (books[key] = { name: String(name), bid: null, ask: null, bidDepth: [], askDepth: [], stamp: null, shape: null });

      var hist = Array.isArray(row.prices) ? row.prices : (Array.isArray(row.history) ? row.history : null);
      if (hist && hist.length) {
        var latest = hist[0], best = tsOf(hist[0]);
        hist.forEach(function (p) { var t = tsOf(p); if (t !== null && (best === null || t >= best)) { best = t; latest = p; } });
        if (best === null) latest = hist[hist.length - 1];
        var hb = numOr(pick(latest, BID_KEYS)), ha = numOr(pick(latest, ASK_KEYS));
        if (hb !== null) b.bid = hb;
        if (ha !== null) b.ask = ha;
        b.stamp = best; b.shape = 'history';
        return;
      }

      var side = String(pick(row, ['type', 'side', 'order_type', 'orderType', 'direction']) || '').toLowerCase();
      var price = numOr(pick(row, ['price', 'unit_price', 'unitPrice', 'value']));
      var qty = numOr(pick(row, ['quantity', 'qty', 'amount', 'volume', 'count', 'remaining']));
      if (price !== null && /buy|bid/.test(side)) { b.bidDepth.push([price, qty === null ? 0 : qty]); b.shape = 'orders'; return; }
      if (price !== null && /sell|ask/.test(side)) { b.askDepth.push([price, qty === null ? 0 : qty]); b.shape = 'orders'; return; }

      var rb = numOr(pick(row, BID_KEYS)), ra = numOr(pick(row, ASK_KEYS));
      if (rb !== null) { b.bid = rb; b.shape = b.shape || 'quote'; }
      if (ra !== null) { b.ask = ra; b.shape = b.shape || 'quote'; }
      if (b.stamp === null) b.stamp = tsOf(row);
    });
    Object.keys(books).forEach(function (k) {
      var b = books[k];
      b.bidDepth.sort(function (x, y) { return y[0] - x[0]; });
      b.askDepth.sort(function (x, y) { return x[0] - y[0]; });
      if (b.bid === null && b.bidDepth.length) b.bid = b.bidDepth[0][0];
      if (b.ask === null && b.askDepth.length) b.ask = b.askDepth[0][0];
    });
    return books;
  }

  function bookFor(books, name) {
    var k = normName(name);
    if (books[k]) return books[k];
    var hit = null;
    Object.keys(books).forEach(function (bk) {
      if (hit) return;
      if (bk.indexOf(k) >= 0 || k.indexOf(bk) >= 0) hit = books[bk];
    });
    return hit || { name: name, bid: null, ask: null, bidDepth: [], askDepth: [], shape: null };
  }

  function fillAgainst(depth, qty) {
    if (!depth.length || !(qty > 0)) return null;
    var left = qty, total = 0, filled = 0, unknown = false;
    for (var i = 0; i < depth.length && left > 0; i++) {
      var price = depth[i][0], avail = depth[i][1];
      if (!(avail > 0)) { unknown = true; avail = left; }
      var take = Math.min(left, avail);
      total += take * price; filled += take; left -= take;
    }
    return { total: total, filled: filled, unfilled: Math.max(0, left), vwap: filled ? total / filled : null, unknownDepth: unknown };
  }

  // The market may already be in the page store, in which case no API call
  // is needed at all. The game usually only populates it once the market
  // screen has been opened in-game at least once this session.
  function marketFromStore(state) {
    if (!state) return null;
    var best = null, bestN = 0;
    walk(state, function (k, v) {
      if (!/market|order|exchange|trade|auction|listing|price/i.test(k)) return;
      if (!v || typeof v !== 'object') return;
      var books;
      try { books = buildBooks(v); } catch (e) { return; }
      var priced = Object.keys(books).filter(function (n) { return books[n].bid !== null || books[n].ask !== null; });
      if (!priced.length) return;
      if (priced.length > bestN) { bestN = priced.length; best = books; }
    }, 7);
    if (bestN < 2) return null;
    return best;
  }

  /* ============================================================
     7. MODEL
     ============================================================ */

  // One action every 12 s (attemptsPerHour). Each droid survives with probability pSurv and a
  // survivor receives K * (1 + eff% + storage%) of whatever was rolled, where
  // K is different for the rare resource and the commons. With measured data
  // (emp) survival, rare share and both K values come from the action log;
  // otherwise from the starting estimates in model.
  function simulate(droids, model, ctx, emp) {
    var out = {
      attempts: 0, successes: 0, common: 0, rare: 0, count: droids.length, capped: 0,
      rareChance: 0, survival: 0, kCommon: 0, kRare: 0, measured: !!emp
    };
    var pRare = emp ? emp.pRare : clamp(0, 1, (model.baseRare + ctx.bRareChance) / 100);
    var kC = emp && emp.kCommon ? emp.kCommon : model.kCommon;
    var kR = emp && emp.kRare ? emp.kRare : model.kRare;
    out.rareChance = pRare; out.kCommon = kC; out.kRare = kR;
    // Efficiency and storage raise the commons only, not the rare (the
    // game's wiki). The log stores the rare per survivor divided by each
    // droid's factor, as for commons, so the droids' average factor puts it
    // back: same total as before, but it no longer grows with an upgrade.
    var fBar = droids.length ? droids.reduce(function (a, d) { return a + 1 + (d.eff + d.sto) / 100; }, 0) / droids.length : 1;
    out.fBar = fBar;
    var survSum = 0;
    droids.forEach(function (d) {
      var attempts = model.attemptsPerHour;
      var raw = (model.baseDodge + d.man * model.manToDodge + ctx.bDodge) / 100;
      if (raw > 1) out.capped++;
      var pSurv = emp && emp.survival !== null ? emp.survival : clamp(0, 1, raw);
      var f = 1 + (d.eff + d.sto) / 100;
      var succ = attempts * pSurv;
      survSum += pSurv;
      out.attempts += attempts; out.successes += succ;
      out.common += succ * (1 - pRare) * kC * f;
      out.rare += succ * pRare * kR * fBar;
    });
    out.survival = droids.length ? survSum / droids.length : 0;
    return out;
  }

  /* ============================================================
     8. STATE + API BUDGET
     ============================================================ */

  // One-time reset, at the user's request: clears everything saved before
  // it except the anomaly tally. Theme and panel position stay.
  (function resetKeepAnomalies() {
    if (store.get('r3175', false)) return;
    store.set('key', ''); store.set('keySource', 'manual'); store.set('apiHost', null);
    store.set('budget', { used: {}, tripped: {}, nextReset: 0 });
    store.set('marketCache', null); store.set('marketTry', { at: 0, fails: 0 });
    store.set('quotaSyncedAt', 0); store.set('droidPrice', null);
    store.set('acts', []); store.set('battles', []); store.set('lastActKey', null);
    store.set('inputs', {}); store.set('model', {});
    store.set('r3175', true);
  })();

  var S = {
    key: store.get('key', ''),
    inputs: Object.assign({}, DEFAULT_INPUTS, store.get('inputs', {})),
    // Nothing edits the model, so a copy saved by an older version is not
    // read back: it would hold on to numbers the game has since changed.
    model: Object.assign({}, DEFAULT_MODEL),
    budget: store.get('budget', { used: {}, tripped: {}, nextReset: 0 }),
    marketCache: store.get('marketCache', null),   // {t, data}
    books: {}, marketSource: null, marketStamp: null,
    // When the last market call was tried and how many in a row failed. Kept
    // across reloads, so a reload does not skip the wait after a failure.
    marketTry: (function () { var t = store.get('marketTry', null); return t && typeof t.at === 'number' ? { at: t.at, fails: Math.max(0, +t.fails || 0) } : { at: 0, fails: 0 }; })(),
    storeState: null, storeOk: false,
    droids: null,
    apiHost: store.get('apiHost', null),
    lastStoreRead: null, lastErr: null, busy: false,
    authFail: false,
    keySource: store.get('keySource', 'manual'),
    quotaSyncedAt: store.get('quotaSyncedAt', 0),
    credits: null, droidPrice: store.get('droidPrice', null), clonePrice: store.get('clonePrice', null),
    // The last Barracks boost the game loaded (it shows 0 until some screens open)
    barracks: store.get('barracks', null),
    acts: store.get('acts', []),
    lastErrAt: 0,
    battles: (function () { var a = store.get('battles', []); return Array.isArray(a) ? a.filter(function (r) { return r && (r.v === 2 || r.v === 3) && r.o && r.e && typeof r.o.p === 'number' && typeof r.e.p === 'number'; }).sort(function (x, y) { return x.t - y.t; }).slice(-AR_MAX) : []; })(),
    lastActKey: store.get('lastActKey', null),
    gather: null, sources: [],
    anomalies: (function () {
      var o = store.get('anomalies', {}), out = {};
      if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { if (typeof o[k] === 'number' && o[k] > 0) out[k] = o[k]; });
      return out;
    })(),
    anSeen: (function () { var o = store.get('anSeen', {}); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; })(),
    // Galaxy tab. galaxy: one totals object per day. galaxySeenWp: Voyager
    // waypoints already counted, so a reload does not count one again.
    // lastGalaxyKey: the last manual jump logged, so a re-read is not counted
    // twice. lastExploreXp: memory only, to catch the XP jump on a Voyager
    // claim. boxSince: when mystery boxes began to be counted, the first run
    // of a version that listens for them.
    galaxy: (function () { var a = store.get('galaxy', []); return Array.isArray(a) ? a.slice(-GALAXY_MAX_DAYS) : []; })(),
    galaxySeenWp: (function () { var a = store.get('galaxySeenWp', []); return Array.isArray(a) ? a : []; })(),
    lastGalaxyKey: store.get('lastGalaxyKey', null),
    lastExploreXp: null,
    boxSince: (function () {
      var t = store.get('boxSince', 0);
      if (!(typeof t === 'number' && t > 0)) { t = Date.now(); store.set('boxSince', t); }
      return t;
    })()
  };

  var spendErr = null, spendEditing = false;   // Spend box: last message, and whether it has focus
  var keySavedAt = 0;                           // when a key was last typed in, for the confirmation line

  var inputsSaved = null;
  // ingest() runs on every tick; writing identical settings each time was
  // a JSON round trip for nothing.
  function saveInputs() {
    var s;
    try { s = JSON.stringify(S.inputs); } catch (e) { s = null; }
    if (s !== null && s === inputsSaved) return;
    inputsSaved = s;
    store.set('inputs', S.inputs);
  }

  // The next midnight UTC, when the game resets the daily quota.
  function nextResetTime() { return (Math.floor(Date.now() / 86400000) + 1) * 86400000; }

  function rollBudget() {
    if (!S.budget.nextReset || Date.now() >= S.budget.nextReset) {
      S.budget.used = {};
      S.budget.tripped = {};   // a new day clears every tag's circuit breaker too
      S.budget.nextReset = nextResetTime();
      store.set('budget', S.budget);
      return;
    }
    // A saved budget from before the circuit breaker existed, or one loaded
    // fresh on boot before spend() or applyQuota() has run this session,
    // could already be at or past the limit. Trip it here too, so a reload
    // alone is enough - not just the next call that happens to touch it.
    if (!S.budget.tripped) S.budget.tripped = {};
    var lim = limitOf();
    Object.keys(S.budget.used || {}).forEach(function (tag) {
      if (S.budget.used[tag] >= lim && !S.budget.tripped[tag]) { S.budget.tripped[tag] = true; store.set('budget', S.budget); }
    });
  }

  function limitOf() { return S.budget.limit || DAILY_LIMIT; }
  function used(tag) { rollBudget(); return S.budget.used[tag] || 0; }
  function remaining(tag) { return Math.max(0, limitOf() - used(tag)); }

  // Circuit breaker. Once a tag is tripped it stays blocked - scheduled AND
  // manual, every call site - until the next daily reset clears
  // S.budget.tripped in rollBudget(), whatever else in the script does or
  // does not do right. This does not depend on remaining() being read
  // correctly elsewhere; it is the last line of defence, not the first.
  function tripped(tag) { rollBudget(); return !!(S.budget.tripped && S.budget.tripped[tag]); }
  function trip(tag) {
    rollBudget();
    if (!S.budget.tripped) S.budget.tripped = {};
    if (S.budget.tripped[tag]) return;
    S.budget.tripped[tag] = true;
    store.set('budget', S.budget);
  }

  function spend(tag) {
    rollBudget();
    S.budget.used[tag] = (S.budget.used[tag] || 0) + 1;
    if (S.budget.used[tag] >= limitOf()) trip(tag);
    store.set('budget', S.budget);
  }

  function spendable(tag) { return tripped(tag) ? 0 : remaining(tag) - Math.max(0, S.inputs.reserve); }

  // The public price list is a snapshot taken at the top of each hour, so one
  // call a couple of minutes after each hour gets every change: at most 24
  // automatic calls a day, under the 50 limit.
  var HOUR_MS = 3600000, MARKET_AFTER_HOUR = 2 * 60000;
  // The first moment after `t` at which a newer snapshot is out.
  function marketMarkAfter(t) {
    var m = Math.floor(t / HOUR_MS) * HOUR_MS + MARKET_AFTER_HOUR;
    return m > t ? m : m + HOUR_MS;
  }

  // Why automatic market refreshes are on hold right now, for the status
  // line; null when they are not.
  function atTxt(ms) { return whenTxt(ms).replace(/^Today /, ''); }
  function marketHold() {
    if (tripped('market')) return 'Market calls paused until ' + atTxt(S.budget.nextReset) + ' (daily limit reached).';
    if (S.authFail) return 'The server refused the API key' + (S.authMsg ? ' ("' + S.authMsg + '")' : '') + '. See Settings.';
    if (!S.key || !S.inputs.marketAuto) return null;
    var f = S.marketTry.fails || 0;
    if (f && nextMarketAt) return 'Price refresh failed' + (f > 1 ? ' ' + f + ' times in a row' : '') + ', next try at ' + atTxt(nextMarketAt) + '.';
    return null;
  }

  /* ---- the game socket, read only ----
     The game's server talks to the page over one websocket: small
     MessagePack maps, deflated. The script only listens to what arrives
     there and never sends anything on it (the game dev: those routes are
     for the game client only). */

  function pumpStream(stream, bytes) {
    var w = stream.writable.getWriter();
    // Bytes that are not deflate data fail on the reading side, which the
    // caller handles; the writer's own promises fail with it and are dropped
    // here, or the page would log an error for each.
    w.write(bytes).catch(function () {}); w.close().catch(function () {});
    return new Response(stream.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function inflateBytes(u) { return pumpStream(new DecompressionStream('deflate'), u); }

  // Just enough MessagePack to read the game's replies.
  function mpDecode(u) {
    var p = 0, dv = new DataView(u.buffer, u.byteOffset, u.byteLength), td = new TextDecoder();
    function str(n) { var t = td.decode(u.subarray(p, p + n)); p += n; return t; }
    function arr(n) { var a = []; while (n-- > 0) a.push(val()); return a; }
    function map(n) { var o = {}; while (n-- > 0) { var k = val(); o[k] = val(); } return o; }
    function ext(n) {
      var type = dv.getInt8(p), at = p + 1, out = null;
      if (type === -1) {
        if (n === 4) out = dv.getUint32(at) * 1000;
        else if (n === 8) { var hi = dv.getUint32(at), lo = dv.getUint32(at + 4); out = ((hi & 3) * 4294967296 + lo) * 1000; }
        else if (n === 12) out = Number(dv.getBigInt64(at + 4)) * 1000;
      }
      p += 1 + n; return out;
    }
    function val() {
      var b = u[p++], n, v;
      if (b <= 0x7f) return b;
      if (b >= 0xe0) return b - 256;
      if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
      if ((b & 0xf0) === 0x80) return map(b & 0x0f);
      if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
      switch (b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xc4: n = u[p++]; p += n; return null;
        case 0xc5: n = dv.getUint16(p); p += 2 + n; return null;
        case 0xc6: n = dv.getUint32(p); p += 4 + n; return null;
        case 0xc7: n = u[p++]; return ext(n);
        case 0xc8: n = dv.getUint16(p); p += 2; return ext(n);
        case 0xc9: n = dv.getUint32(p); p += 4; return ext(n);
        case 0xca: v = dv.getFloat32(p); p += 4; return v;
        case 0xcb: v = dv.getFloat64(p); p += 8; return v;
        case 0xcc: return u[p++];
        case 0xcd: v = dv.getUint16(p); p += 2; return v;
        case 0xce: v = dv.getUint32(p); p += 4; return v;
        case 0xcf: v = Number(dv.getBigUint64(p)); p += 8; return v;
        case 0xd0: return dv.getInt8(p++);
        case 0xd1: v = dv.getInt16(p); p += 2; return v;
        case 0xd2: v = dv.getInt32(p); p += 4; return v;
        case 0xd3: v = Number(dv.getBigInt64(p)); p += 8; return v;
        case 0xd4: return ext(1);
        case 0xd5: return ext(2);
        case 0xd6: return ext(4);
        case 0xd7: return ext(8);
        case 0xd8: return ext(16);
        case 0xd9: n = u[p++]; return str(n);
        case 0xda: n = dv.getUint16(p); p += 2; return str(n);
        case 0xdb: n = dv.getUint32(p); p += 4; return str(n);
        case 0xdc: n = dv.getUint16(p); p += 2; return arr(n);
        case 0xdd: n = dv.getUint32(p); p += 4; return arr(n);
        case 0xde: n = dv.getUint16(p); p += 2; return map(n);
        case 0xdf: n = dv.getUint32(p); p += 4; return map(n);
      }
      throw new Error('msgpack type ' + b);
    }
    return val();
  }

  function findGameSocket() {
    var cands = [];
    try { var pin = findPinia(); if (pin && pin._s) { var g = pin._s.get('GameStore'); if (g) cands.push(g.game); } } catch (e) {}
    try { cands.push(S.storeState.GameStore.game); } catch (e) {}
    for (var i = 0; i < cands.length; i++) {
      var w = cands[i];
      if (w && typeof w.send === 'function' && typeof w.addEventListener === 'function' && w.readyState === 1) return w;
    }
    return null;
  }

  /* ---- listening to the game's own replies ----
     Some numbers exist only in replies to questions the game itself asks:
     a mystery box rides inside the reply to a publish (Atlas/setSystemPerms)
     or a Voyager claim (Voyager/getVoyagerReward); the next droid's and the
     next clone's price come back when the game's droids or clones panel
     opens. The script reads those replies as they arrive, the same way the
     game does, and sends nothing. Each message is unpacked and searched for
     a few bytes first, so only those replies are decoded; everything else is
     dropped after the search. */

  var SOCKET_KEYS = ['rewardChest', 'getNextDroidPrice', 'getNextClonePrice'].map(function (w) {
    return w.split('').map(function (c) { return c.charCodeAt(0); });
  });
  var boxWs = null;

  function hasBytes(u, pat) {
    for (var i = 0, last = u.length - pat.length; i <= last; i++) {
      if (u[i] !== pat[0]) continue;
      var j = 1;
      while (j < pat.length && u[i + j] === pat[j]) j++;
      if (j === pat.length) return true;
    }
    return false;
  }

  function onBoxMsg(ev) {
    var d = ev && ev.data;
    if (!d || typeof d === 'string') return;
    Promise.resolve(d instanceof Blob ? d.arrayBuffer() : d).then(function (buf) {
      return buf instanceof ArrayBuffer ? inflateBytes(new Uint8Array(buf)) : null;
    }).then(function (u) {
      if (u && SOCKET_KEYS.some(function (k) { return hasBytes(u, k); })) stage('reading a game reply', function () { logSocketReply(mpDecode(u)); });
    }).catch(function () {});   // not a game message: nothing to read
  }

  // {classname, method, value}: a price reply's value is the price itself.
  function logSocketReply(m) {
    if (!m || typeof m !== 'object') return;
    var price = numOr(m.value);
    if (m.method === 'getNextDroidPrice' && (!m.classname || m.classname === 'Gathering')) {
      if (price > 0) { S.droidPrice = { v: price, t: Date.now(), n: S.droids ? S.droids.length : 0 }; store.set('droidPrice', S.droidPrice); }
      return;
    }
    if (m.method === 'getNextClonePrice' && (!m.classname || m.classname === 'Battling')) {
      var n = cloneCount();
      if (price > 0) { S.clonePrice = { v: price, t: Date.now(), n: n }; store.set('clonePrice', S.clonePrice); }
      return;
    }
    logGalaxyReply(m);
  }

  // Run on every update: after a reconnect the game has a new socket.
  function boxListen() {
    if (typeof DecompressionStream === 'undefined') return;
    var ws = findGameSocket();
    if (!ws || ws === boxWs) return;
    boxWs = ws;
    ws.addEventListener('message', onBoxMsg);
  }

  /* ---- the game's own count, from the Profile page ----
     The Profile page, tab "Game API", shows the server's count as text.
     When the player has it open, the script reads it there (reading only,
     no clicks) and trusts it over its own count, which only knows the calls
     this script made. */

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function parseGameDate(txt) {
    var m = String(txt || '').match(/(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
    return new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5], 0, 0).getTime();
  }

  function parseQuotaText(text) {
    text = String(text || '');
    var at = text.indexOf('Daily usage');
    if (at < 0) return null;
    var lines = text.slice(at).split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    var usedMap = {}, limit = null, reset = null, n = 0;
    for (var i = 0; i < lines.length; i++) {
      var one = lines[i].match(/^\/([a-z]+)\s+(\d+)\s*\/\s*(\d+)$/i);
      if (one) { usedMap[one[1].toLowerCase()] = +one[2]; limit = +one[3]; n++; continue; }
      var ep = lines[i].match(/^\/([a-z]+)$/i), val = ep && lines[i + 1] && lines[i + 1].match(/^(\d+)\s*\/\s*(\d+)$/);
      if (val) { usedMap[ep[1].toLowerCase()] = +val[1]; limit = +val[2]; n++; i++; continue; }
      var rs = lines[i].match(/^Resets\b\s*(.*)$/i);
      if (rs) reset = parseGameDate(rs[1] || lines[i + 1]);
    }
    return n ? { used: usedMap, limit: limit, reset: reset } : null;
  }

  function applyQuota(q) {
    rollBudget();
    S.budget.used = q.used;
    if (q.limit) S.budget.limit = q.limit;
    if (q.reset && q.reset > Date.now()) S.budget.nextReset = q.reset;
    // The server's count can already be at or past the limit without this
    // script's spend() ever running, so the breaker is set here too.
    var lim = limitOf();
    Object.keys(S.budget.used || {}).forEach(function (tag) { if (S.budget.used[tag] >= lim) trip(tag); });
    S.quotaSyncedAt = Date.now();
    store.set('budget', S.budget); store.set('quotaSyncedAt', S.quotaSyncedAt);
    scheduleMarket();
  }

  function readQuotaFromPage() {
    try {
      var el = document.querySelector('main') || document.body;
      var q = el && parseQuotaText(el.innerText);
      if (!q) return false;
      applyQuota(q);
      return true;
    } catch (e) { return false; }
  }

  /* ============================================================
     9. NETWORK  (only ever called for the market)
     ============================================================ */

  function parseRateHeaders(raw) {
    if (!raw) return null;
    var out = {};
    String(raw).split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^([^:]+):\s*(.*)$/);
      if (!m) return;
      var k = m[1].toLowerCase().trim();
      if (/ratelimit|rate-limit|quota|x-usage|reset|x-daily|etag|cache-control|retry-after/.test(k)) out[k] = m[2].trim();
    });
    return Object.keys(out).length ? out : null;
  }

  // X-Daily-Reset (sent with a 429, per the game's dev) says when the daily
  // count starts again. Its exact format has not been seen yet, so a date,
  // epoch seconds or milliseconds, or a number of seconds from now are all
  // accepted. Anything that does not land within the next 48 hours is ignored
  // and the normal reset time applies.
  function resetFromHeader(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim(), t;
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) { var n = +s; t = n > 1e12 ? n : (n > 1e9 ? n * 1000 : Date.now() + n * 1000); }
    else t = Date.parse(s);
    if (!isFinite(t) || t <= Date.now() || t > Date.now() + 48 * 3600000) return null;
    return Math.round(t);
  }

  // extra: more request headers (If-None-Match, for a free 304).
  // Cache-Control's max-age counts down to the next hourly snapshot (the
  // docs); the moment it lands, or 0 when the header is not there.
  function validFrom(H) {
    var m = /max-age=(\d+)/.exec(String((H && H['cache-control']) || ''));
    return m ? Date.now() + (+m[1]) * 1000 : 0;
  }

  function httpGet(url, key, extra) {
    return new Promise(function (resolve, reject) {
      var headers = { 'Accept': 'application/json' };
      if (key) headers['sodyssey-api-key'] = key;
      Object.keys(extra || {}).forEach(function (h) { if (extra[h]) headers[h] = extra[h]; });
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url: url, headers: headers, timeout: 20000,
          onload: function (r) { resolve({ status: r.status, text: r.responseText, headers: parseRateHeaders(r.responseHeaders) }); },
          onerror: function () { reject(new Error('network')); },
          ontimeout: function () { reject(new Error('timeout')); }
        });
        return;
      }
      var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 20000);
      fetch(url, { headers: headers, credentials: 'omit', signal: ctl.signal })
        .then(function (r) { return r.text().then(function (x) { clearTimeout(t); resolve({ status: r.status, text: x, headers: null }); }); })
        .catch(function (e) { clearTimeout(t); reject(e); });
    });
  }

  // One call = one quota unit. Once a host has answered, only that host is
  // tried: falling back to the other one inside the same refresh would spend
  // a second call. If it fails, the next refresh starts from the other host
  // instead, in case this one is down. Both are tried in one refresh only
  // until one of them has ever worked.
  //
  // Each step uses then(onOk, onErr) rather than .then().catch(). With the
  // two-argument form, onErr only sees a rejection from THIS httpGet. With
  // .catch() it also caught the rejection of the recursive call inside onOk,
  // which re-entered the retry and fanned one refresh out into a dozen live
  // requests, each one spending quota.
  function apiGet(path, tag) {
    rollBudget();
    // The circuit breaker (trip/tripped) is checked here too, not only in
    // refreshMarket: this is the function that actually makes the HTTP
    // call, so it is the one call site every caller, present or future,
    // passes through - the real last line of defence.
    if (tripped(tag)) return Promise.reject(new Error('/' + tag + ' quota tripped for today'));
    if (S.authFail) return Promise.reject(new Error('the API refused this key. Fix it in Settings, then retry.'));
    if (!S.key) return Promise.reject(new Error('no API key set. Open Settings and paste your key.'));
    if (remaining(tag) <= 0) { trip(tag); return Promise.reject(new Error('daily quota for /' + tag + ' is used up')); }

    // A remembered host from the other realm (saved before the realm was
    // read from the page) would refuse this realm's key for ever: forget it.
    if (S.apiHost && S.apiHost !== REALM_HOST) { S.apiHost = null; store.set('apiHost', null); }
    var order = S.apiHost ? [S.apiHost] : HOSTS.slice();
    var errs = [], i = 0;

    function step() {
      if (i >= order.length) {
        if (S.apiHost) { S.apiHost = HOSTS[(HOSTS.indexOf(S.apiHost) + 1) % HOSTS.length]; store.set('apiHost', S.apiHost); }
        return Promise.reject(new Error(errs.join(' | ')));
      }
      if (tripped(tag) || remaining(tag) <= 0) { trip(tag); return Promise.reject(new Error('quota exhausted')); }
      var host = order[i++], short = host.replace(/^https:\/\//, '');

      // Counted before it is sent, whatever comes back: the server counts a
      // call even when its reply never reaches us (a dropped connection, a
      // timeout). Counted only on a reply, failed calls would go uncounted.
      spend(tag);
      // The ETag of the last answer goes back as If-None-Match: while the
      // hourly snapshot stands the server answers 304, free of charge (its
      // docs), and the count below is refunded.
      var etag = tag === 'market' && S.marketCache && S.marketCache.etag;
      return httpGet(host + path, S.key, etag ? { 'If-None-Match': etag } : null).then(function (r) {
        var H = r.headers || {}, body = null;
        try { body = r.text ? JSON.parse(r.text) : null; } catch (e) { body = null; }
        // The server states the day's budget on every answer: take its word
        // over the script's own count.
        var lim = numOr(H['x-daily-limit']), rem = numOr(H['x-daily-remaining']), rst = resetFromHeader(H['x-daily-reset']);
        if (lim !== null && rem !== null) {
          S.budget.limit = lim; S.budget.used[tag] = Math.max(0, lim - rem);
          if (rst) S.budget.nextReset = rst;
          if (rem <= 0) trip(tag); else if (S.budget.tripped && S.budget.tripped[tag]) { delete S.budget.tripped[tag]; }
          store.set('budget', S.budget);
        }
        // 401/403 is the key being refused, not the host being wrong. The
        // other host answers identically, so stop rather than spend again.
        // The server's own words are kept for the Settings tab and the report.
        if (r.status === 401 || r.status === 403) {
          var msg = (body && body.msg) || ('HTTP ' + r.status), ban = body && numOr(body.bannedUntil);
          S.authFail = true; S.authMsg = msg; S.authAt = Date.now(); S.bannedUntil = ban > 0 ? ban * 1000 : 0;
          throw new Error('the API refused the key: "' + msg + '"' + (S.bannedUntil ? ', suspended until ' + atTxt(S.bannedUntil) : '') + '. Stopped without retrying.');
        }
        // The server's own "no more today": stop every call of this kind until
        // the reset time it sends back, as the game's dev asked. Retry-After
        // and resetsAt say when; a 429 can also be the 5-a-second burst guard.
        if (r.status === 429) {
          var until = resetFromHeader(H['x-daily-reset']) || resetFromHeader(body && body.resetsAt) || resetFromHeader(H['retry-after']);
          if (until) { S.budget.nextReset = until; store.set('budget', S.budget); }
          trip(tag);
          throw new Error('the server says the daily limit is reached (429' + ((body && body.msg) ? ', "' + body.msg + '"' : '') + ')');
        }
        if (r.status === 304) {
          // Unchanged, and not charged: give the unit back.
          S.budget.used[tag] = Math.max(0, (S.budget.used[tag] || 0) - (lim !== null ? 0 : 1)); store.set('budget', S.budget);
          S.apiHost = host; store.set('apiHost', S.apiHost);
          return { unchanged: true, validUntil: validFrom(H) };
        }
        if (r.status !== 200) { errs.push(short + ' HTTP ' + r.status); return step(); }
        if (!body || typeof body !== 'object') { errs.push(short + ' non-JSON body'); return step(); }

        S.apiHost = host; store.set('apiHost', S.apiHost);
        return { data: body, etag: H.etag || null, validUntil: validFrom(H) };
      }, function (netErr) {
        errs.push(short + ' ' + (netErr.message || 'network'));
        return step();
      });
    }
    return step();
  }

  /* ============================================================
     10. REFRESH PATHS
     ============================================================ */

  function setErr(msg) { S.lastErr = msg || null; S.lastErrAt = msg ? Date.now() : 0; }

  // Runs one stage of a tick. A failure is recorded and the tick goes on, so
  // one throwing property cannot stop the script.
  function stage(what, fn) {
    try { return fn(); } catch (e) { setErr(what + ' failed: ' + ((e && e.message) || e)); return null; }
  }

  var lastMarketScan = 0, marketSig = null;

  // What the prices look like now, so their age only restarts when they move.
  function bookSig(books) {
    var k = Object.keys(books).sort(), out = [];
    for (var i = 0; i < k.length && i < 30; i++) out.push(k[i] + ':' + books[k[i]].bid + '/' + books[k[i]].ask);
    return out.join(',');
  }

  function refreshFromStore() {
    var st = stage('reading the page', readStoreState);
    if (!st) { S.storeOk = false; return false; }
    S.storeState = st; S.storeOk = true;
    S.lastStoreRead = Date.now();
    stage('reading the game state', function () { ingest(st); });
    // Prices come from the market API. The game keeps none in its memory
    // (its MarketStore holds only what the Market screen is showing), so
    // only that store is searched, once a minute, in case it ever does: a
    // search of the whole state took about 55 ms a time on a real account.
    if (Date.now() - lastMarketScan >= 60000) {
      lastMarketScan = Date.now();
      stage('reading prices', function () {
        var mb = marketFromStore(st.MarketStore);
        if (!mb || !Object.keys(mb).length) return;
        // The Market screen shows a part of the market (one category, say),
        // so its prices are merged into the book name by name, never put in
        // place of it: replacing it dropped every name the screen did not
        // show until the next API call. The API's stamp and schedule are left
        // alone too; a page read is a top-up, not a refresh.
        var sig = bookSig(mb), changed = false;
        Object.keys(mb).forEach(function (k) { if (S.books[k] !== mb[k]) { S.books[k] = mb[k]; changed = true; } });
        if (changed && !/page store/.test(S.marketSource || '')) S.marketSource = (S.marketSource ? S.marketSource + ' + ' : '') + 'page store';
        if (sig !== marketSig) { marketSig = sig; if (!S.marketStamp) S.marketStamp = Date.now(); }
      });
    }
    return true;
  }

  function ingest(root) {
    // Pick up the key from the game itself, unless one was typed in. A typed
    // key the server refuses gives way to the game's own key when that one
    // differs: a key regenerated in the game is the usual reason for the
    // refusal, and the game always holds the current one.
    var k = readApiKey(root);
    if (k) S.gameKey = k;
    if (k && k !== S.key && (!S.key || S.keySource === 'auto' || S.authFail)) {
      S.key = k; S.keySource = 'auto'; S.authFail = false; S.authMsg = null; S.bannedUntil = 0;
      store.set('key', S.key); store.set('keySource', S.keySource);
      S.marketTry.fails = 0; store.set('marketTry', S.marketTry);   // a new key starts with no back-off
      scheduleMarket();
    }

    try { var cr = numOr(root.CurrencyStore.credits); if (cr !== null) S.credits = cr; } catch (e) {}

    var gl = readGatheringLevel(root);
    if (gl !== null) S.inputs.gatheringLevel = gl;

    var droids = readDroids(root);
    if (droids && droids.length) {
      S.droids = droids;
      var use = S.inputs.activeOnly ? droids.filter(function (d) { return d.active; }) : droids;
      if (!use.length) use = droids;
      S.inputs.droidCount = use.length;
      S.inputs.droidEff = use.reduce(function (a, d) { return a + d.eff; }, 0) / use.length;
      S.inputs.droidSto = use.reduce(function (a, d) { return a + d.sto; }, 0) / use.length;
      S.inputs.droidMan = use.reduce(function (a, d) { return a + d.man; }, 0) / use.length;
    }

    // What is being gathered right now, and the result of the last action.
    // Droids are read above, so the log normalises against current stats.
    var gth = readGather(root);
    if (gth) {
      S.gather = gth;
      var bodyNode = gth.body && gth.body.nodeType ? String(gth.body.nodeType).toLowerCase() : null;
      if (S.inputs.autoNode && gth.isGathering && bodyNode && NODES[bodyNode]) S.inputs.node = bodyNode;
      logAction(gth);
    }
    logGalaxyManual(root);
    logGalaxyVoyager(root);
    var src = resourceSources(root);
    if (src.length) S.sources = src;

    // Overwrite the totals whenever the equipped-gear scan was possible,
    // even if it matched nothing. Otherwise an old inflated value saved by
    // a previous version would never be corrected.
    var scan = scanBonuses(root);
    if (scan.matched || scan.authoritative) {
      Object.keys(scan.totals).forEach(function (k) { S.inputs[k] = scan.totals[k]; });
    }

    saveInputs();
  }

  // force: the Refresh button (spends the reserve, skips the wait after a
  // failure).
  function refreshMarket(force) {
    if (S.busy) return Promise.resolve();
    rollBudget();
    // Checked before the force flag can skip anything below: once tripped,
    // nothing spends again today, scheduled or manual, until the reset. The
    // status line (marketHold) says why and until when.
    if (tripped('market')) { render(); return Promise.resolve(); }
    // The Refresh button is the player saying "try the key again": a refusal
    // is forgotten, unless the server said the key is suspended until a time
    // that has not come (calling during a suspension does nothing, its docs).
    if (force && S.authFail) {
      if (S.bannedUntil > Date.now()) { setErr('the key is suspended until ' + atTxt(S.bannedUntil) + '; calling before then does nothing'); render(); return Promise.resolve(); }
      S.authFail = false; S.authMsg = null;
    }
    if (!force && spendable('market') <= 0) { setErr('market budget spent (reserve held back)'); render(); return Promise.resolve(); }
    if (remaining('market') <= 0) { trip('market'); render(); return Promise.resolve(); }
    S.busy = true; setErr(null); render();
    S.marketTry.at = Date.now(); store.set('marketTry', S.marketTry);
    return apiGet(PATHS.market, 'market').then(function (res) {
      S.marketTry.fails = 0; store.set('marketTry', S.marketTry);
      if (res.unchanged) {
        // The snapshot has not moved since the one in the cache: it stays,
        // and only the moment the next one is due is taken from the answer.
        if (S.marketCache) { S.marketCache.validUntil = res.validUntil || S.marketCache.validUntil || 0; store.set('marketCache', S.marketCache); }
        return;
      }
      S.books = buildBooks(res.data);
      S.marketSource = 'api (' + (S.apiHost || '').replace(/^https:\/\//, '') + ')';
      S.marketStamp = Date.now();
      S.marketCache = { t: Date.now(), data: res.data, etag: res.etag, validUntil: res.validUntil || 0 };
      store.set('marketCache', S.marketCache);
    }).catch(function (e) {
      S.marketTry.fails = (S.marketTry.fails || 0) + 1; store.set('marketTry', S.marketTry);
      setErr(e.message || String(e));
    })
      .then(function () { S.busy = false; scheduleMarket(); render(); });
  }

  function loadCachedMarket() {
    if (S.marketCache && S.marketCache.data) {
      S.books = buildBooks(S.marketCache.data);
      S.marketSource = 'cache';
      S.marketStamp = S.marketCache.t;
    }
  }

  /* ============================================================
     12. PROJECTION
     ============================================================ */

  function effectiveDroids() {
    if (S.inputs.autofill && S.droids && S.droids.length) {
      var use = S.inputs.activeOnly ? S.droids.filter(function (d) { return d.active; }) : S.droids;
      if (use.length) return use;
    }
    var n = Math.max(0, Math.round(S.inputs.droidCount)), arr = [];
    for (var i = 0; i < n; i++) arr.push({ eff: S.inputs.droidEff, sto: S.inputs.droidSto, man: S.inputs.droidMan, active: true });
    return arr;
  }

  function ctxOf() {
    return {
      bRareChance: S.inputs.bRareChance, bRareAmount: S.inputs.bRareAmount,
      bGatherYield: S.inputs.bGatherYield, bNodeQuality: S.inputs.bNodeQuality, bDodge: S.inputs.bDodge
    };
  }

  // How sim.common (the combined rate for the four common resources) splits
  // between them. Even, until enough actions are logged on this node to
  // measure it (same threshold as the rest of the model, S.inputs.minActions);
  // then each resource's own share of the logged common actions, so a
  // resource that actually drops more often shows a higher rate.
  function commonShares(node, st) {
    var n = node.commons.length, even = 1 / n;
    if (!st || st.n < S.inputs.minActions) return node.commons.map(function () { return even; });
    var total = 0;
    node.commons.forEach(function (r) { total += st.perRes[normName(r)] || 0; });
    if (!total) return node.commons.map(function () { return even; });
    return node.commons.map(function (r) { return (st.perRes[normName(r)] || 0) / total; });
  }

  function projection() {
    var droids = effectiveDroids();
    var emp = empirical();
    var sim = simulate(droids, S.model, ctxOf(), emp);
    var node = NODES[S.inputs.node] || NODES.crystal;
    var st = actionStats(S.inputs.node), shares = commonShares(node, st);
    var rows = node.commons.map(function (n, i) { return { name: n, qty: sim.common * shares[i] }; });
    rows.push({ name: node.rare, qty: sim.rare });
    return { sim: sim, node: node, rows: rows, emp: emp, st: st, exact: S.inputs.autofill && !!(S.droids && S.droids.length) };
  }

  /* ============================================================
     12b. UPGRADE SUGGESTIONS
     ============================================================ */

  // Price of the next 0.1 on a droid stat that is now at t tenths. This is the
  // game's own formula (droidUpgradeCost in its code), the same for
  // efficiency, storage and maneuverability.
  function stepCost(t) { var i = (t + 1) / 10; return 5000 * i * Math.exp(0.15 * i); }

  // Credits per unit sold, per resource, at the depth the yield tile uses.
  function unitPrices(p) {
    var hours = Math.max(1, S.inputs.hours), vC = 0, nC = 0, vR = null, bad = false;
    p.rows.forEach(function (r, i) {
      var b = bookFor(S.books, r.name), f = fillAgainst(b.bidDepth, r.qty * hours), px = null;
      if (f && r.qty > 0) px = f.total / (r.qty * hours);
      else if (b.bid !== null) px = b.bid;
      if (px === null) { bad = true; return; }
      if (i === p.rows.length - 1) vR = px; else { vC += px; nC++; }
    });
    return bad || !nC ? null : { vC: vC / nC, vR: vR };
  }

  function durFmt(h) {
    if (h === null || !isFinite(h)) return '--';
    if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h';
    var d = h / 24;
    if (d < 365) return (d < 10 ? d.toFixed(1) : Math.round(d)) + ' d';
    return '> 1 y';
  }

  // Everything the suggestions need, or null when the game state is unknown.
  function upgradeContext() {
    if (!S.droids || !S.droids.length) return null;
    var ds = effectiveDroids();
    if (!ds.length || !ds[0].idx) return null;
    var p = projection(), px = unitPrices(p);
    if (!px) return { need: 'prices' };
    var sim = p.sim;
    var mean = function (k) { return ds.reduce(function (a, d) { return a + d[k]; }, 0) / ds.length; };
    return {
      ds: ds, p: p, px: px, att: S.model.attemptsPerHour,
      U: (1 - sim.rareChance) * sim.kCommon * px.vC,             // commons: credits per surviving droid, per unit of (1 + eff + sto)
      R: sim.rareChance * sim.kRare * sim.fBar * px.vR,           // the rare: credits per surviving droid, flat
      avgMan: mean('man'), avgEff: mean('eff'), avgSto: mean('sto'), avgSurv: sim.survival,
      slope: S.model.manToDodge / 100
    };
  }

  // Spend credits one 0.1 step at a time, always on the droid stat with the
  // fastest payback. Prices only rise, so this order is the best split.
  function upgradePlan(cx) {
    var att = cx.att, U = cx.U, R = cx.R;
    var cap = Math.max(1, S.inputs.maxPaybackDays) * 24;
    var avail = Math.max(0, (S.credits || 0) - Math.max(0, S.inputs.keepCredits)), lim = S.inputs.spendLimit > 0 ? S.inputs.spendLimit : 0;
    var budget = lim ? Math.min(avail, lim) : avail;
    var st = cx.ds.map(function (d) {
      return { d: d, t: [Math.round(d.eff * 10), Math.round(d.sto * 10), Math.round(d.man * 10)],
               t0: [Math.round(d.eff * 10), Math.round(d.sto * 10), Math.round(d.man * 10)], cost: 0, c: [] };
    });
    function surv(x) { return clamp(0, 1, cx.avgSurv + (x.t[2] / 10 - cx.avgMan) * cx.slope); }
    function perSurv(x) { return U * (1 + (x.t[0] + x.t[1]) / 1000) + R; }
    function income(x) { return att * surv(x) * perSurv(x); }
    function gain(x, j) {
      if (j < 2) return att * surv(x) * U * 0.001;
      if (surv(x) >= 1) return 0;
      return att * cx.slope * 0.1 * perSurv(x);
    }
    function refresh(x) {
      for (var j = 0; j < 3; j++) {
        var c = x.c[j] || (x.c[j] = { x: x, j: j });
        c.cost = stepCost(x.t[j]); c.g = gain(x, j); c.r = c.g / c.cost;
      }
    }
    var base = 0, cands = [];
    st.forEach(function (x) { base += income(x); refresh(x); x.c.forEach(function (c) { cands.push(c); }); });

    var spent = 0, steps = 0, first = null, last = null, stop = 'none';
    while (steps < 20000) {
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (c.g <= 0 || spent + c.cost > budget) continue;
        if (!best || c.r > best.r) best = c;
      }
      if (!best) { stop = 'budget'; break; }
      if (best.cost / best.g > cap) { stop = 'payback'; break; }
      spent += best.cost; best.x.cost += best.cost;
      if (!first) first = best.cost / best.g;
      last = best.cost / best.g;
      best.x.t[best.j]++; steps++;
      refresh(best.x);
    }
    var after = 0; st.forEach(function (x) { after += income(x); });
    var rows = st.map(function (x) {
      return { idx: x.d.idx, from: x.t0.map(function (v) { return v / 10; }), to: x.t.map(function (v) { return v / 10; }), cost: Math.ceil(x.cost) };
    });
    return {
      rows: rows, base: base, gain: after - base, cost: Math.ceil(spent), steps: steps,
      payback: after - base > 0 ? spent / (after - base) : null, first: first, last: last, budget: budget, avail: avail, limit: lim, stop: stop
    };
  }

  // The next droid (price: nextDroidPrice). A new droid is assumed to start
  // at 0% and to be levelled to the average of the current ones.
  function droidOption(cx) {
    var dp = nextDroidPrice();
    if (!dp) return null;
    function level(target) { var c = 0; for (var t = 0; t < Math.round(target * 10); t++) c += stepCost(t); return c; }
    var lv = level(cx.avgEff) + level(cx.avgSto) + level(cx.avgMan);
    var gain = cx.att * clamp(0, 1, cx.avgSurv) * (cx.U * (1 + (cx.avgEff + cx.avgSto) / 100) + cx.R);
    var cost = dp.v + lv;
    return { n: (S.droids ? S.droids.length : 0) + 1, price: dp.v, est: dp.est, level: lv, cost: cost, gain: gain, payback: gain > 0 ? cost / gain : null };
  }

  // The game asks for this price itself when the droids panel opens; the
  // socket listener keeps its answer (logSocketReply). Until one is seen, or
  // for a count of droids it was not seen at, each droid costs ten times the
  // one before (the user's rule: droid 8 = 100B, droid 9 = 1T).
  var DROID8_PRICE = 1e11;
  function nextDroidPrice() {
    var n = S.droids ? S.droids.length : 0, dp = S.droidPrice;
    if (dp && dp.v > 0 && dp.n === n) return { v: dp.v, est: false };
    if (dp && dp.v > 0 && dp.n > 0) return { v: dp.v * Math.pow(10, n - dp.n), est: true };
    return n > 0 ? { v: DROID8_PRICE * Math.pow(10, n - 7), est: true } : null;
  }

  /* ============================================================
     12c. BATTLEFIELD  (PvP build data and the parts a build is made of)

     Facts taken from the game (its own code and its wiki):
       gear piece value   100 * level * (1 + tier/100 + craftingLevel/100),
                          added to the piece's active stat
       damage             (power + Velari*50 + gear power) * clones
       health             (hull  + Velari*50 + gear hull) * 7 * clones
       hit chance         precision / (precision + evasion)
       skills             every gear piece on a skill adds 5% to it, 2.5% for
                          Focus. Stun: the target loses its next round. Block:
                          cancels a whole attack. Focus: all clones shoot one
                          marked clone. DoT: 3 charges, each 50% of base damage.
       level upgrade      20 * (L+1) * (L+2) of the piece's material
       tier upgrade       10 * (T+1) * (T+2) PvP badges
     The game has squadron fights and 1-on-1 arena duels; the planner (12f)
     works from the arena duels you record. The stat points and gear here are
     the parts of a build that can be changed.
     ============================================================ */

  var PVP_STATS = ['power', 'precision', 'evasion', 'hull'];
  var PVP_SKILLS = ['dot', 'focus', 'stun', 'block'];
  var PVP_HP_MULT = 7;
  var CLONE_CRIT_BASE = 30;

  function readPvp(root) {
    try {
      var P = root.UserStore.player, gear = P.pvp_gear, ps = P.pvpstats;
      if (!Array.isArray(gear) || !gear.length || !ps) return null;
      var pts = {}, pool = numOr(ps.available) || 0;
      PVP_STATS.forEach(function (s) { pts[s] = numOr(ps[s]) || 0; pool += pts[s]; });
      var craft = 0;
      try { craft = numOr(root.CraftStore.crafting_level) || 0; } catch (e) {}
      var vel = (slottedPetLevel(root, 'Velari') || 0) * 50;
      var mats = matsHeld(root);
      var clones = (P.clones || []).map(function (c) {
        return { crit: (numOr(c.critical_chance) || 0) / 100, cm: 1 + (CLONE_CRIT_BASE + (numOr(c.critical_damage) || 0)) / 100, dual: (numOr(c.dual_shot) || 0) / 100 };
      });
      var badges = 0;
      try { badges = numOr(root.UserStore.pvp_badges) || 0; } catch (e) {}
      return {
        pts: pts, pool: pool, craft: craft, vel: vel, mats: mats, badges: badges, clones: clones, N: Math.max(1, clones.length),
        gear: gear.map(function (g) {
          return { name: String(g.name), stat: g.stat, skill: g.skill, L: numOr(g.statLevel) || 0, T: numOr(g.statTier) || 0, mat: String(g.statCost || '').toLowerCase() };
        })
      };
    } catch (e) { return null; }
  }

  function pvCopy(b) {
    var o = Object.assign({}, b);
    o.pts = Object.assign({}, b.pts);
    o.gear = b.gear.map(function (g) { return Object.assign({}, g); });
    o.mats = Object.assign({}, b.mats);
    return o;
  }

  function pvGearVal(g, craft) { return 100 * g.L * (1 + g.T / 100 + craft / 100); }
  function pvLevelCost(L) { return 20 * (L + 1) * (L + 2); }
  function pvTierCost(T) { return 10 * (T + 1) * (T + 2); }

  function pvGearBase(b) {
    var t = { power: b.vel, precision: b.vel, evasion: b.vel, hull: b.vel };
    b.gear.forEach(function (g) { if (t[g.stat] !== undefined) t[g.stat] += pvGearVal(g, b.craft); });
    return t;
  }

  function pvTotals(b) {
    var t = pvGearBase(b);
    PVP_STATS.forEach(function (s) { t[s] += b.pts[s] || 0; });
    t.damage = Math.floor(t.power * b.N);
    t.hp = Math.floor(t.hull * b.N * PVP_HP_MULT);
    return t;
  }

  function pvSkills(gear) {
    var c = { dot: 0, focus: 0, stun: 0, block: 0 };
    gear.forEach(function (g) { if (c[g.skill] !== undefined) c[g.skill] += g.skill === 'focus' ? 0.025 : 0.05; });
    return c;
  }

  // Strength of a build against a reference opponent, on a log scale:
  // damage x health x (my hit chance / their hit chance). Each stat enters on
  // its own, so spending points one at a time on the best stat is optimal.
  function pvTerm(s, x, ref) {
    x = Math.max(x, 1);
    if (s === 'precision') return Math.log(x) - Math.log(x + ref.evasion);
    if (s === 'evasion') return Math.log(ref.precision + x);
    return Math.log(x);
  }

  // Best split of the points. Each stat's gain flattens out, so the best split
  // is where every stat that gets points has the same marginal gain. That level
  // is found by bisection, then the rounding is finished one point at a time.
  function pvAllocate(b, ref) {
    var base = pvGearBase(b), pool = Math.max(0, Math.round(b.pool)), R = ref.evasion, Q = ref.precision;
    function level(s, lam) {
      if (s === 'precision') return R > 0 ? (-R + Math.sqrt(R * R + 4 * R / lam)) / 2 : 0;
      if (s === 'evasion') return 1 / lam - Q;
      return 1 / lam;
    }
    function want(lam) {
      var t = 0;
      PVP_STATS.forEach(function (s) { t += Math.max(0, level(s, lam) - base[s]); });
      return t;
    }
    var lo = 1e-12, hi = 1, i;
    for (i = 0; i < 90; i++) { var mid = Math.sqrt(lo * hi); if (want(mid) > pool) lo = mid; else hi = mid; }
    var pts = {}, used = 0;
    PVP_STATS.forEach(function (s) { pts[s] = Math.max(0, Math.floor(level(s, hi) - base[s])); used += pts[s]; });
    while (used > pool) {   // rounding guard
      var big = PVP_STATS.slice().sort(function (x, y) { return pts[y] - pts[x]; })[0];
      pts[big]--; used--;
    }
    while (used < pool) {
      var best = null, bg = -Infinity;
      PVP_STATS.forEach(function (s) {
        var x = base[s] + pts[s], g = pvTerm(s, x + 1, ref) - pvTerm(s, x, ref);
        if (g > bg) { bg = g; best = s; }
      });
      pts[best]++; used++;
    }
    return pts;
  }

  function pvScore(b, ref) {
    var t = pvTotals(b);
    return pvTerm('power', t.power, ref) + pvTerm('hull', t.hull, ref) + pvTerm('precision', t.precision, ref) + pvTerm('evasion', t.evasion, ref);
  }

  // All ways of giving each piece an active stat, each with its best points.
  function pvBestAssign(b, ref) {
    var n = b.gear.length, total = Math.pow(PVP_STATS.length, n), best = null;
    for (var a = 0; a < total; a++) {
      var c = pvCopy(b), x = a;
      for (var i = 0; i < n; i++) { c.gear[i].stat = PVP_STATS[x % PVP_STATS.length]; x = Math.floor(x / PVP_STATS.length); }
      c.pts = pvAllocate(c, ref);
      c.score = pvScore(c, ref);
      if (!best || c.score > best.score + 1e-12) best = c;
    }
    return best;
  }

  // Spend materials on levels and badges on tiers, always taking what adds
  // the most stat for the cost. Returns the upgraded gear and what was spent.
  function pvSpend(b, keepBadges) {
    var g2 = b.gear.map(function (g) { return Object.assign({}, g); }), mats = Object.assign({}, b.mats), badges = Math.max(0, b.badges - Math.max(0, keepBadges || 0));
    var steps = [];
    g2.forEach(function (g, i) {
      var from = g.L, cost = 0;
      while ((mats[g.mat] || 0) >= pvLevelCost(g.L)) { var c = pvLevelCost(g.L); mats[g.mat] -= c; cost += c; g.L++; }
      if (g.L > from) steps.push({ i: i, name: g.name, kind: 'level', from: from, to: g.L, cost: cost, res: g.mat });
    });
    var tierFrom = g2.map(function (g) { return g.T; }), tierCost = g2.map(function () { return 0; });
    for (;;) {
      var pick = -1, br = Infinity;
      g2.forEach(function (g, i) { var c = pvTierCost(g.T); if (c <= badges && g.L > 0 && c / g.L < br) { br = c / g.L; pick = i; } });
      if (pick < 0) break;
      var c2 = pvTierCost(g2[pick].T); badges -= c2; tierCost[pick] += c2; g2[pick].T++;
    }
    g2.forEach(function (g, i) { if (g.T > tierFrom[i]) steps.push({ i: i, name: g.name, kind: 'tier', from: tierFrom[i], to: g.T, cost: tierCost[i], res: 'badges' }); });
    return { gear: g2, steps: steps };
  }

  /* ---- random numbers ---- */

  // One random stream per kind of roll (hit, crit, block...), each seeded
  // from the one seed. Every roll of a kind is then the n-th number of its
  // own stream whatever else happened, so two builds fighting the same
  // opponent on the same seed really do get the same luck: with a single
  // stream, the first build that skipped a roll (no block skill, say) put
  // every later roll out of step and the pairing between builds was lost.
  // The fights consume every roll of a shot whether or not it is needed,
  // for the same reason.
  function rngStreams(seed, names) {
    var out = {};
    names.forEach(function (n, k) { out[n] = btRng((seed | 0) ^ Math.imul(k + 1, 0x9E3779B9)); });
    return out;
  }


  /* ============================================================
     12d. INFERRING A STAT FROM HIT RATES

     A swing either lands or misses, and the chance it lands is
     precision / (precision + evasion). Our own numbers are known, so the
     opponent's precision follows from how often it hit us and its
     evasion from how often we hit it. This walks a grid and keeps the
     most likely value.
     ============================================================ */

  function rcFit(obs, kind) {
    var n = 0;
    obs.forEach(function (o) { n += o.n; });
    if (n < 12) return null;
    var best = -Infinity, arg = null;
    for (var k = 0; k <= 140; k++) {
      var q = Math.exp(Math.log(20) + k * (Math.log(30000) - Math.log(20)) / 140), ll = 0;
      for (var i = 0; i < obs.length; i++) {
        var o = obs[i], p = kind === 'p' ? q / (q + o.o) : o.o / (o.o + q), x = o.x + 0.5, t = o.n + 1;
        ll += x * Math.log(p) + (t - x) * Math.log(1 - p);
      }
      if (ll > best) { best = ll; arg = q; }
    }
    return arg;
  }

  /* ============================================================
     12d2. ARENA DUEL RECORDER

     The arena is one fighter against one fighter, ten attacks a day plus
     whatever comes in, and its log is richer than the squadron one: half
     the events carry hpLeft as "[hp/maxhp]", so the opponent's clone
     count and health per clone are facts rather than guesses, and every
     attack carries the damage it did.

     What still has to be inferred: precision and evasion (from how often
     each side hit), the skills (from how often each fired), and the crit
     profile (from the spread of damage values).

     A record is about 290 bytes and holds no player names.
     ============================================================ */

  function arOwner(name) { var m = /^(.*)'s Clone \d+$/.exec(String(name || '')); return m ? m[1] : null; }
  function arIndex(name) { var m = /^.*'s Clone (\d+)$/.exec(String(name || '')); return m ? +m[1] : 0; }
  function arHp(s) { var m = /(-?\d+)\s*\/\s*(\d+)/.exec(String(s || '')); return m ? { hp: +m[1], max: +m[2] } : null; }

  function arRound1(x) { return Math.round(x * 10) / 10; }

  // The smallest value is the plain hit: a crit and a dual shot only ever
  // add to it (a DoT charge is its own log line, a block cancels the hit).
  // Every damaging line is one swing worth base x (shot 1 + shot 2), each
  // shot 1 or the crit factor c, the second only on a dual shot: so a line
  // is base x 1, c, 2, 1 + c or 2c (3,220 live lines, no exception). c is
  // the factor that explains the most lines; clones of one player differ by
  // about 0.01 in c, inside the tolerance. Lines that killed are left out by
  // the caller (their value is capped at the health left). Older versions
  // read a dual shot as a crit. Values are whole numbers.
  function arDamage(vals) {
    var none = { base: 0, crit: 0, cm: 1.3, dual: 0 };
    if (!vals.length) return none;
    var base = Infinity;
    vals.forEach(function (v) { var k = Math.round(v); if (k > 0 && k < base) base = k; });
    if (!isFinite(base)) return none;
    var r = vals.map(function (v) { return v / base; }), TOL = 0.006;
    function near(x, y) { return Math.abs(x - y) <= y * TOL; }
    // [factor, crit shots, dual] for one line, or null when c does not explain it
    function read(x, c) {
      if (near(x, 1)) return [0, 0];
      if (near(x, 2)) return [0, 1];
      if (near(x, c)) return [1, 0];
      if (near(x, 1 + c)) return [1, 1];
      if (near(x, 2 * c)) return [2, 1];
      return null;
    }
    var bestC = 1.3, bestN = -1;
    for (var c = 1.30; c <= 3.5; c += 0.002) {
      if (Math.abs(c - 2) < 0.02) continue;   // a crit of x2 cannot be told from a dual shot
      var n = 0;
      for (var i = 0; i < r.length; i++) if (read(r[i], c)) n++;
      if (n > bestN) { bestN = n; bestC = c; }
    }
    // The grid step leaves c a little off: take the average c the crit
    // lines themselves imply.
    var cs = 0, cn = 0;
    r.forEach(function (x) {
      var k = read(x, bestC);
      if (!k || !k[0]) return;
      cs += k[0] === 2 ? x / 2 : (k[1] ? x - 1 : x); cn++;
    });
    if (cn) bestC = cs / cn;
    var lines = 0, shots = 0, crits = 0, duals = 0;
    r.forEach(function (x) {
      var k = read(x, bestC);
      if (!k) return;
      lines++; shots += 1 + k[1]; crits += k[0]; duals += k[1];
    });
    if (!lines) return { base: base, crit: 0, cm: 1.3, dual: 0 };
    return { base: base, crit: arRound1(crits / shots * 100), cm: crits ? Math.round(bestC * 1000) / 1000 : 1.3, dual: arRound1(duals / lines * 100), lines: lines, duals: duals };
  }

  // Turns one duel into a record, or null when it cannot be used.
  //   duel   PvPArenaStore.currentDuel
  //   me     our username
  //   pv     our build now, from readPvp (for precision and evasion)
  function arBuild(duel, me, pv, nowMs) {
    try {
      if (!duel || !duel.logs || !duel.logs.length || !me) return null;
      if (duel.attackerName !== me && duel.defenderName !== me) return null;
      var them = duel.attackerName === me ? duel.defenderName : duel.attackerName;
      if (!them) return null;

      var side = {}, rounds = 0, first = null;
      function get(n) { return side[n] || (side[n] = { n: 0, max: 0, dmg: [], hit: 0, miss: 0, blocked: 0, att: 0, dot: 0, stun: 0, focus: 0, dual: 0, out: 0, seen: {} }); }

      duel.logs.forEach(function (e) {
        if (e.action === 'round') { rounds = numOr(e.value) || rounds; return; }
        var ao = arOwner(e.attacker), dO = arOwner(e.defender);
        if (dO) { var d = get(dO); d.n = Math.max(d.n, arIndex(e.defender)); var h = arHp(e.hpLeft); if (h) d.max = Math.max(d.max, h.max); }
        if (ao) { var a = get(ao); a.n = Math.max(a.n, arIndex(e.attacker)); }
        if (e.action === 'dies') { if (dO) get(dO).out = rounds; return; }
        if (!ao) return;
        var A = get(ao);
        if (e.action === 'attacks' || e.action === 'misses hit on' || e.action === 'attack blocked') {
          if (first === null) first = ao;
          A.att++;
          if (e.action === 'attacks') {
            A.hit++;
            // a killing blow is capped at the health left, so it says nothing about the hit
            var v = numOr(e.value), hl = arHp(e.hpLeft);
            if (v !== null && v > 0 && !(hl && hl.hp <= 0)) A.dmg.push(v);
          }
          else if (e.action === 'attack blocked') { A.hit++; get(dO || ao).blocked++; }
          else A.miss++;
          // A dual shot is one log line holding both shots; arDamage reads it.
        } else if (e.action === 'DoT triggers') {
          // A DoT charge that kills ends the swing that burnt it: no attack
          // line follows, but the swing landed (counting it as missing read
          // the opponent's evasion about 3% high).
          var hk = arHp(e.hpLeft);
          if (hk && hk.hp <= 0) { if (first === null) first = ao; A.att++; A.hit++; }
        } else if (e.action === 'applies DoT') A.dot++;
        else if (e.action === 'stuns') A.stun++;
        else if (e.action === 'focused') A.focus++;
      });

      var mine = side[me], theirs = side[them];
      if (!mine || !theirs || !mine.n || !theirs.n || !mine.max || !theirs.max) return null;

      // Our own stats are known exactly, so the opponent's precision comes
      // from how often it hit us, and its evasion from how often we hit it.
      var t = pv ? pvTotals(pv) : null;
      var myP = t ? Math.round(t.precision) : null, myE = t ? Math.round(t.evasion) : null;
      if (myP === null) return null;

      function fit(hits, swings, known, kind) {
        if (swings < 12) return null;
        return rcFit([{ x: hits, n: swings, o: known }], kind);
      }
      var opP = fit(theirs.hit, theirs.att, myE, 'p');
      var opE = fit(mine.hit, mine.att, myP, 'e');

      function skills(s, other) {
        function pc(x, n) { return Math.min(60, arRound1(x / (n + 4) * 100)); }
        return [pc(s.dot, s.att), pc(s.focus, s.att), pc(s.stun, s.att), pc(s.blocked, other.hit + 0)];
      }
      // The log shows a dual line only when the second shot also lands
      // unblocked, so the stat is the share seen divided by that chance,
      // pulled towards a typical 35% while there are few lines to go on (as
      // if 30 lines at 35% had been seen) and capped at 60%, above anything
      // seen live.
      function dualStat(s, other, dmg) {
        var p2 = Math.max(0.05, (s.hit - other.blocked) / Math.max(1, s.att)), K = 30;
        if (!dmg.lines) return 0;
        return arRound1(Math.min(60, (dmg.duals + 0.35 * p2 * K) / (p2 * (dmg.lines + K)) * 100));
      }
      function fighter(s, other, dmg, p, e) {
        return { n: s.n, d: dmg.base, h: s.max, p: p, e: e,
          s: skills(s, other), c: [[dmg.crit, arRound1((dmg.cm - 1) * 100 - 30), dualStat(s, other, dmg)]],
          x: s.out || 0,
          // how the hit counts came out, so a later reader can tell a
          // precision read off 12 swings from one read off 120
          q: [s.hit, s.att, other.hit, other.att] };
      }
      var myDmg = arDamage(mine.dmg), opDmg = arDamage(theirs.dmg);

      // Did the build that fought this duel still look like today's build?
      var approx = 0;
      if (t) {
        var expD = t.power * mine.n, expH = t.hull * PVP_HP_MULT * mine.n;
        if (Math.abs(myDmg.base / expD - 1) > 0.02 || Math.abs(mine.max / expH - 1) > 0.02) approx = 1;
      }

      var out = {
        v: 3, t: (numOr(duel.created) || 0) * 1000 || nowMs, i: typeof duel._id === 'string' ? duel._id : null,
        w: duel.winner === me ? 1 : 0, f: first === me ? 1 : 0, r: rounds,
        o: fighter(mine, theirs, myDmg, myP, myE),
        e: fighter(theirs, mine, opDmg, opP === null ? myP : Math.round(opP), opE === null ? myE : Math.round(opE))
      };
      if (opP === null || opE === null) out.e.u = 1;
      if (approx) out.a = 1;
      return out;
    } catch (e) { return null; }
  }

  function arKey(rec) {
    if (rec.i) return rec.i;
    return rec.r + '|' + rec.w + '|' + rec.o.d + ':' + rec.o.h + '|' + rec.e.d + ':' + rec.e.h;
  }

  // A duel measures an opponent's precision and evasion from a handful of
  // swings, so the number is never exact. These are the standard-error
  // offsets, in units of one SE, of five equally likely versions of the
  // same opponent: fighting all five is fighting the uncertainty itself,
  // and a build that only wins against the flattering version stops
  // looking good.
  var AR_SPREAD = [-1.15, -0.5, 0, 0.5, 1.15];

  // Older duel records kept no swing counts. They are read as if from this
  // many swings: a short duel, so more doubt, the safe side to be wrong on.
  var AR_ASSUME = 24;

  function arAssume(f, pRef, eRef) {
    var hitUs = f.p / (f.p + eRef), hitThem = pRef / (pRef + f.e);
    return [Math.round(hitUs * AR_ASSUME), AR_ASSUME, Math.round(hitThem * AR_ASSUME), AR_ASSUME];
  }

  // pRef / eRef are OUR precision and evasion in the duel this fighter was
  // recorded in, which is what their hit counts were measured against. They
  // are passed in rather than written onto the record: the record is about
  // to be saved to disk and has no business carrying our scratch values.
  function arDraws(f, pRef, eRef) {
    var q = (f.q && f.q.length >= 4) ? f.q : null, out = [];
    pRef = pRef || f.p; eRef = eRef || f.e;
    if (!q) { try { q = arAssume(f, pRef, eRef); } catch (e) { return [arSide(f)]; } }
    for (var j = 0; j < 4; j++) if (numOr(q[j]) === null || q[j] < 0) return [arSide(f)];
    if (!(q[1] > 0) || !(q[3] > 0)) return [arSide(f)];
    // hits out of swings is a coin flip repeated, so the spread of the
    // underlying rate is the usual sqrt(p(1-p)/n).
    function stat(hits, swings, known, invert) {
      var p = Math.min(0.98, Math.max(0.02, hits / Math.max(1, swings)));
      var se = Math.sqrt(p * (1 - p) / Math.max(1, swings));
      var v = AR_SPREAD.map(function (z) {
        var q2 = Math.min(0.98, Math.max(0.02, p + z * se));
        return invert ? known * (1 - q2) / q2 : known * q2 / (1 - q2);
      });
      // Turning a hit rate back into a stat bends the scale, so an even
      // spread of rates comes out lopsided in stat points. Recentre on the
      // plain estimate: the doubt is kept, the drift is not.
      var mean = 0, mid = v[(AR_SPREAD.length - 1) >> 1];
      v.forEach(function (x) { mean += x; });
      mean /= v.length;
      var k = mean > 0 ? mid / mean : 1;
      return v.map(function (x) { return x * k; });
    }
    var P = stat(q[0], q[1], eRef, false);   // their precision, against our evasion
    var E = stat(q[2], q[3], pRef, true);    // their evasion, against our precision
    for (var i = 0; i < AR_SPREAD.length; i++) {
      var s = arSide(f);
      s.prec = Math.max(20, Math.round(P[i]));
      s.eva = Math.max(20, Math.round(E[i]));
      out.push(s);
    }
    return out;
  }

  // One recorded fighter as the simulator wants it.
  function arSide(f) {
    var sk = (f && Array.isArray(f.s) && f.s.length === 4) ? f.s : [0, 0, 0, 0];
    var cl = (f && Array.isArray(f.c) && f.c.length) ? f.c : [[0, 0, 0]];
    function num(v, d) { var x = numOr(v); return x === null ? d : x; }
    return {
      N: Math.max(1, num(f && f.n, 1)), hp: Math.max(1, num(f && f.h, 1)), dmg: Math.max(0, num(f && f.d, 0)),
      prec: Math.max(1, num(f && f.p, 1)), eva: Math.max(1, num(f && f.e, 1)),
      sk: { dot: num(sk[0], 0) / 100, focus: num(sk[1], 0) / 100, stun: num(sk[2], 0) / 100, block: num(sk[3], 0) / 100 },
      cl: cl.map(function (c) {
        c = (Array.isArray(c) && c.length) ? c : [0, 0, 0];
        return { crit: num(c[0], 0) / 100, cm: 1 + (30 + num(c[1], 0)) / 100, dual: num(c[2], 0) / 100 };
      })
    };
  }

  /* ============================================================
     12d3. ANOMALY TRACKER

     Rare anomaly drops are announced to everyone in the Main chatroom
     ("SERVER | Anomalies: <name> found a rare anomaly"), so who is
     finding them is public and reading it costs no API calls. The game
     keeps the last 200 Main messages; older ones, and any missed while
     the tab was closed, cannot be recovered.

     A tally is just a name and a count, so the whole log stays a few
     hundred bytes even after thousands of drops.
     ============================================================ */

  var AN_RE = /^(.+) found a rare anomaly$/;

  // One look at ChatStore.MainChatroom, whichever tab is open. Piggybacks
  // on the same once-a-second timer as the duel recorder (see recTick).
  // The room holds at most 200 messages, so scanning all of it every look
  // is cheap; S.anSeen (by message id) is what keeps a drop from being
  // counted twice while it is still in that window.
  function anTick() {
    if (S.inputs.recAnomalies === false) return;
    var st = recState(), cs = st && st.ChatStore, L = cs && cs.MainChatroom;
    if (!L || !Array.isArray(L) || !L.length) return;
    var added = false;
    for (var i = 0; i < L.length; i++) {
      var m = L[i];
      if (!m || m.role !== 'SERVER_ROLE' || typeof m.message !== 'string' || S.anSeen[m.uid]) continue;
      var hit = AN_RE.exec(m.message);
      S.anSeen[m.uid] = 1;
      if (!hit) continue;
      var name = hit[1];
      S.anomalies[name] = (S.anomalies[name] || 0) + 1;
      added = true;
    }
    // S.anSeen would grow forever on its own; only messages still in the
    // game's own 200-message window are worth remembering as seen.
    var keepIds = {}; L.forEach(function (m) { if (m) keepIds[m.uid] = 1; });
    Object.keys(S.anSeen).forEach(function (id) { if (!keepIds[id]) delete S.anSeen[id]; });
    if (added) {
      store.set('anomalies', S.anomalies);
      store.set('anSeen', S.anSeen);
      if (panel.style.display !== 'none' && tab === 'an') render();
    }
  }

  // Clearing starts from a true zero. Every message still in Main chat is
  // marked as seen, or the next look would count those drops again.
  function anClear() {
    S.anomalies = {}; S.anSeen = {};
    var st = recState() || S.storeState, L = st && st.ChatStore && st.ChatStore.MainChatroom;
    if (Array.isArray(L)) L.forEach(function (m) { if (m && m.uid !== undefined && m.uid !== null) S.anSeen[m.uid] = 1; });
    store.set('anomalies', S.anomalies);
    store.set('anSeen', S.anSeen);
  }

  function anRows() {
    var names = Object.keys(S.anomalies);
    return names.map(function (n) { return { name: n, n: S.anomalies[n] }; })
      .sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });
  }

  /* ============================================================
     12e. DUEL SIMULATOR

     The arena is one fighter against one fighter, so this is a one
     against one engine.

     Rules, read from real battle logs:
       - Each side is one fighter with N clones. All of one side's clones
         act, then the other's; the defending side goes first each round.
       - A clone swings once a round at a random living clone (or at the
         one Focus marked). The swing lands with precision / (precision +
         evasion). On a landed swing, in this order (measured on 19 live
         squadron battles and a full duel, 2026-11-08, see
         docs/pvp-research/fable/):
           1. Focus may mark the target (before the block roll);
           2. DoT may be applied: 3 charges;
           3. if the target carries charges, one burns: 50% of the
              attacker's base damage (so applying DoT burns the first
              charge at once);
           4. Block may cancel the rest (the DoT above still happened);
           5. damage = base x (shot 1 + shot 2), each shot 1 or the crit
              factor, the second shot only on a dual shot, both on the same
              target in one log line, floored;
           6. Stun may make the target skip its next swing.
       - The battle ends when one side has no clones left, or after 300
         rounds, in which case whoever has more health left wins.

     The clone arrays are allocated once and refilled, because the planner
     runs tens of thousands of these and the allocation showed up.
     ============================================================ */

  var RL_MAX_ROUNDS = 300;
  var RL_MAX_CLONES = 64;

  function rlSlot() {
    return { S: null, hp: new Float64Array(RL_MAX_CLONES), ch: new Int8Array(RL_MAX_CLONES),
      st: new Uint8Array(RL_MAX_CLONES), mark: -1, alive: 0 };
  }
  var RL_A = rlSlot(), RL_B = rlSlot();

  function rlLoad(f, S) {
    f.S = S; f.mark = -1; f.alive = Math.min(S.N, RL_MAX_CLONES);
    for (var i = 0; i < f.alive; i++) { f.hp[i] = S.hp; f.ch[i] = 0; f.st[i] = 0; }
  }

  // One side's phase of a round: its clones act in order.
  // R: the roll streams (rngStreams). Every roll of a shot is drawn up front,
  // used or not, so builds stay on the same luck (see rngStreams).
  function rlPhase(a, d, R) {
    var S = a.S, T = d.S, n = a.alive ? S.N : 0, i, dual, cl, t, k, pick, dmg, base, rHit, rBlock, rCrit, rCrit2, rDot, rStun, rFocus, rHit2, rBlock2;
    for (i = 0; i < n; i++) {
      if (d.alive <= 0) return;
      if (a.hp[i] <= 0) continue;
      if (a.st[i]) { a.st[i] = 0; continue; }
      cl = S.cl[i % S.cl.length];
      dual = R.dual() < cl.dual;
      pick = Math.floor(R.pick() * d.alive);
      rHit = R.hit(); rBlock = R.block(); rCrit = R.crit(); rCrit2 = R.crit2(); rDot = R.dot(); rStun = R.stun(); rFocus = R.focus();
      rHit2 = R.hit2(); rBlock2 = R.block2();
      // The second shot of a dual rolls its own hit and block: dual-shot
      // lines run at the stated chance x the shooter's hit rate x (1 -
      // block), 512 seen for 507 predicted over 38 players (live, 2026-11-08).
      if (dual && (rHit2 >= S.prec / (S.prec + T.eva) || (T.sk.block > 0 && rBlock2 < T.sk.block))) dual = false;
      if (d.mark >= 0 && d.hp[d.mark] > 0) t = d.mark;
      else {
        t = -1;
        for (k = 0; k < T.N; k++) if (d.hp[k] > 0) { if (pick === 0) { t = k; break; } pick--; }
      }
      if (rHit >= S.prec / (S.prec + T.eva)) continue;
      base = S.dmg;
      if (S.sk.focus > 0 && d.mark < 0 && rFocus < S.sk.focus) d.mark = t;
      if (S.sk.dot > 0 && rDot < S.sk.dot) d.ch[t] = 3;
      if (d.ch[t] > 0) {
        d.ch[t]--; d.hp[t] -= Math.floor(base * 0.5);
        if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; continue; }
      }
      if (T.sk.block > 0 && rBlock < T.sk.block) continue;
      dmg = Math.floor(base * ((rCrit < cl.crit ? cl.cm : 1) + (dual ? (rCrit2 < cl.crit ? cl.cm : 1) : 0)));
      d.hp[t] -= dmg;
      if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; }
      else if (S.sk.stun > 0 && !d.st[t] && rStun < S.sk.stun) d.st[t] = 1;
    }
  }

  function rlLeft(f) {
    if (f.alive <= 0) return 0;
    var s = 0, i;
    for (i = 0; i < f.S.N; i++) if (f.hp[i] > 0) s += f.hp[i];
    return s / (f.S.N * f.S.hp);
  }

  // A against B. aFirst: A strikes first each round (A is defending).
  // seed: one whole number; the same seed gives the same luck to both sides.
  function rlDuel(SA, SB, aFirst, seed) {
    var A = RL_A, B = RL_B, first, second, r;
    var R = rngStreams(seed, ['dual', 'pick', 'hit', 'block', 'crit', 'dot', 'stun', 'focus', 'crit2', 'hit2', 'block2']);
    rlLoad(A, SA); rlLoad(B, SB);
    first = aFirst ? A : B; second = aFirst ? B : A;
    for (r = 1; r <= RL_MAX_ROUNDS && A.alive > 0 && B.alive > 0; r++) {
      rlPhase(first, second, R);
      if (second.alive <= 0) break;
      rlPhase(second, first, R);
    }
    var la = rlLeft(A), lb = rlLeft(B);
    // After 300 rounds the side with more health left wins (absolute health,
    // not a share of each side's own total); a tie goes to the defender, the
    // side that strikes first (the game's arena wiki).
    var ha = la * Math.min(SA.N, RL_MAX_CLONES) * SA.hp, hb = lb * Math.min(SB.N, RL_MAX_CLONES) * SB.hp;
    return { win: B.alive <= 0 ? 1 : (A.alive <= 0 ? 0 : (ha > hb ? 1 : (ha < hb ? 0 : (aFirst ? 1 : 0)))),
      rounds: r > RL_MAX_ROUNDS ? RL_MAX_ROUNDS : r, fracA: la, fracB: lb };
  }

  // A fighter's build as the simulator wants it, at the game's own scale
  // (damage and health per clone).
  function rlMe(b) {
    var t = pvTotals(b);
    return { N: b.N, hp: t.hull * PVP_HP_MULT * b.N, dmg: t.power * b.N, prec: t.precision, eva: t.evasion, sk: pvSkills(b.gear),
      cl: b.clones.length ? b.clones : [{ crit: 0, cm: 1 + CLONE_CRIT_BASE / 100, dual: 0 }] };
  }

  /* ============================================================
     12f. BUILD PLANNER

     The yardstick is the arena: the build fights every opponent on record,
     one 1-on-1 duel at a time, half the time attacking and half defending,
     and the score is the share of duels it wins. The game also has squadron
     fights; they are not simulated, because a build that does well in the
     arena does well in a squadron too. The same random numbers are used for
     every build compared, so the difference between two builds is much
     steadier than either score.

     The best build is looked for in two steps: the split of stat points and
     the active stat of each piece come from a quick formula (damage x health
     x hit ratio against the average recorded enemy), and the skills are then
     chosen by running those duels. It is only offered when it beats the
     current build by more than the noise and the doubt in the estimates.
     ============================================================ */

  var PV_SIMS = 1200;
  var PV_MIN_EACH = 10;      // fewest sims per opponent, so its own win rate still means something
  var PV_MAX_BATTLES = 2000; // most battles one scoring call may run, so no slice runs long
  var PV_SEED = 7;
  var PV_FLOOR = 8;         // duels on record before a build is suggested at all
  var PV_CONTESTED = 3;     // of those, how many must be fights that could go either way
  var PV_DECIDED = 0.02;    // a win rate this close to 0 or 1 is already settled

  // Each opponent becomes a small bundle of equally likely versions of
  // itself, so the doubt in their precision and evasion is carried into
  // the answer rather than assumed away.
  function pvPool(recs) {
    var out = [];
    recs.forEach(function (r) {
      if (!r || !r.e || !r.o) return;
      out.push(arDraws(r.e, r.o.p, r.o.e));
    });
    return out;
  }

  // The equal-budget meta, from self-play on this simulator (PvP arena
  // meta.md, 2026-11-07): the field a player with few duels on record is
  // scored against. Fractions of the total stat (power, precision, evasion,
  // hull), the four skills, and the share of the field. Block x4 and DoT x1 +
  // Block x3 at 35/15/15/35 are the equilibrium; the others its near
  // neighbours. Stun and Focus lose at equal budget and are not in it.
  var PV_META = [
    { f: [0.35, 0.15, 0.15, 0.35], sk: ['block', 'block', 'block', 'block'], w: 0.45 },
    { f: [0.35, 0.15, 0.15, 0.35], sk: ['dot', 'block', 'block', 'block'], w: 0.25 },
    { f: [0.35, 0.15, 0.20, 0.30], sk: ['block', 'block', 'block', 'block'], w: 0.15 },
    { f: [0.30, 0.15, 0.20, 0.35], sk: ['dot', 'dot', 'block', 'block'], w: 0.15 }
  ];
  // What a young ladder looks like: even points, assorted skills. Shown as
  // the second reference on the Best tab; the best answer to it is
  // 35/20/10/35 Block x4.
  var PV_NAIVE_BEST = [0.35, 0.20, 0.10, 0.35];
  var PV_META_COPIES = 20;   // opponents in the synthetic pool

  // The meta opponents as the simulator wants them, at this player's own
  // total stat, clone count and clone profile: a fair field, not a stronger
  // or weaker one. Each share becomes that many copies, so the pool has the
  // same shape as pvPool's (a list of draw bundles, one draw each).
  function pvMetaPool(b) {
    var t = pvTotals(b), budget = t.power + t.precision + t.evasion + t.hull, me = rlMe(b), out = [];
    PV_META.forEach(function (m) {
      var sk = { dot: 0, focus: 0, stun: 0, block: 0 };
      m.sk.forEach(function (s) { sk[s] += s === 'focus' ? 0.025 : 0.05; });
      var p = m.f.map(function (x) { return Math.max(1, Math.round(x * budget)); });
      var side = { N: b.N, hp: p[3] * PVP_HP_MULT * b.N, dmg: p[0] * b.N, prec: p[1], eva: p[2], sk: sk, cl: me.cl };
      for (var i = 0; i < Math.round(m.w * PV_META_COPIES); i++) out.push([side]);
    });
    return out;
  }

  function pvPoolRef(pool) {
    var p = 0, e = 0, n = 0;
    pool.forEach(function (draws) { draws.forEach(function (s) { p += s.prec; e += s.eva; n++; }); });
    return { precision: p / (n || 1), evasion: e / (n || 1) };
  }

  function pvPlanKey(pv, keepBadges, recs) {
    // Only the materials the gear is levelled with: keying on every material
    // held re-ran the whole plan each time any unrelated drop landed.
    var mats = pv.gear.map(function (g) { return pv.mats[g.mat] || 0; });
    return JSON.stringify([pv.pts, pv.pool, pv.gear, pv.craft, pv.vel, pv.N, pv.clones, mats, pv.badges, keepBadges, recs.map(arKey)]);
  }

  // Every opponent is scored on its own, always with the same random
  // numbers, so two builds can be compared opponent by opponent. How much
  // the opponents disagree is what the error bar is made of.
  function pvScoreOf(b, pool, sims) {
    var me = rlMe(b), n = pool.length || 1;
    // Sims per opponent. The floor keeps each opponent's own win rate
    // meaningful; the ceiling on the total keeps one call from blocking the
    // page when there are a lot of duels on record. Between them the cost of
    // a scoring call is bounded whatever the pool size.
    var each = Math.max(PV_MIN_EACH, Math.round((sims || PV_SIMS) / n));
    if (n * each > PV_MAX_BATTLES) each = Math.max(PV_MIN_EACH, Math.floor(PV_MAX_BATTLES / n));
    var per = [], w = 0, m = 0, rounds = 0;
    for (var k = 0; k < pool.length; k++) {
      var draws = pool[k], ww = 0, mm = 0, rr = 0;
      for (var i = 0; i < each; i++) {
        var r = rlDuel(me, draws[i % draws.length], i % 2 === 0, PV_SEED + k * 104729 + i * 7919);
        ww += r.win; mm += r.fracA - r.fracB; rr += r.rounds;
      }
      per.push(ww / each);
      w += ww / each; m += mm / each; rounds += rr / each;
    }
    w /= n; m /= n; rounds /= n;
    var v = 0;
    per.forEach(function (x) { v += (x - w) * (x - w); });
    return { score: w * 100 + m, win: w, rounds: rounds, per: per,
      se: per.length > 1 ? Math.sqrt(v / (per.length - 1) / per.length) * 100 : 50 };
  }

  // Build B against build A, opponent by opponent. Pairing cancels most of
  // the noise, so this is far surer than the difference of two win rates.
  function pvGap(a, b) {
    var n = Math.min(a.per.length, b.per.length), d = [], sum = 0, i;
    if (!n) return { gain: 0, se: 50 };
    for (i = 0; i < n; i++) { d.push((b.per[i] - a.per[i]) * 100); sum += d[i]; }
    var mean = sum / n, v = 0;
    for (i = 0; i < n; i++) v += (d[i] - mean) * (d[i] - mean);
    return { gain: mean, se: n > 1 ? Math.sqrt(v / (n - 1) / n) : 50 };
  }

  // How many more duels it would take to reach a given error bar.
  function pvNeedFor(se, n, target) {
    if (!(se > target) || !(n > 0)) return 0;
    return Math.max(1, Math.ceil(n * (se / target) * (se / target)) - n);
  }

  // The win rate for the screen: the margin tail is for the search only.
  function pvPct(score) { return Math.max(0, Math.min(100, Math.round(score))); }

  function pvCompositions(n) {
    var out = [];
    (function rec(start, cur) {
      if (cur.length === n) { out.push(cur.slice()); return; }
      for (var i = start; i < PVP_SKILLS.length; i++) { cur.push(PVP_SKILLS[i]); rec(i, cur); cur.pop(); }
    })(0, []);
    return out;
  }

  // What each of one piece's next upgrades would add to the score, from the build as it is.
  function pvUpgradeRows(b, pool, base, i, only) {
    var g = b.gear[i], rows = [];
    (only ? [only] : ['level', 'tier']).forEach(function (kind) {
      var c = pvCopy(b);
      if (kind === 'level') c.gear[i].L++; else c.gear[i].T++;
      rows.push({ name: g.name, kind: kind, from: kind === 'level' ? g.L : g.T, cost: kind === 'level' ? pvLevelCost(g.L) : pvTierCost(g.T),
        res: kind === 'level' ? g.mat : 'badges', have: kind === 'level' ? (b.mats[g.mat] || 0) : b.badges,
        gain: pool ? pvScoreOf(c, pool, 800).score - base : null });
    });
    return rows;
  }

  // Everything is drawn from the recorded enemies. Searching is ranking, not
  // measuring: it needs enough opponents to tell builds apart, not all of
  // them. The reported win rate, error bar and gain are still taken over
  // every opponent on record - only the search runs on a sample. This runs
  // in the background worker (12i), so it runs straight through; done(plan)
  // at the end, done(null, err) on a failure.
  var PV_SEARCH_MAX = 40;

  // An even spread across the contested list rather than the first 40, so a
  // sample keeps the whole range of opponents you actually meet.
function pvSample(list, max) {
    var n = list.length;
    if (n <= max) return list;
    var out = [], step = n / max, i;
    for (i = 0; i < max; i++) out.push(list[Math.min(n - 1, Math.floor(i * step))]);
    return out;
  }

  function pvPlanRun(pv, recs, keepBadges, done) {
    try {
      var pool = pvPool(recs), synthetic = pool.length < PV_FLOOR;
      // Too few real opponents to tune against: the meta field at the player's
      // own total stat stands in (pvMetaPool), and the plan says so.
      var plan = { pool: pool.length, floor: PV_FLOOR, thin: synthetic, synthetic: synthetic };
      if (synthetic) pool = pvMetaPool(pv);
      var ref = pvPoolRef(pool);
      plan.ref = ref;
      plan.cur = pvScoreOf(pv, pool);
      plan.need = synthetic ? 0 : pvNeedFor(plan.cur.se, pool.length, 5);
      // A fight you always win, or always lose, says nothing about which
      // build is better: every build gets the same result. Tuning is done
      // on the ones that could go either way.
      var idx = [];
      plan.cur.per.forEach(function (w, i) { if (w > PV_DECIDED && w < 1 - PV_DECIDED) idx.push(i); });
      plan.contested = idx.length;
      plan.decided = pool.length - idx.length;
      var liveAll = idx.map(function (i) { return pool[i]; });   // all the contested: what the finalists are settled on
      // The meta field is at the player's own budget, so its fights are
      // contested by construction; should a build still settle them all,
      // tune on the whole field rather than stop.
      if (synthetic && idx.length < PV_CONTESTED) liveAll = pool;
      else if (idx.length < PV_CONTESTED) { plan.stop = 1; done(plan); return; }
      var live = pvSample(liveAll, PV_SEARCH_MAX);   // a sample of them: what the search runs on
      plan.searched = live.length;

      // The split of points and each piece's active stat from the formula...
      var cand = pvBestAssign(pv, ref);
      // ...then the skills by running the duels. Stun and Focus lose at equal
      // budget whatever they are paired with (the self-play meta), so sets
      // with two or more of them are not tried: 35 compositions become 13.
      // The current skills always compete, whatever they are, so a recorded
      // field that favours them can still keep them.
      var curSkills = cand.gear.map(function (g) { return g.skill; }), curKey = curSkills.slice().sort().join();
      var comps = pvCompositions(cand.gear.length).filter(function (c) {
        return c.filter(function (s) { return s === 'stun' || s === 'focus'; }).length <= 1;
      });
      if (!comps.some(function (c) { return c.slice().sort().join() === curKey; })) comps.push(curSkills);
      function withSkills(comp) { var c = pvCopy(cand); comp.forEach(function (sk, i) { c.gear[i].skill = sk; }); return c; }
      var quick = comps.map(function (comp) { return { comp: comp, key: comp.slice().sort().join(), m: pvScoreOf(withSkills(comp), live, 120).score }; });
      quick.sort(function (x, y) { return y.m - x.m; });
      var short = quick.slice(0, 5);
      if (!short.some(function (x) { return x.key === curKey; })) short.push(quick.filter(function (x) { return x.key === curKey; })[0] || quick[0]);
      // The finalists are close together, which is exactly when a small
      // sample misleads, and there are only six of them: settle it on
      // every contested opponent.
      short.forEach(function (x) { x.m = pvScoreOf(withSkills(x.comp), liveAll, 600).score; });
      short.sort(function (x, y) { return y.m - x.m; });
      // The winner, with the current skills kept when it is a tie, and each
      // piece keeping its own skill where the winning set still has it.
      var cur = short.filter(function (x) { return x.key === curKey; })[0];
      var pick = cur && cur.m >= short[0].m - 0.8 ? cur : short[0];   // inside the noise: keep what is there
      var left = pick.comp.slice(), out = new Array(cand.gear.length);
      cand.gear.forEach(function (g, i) { var j = left.indexOf(g.skill); if (j >= 0) { out[i] = g.skill; left.splice(j, 1); } });
      for (var i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = left.shift();
      cand.gear.forEach(function (g, i) { g.skill = out[i]; });

      var s = pvScoreOf(cand, pool), g = pvGap(plan.cur, s);
      plan.free = { build: cand, totals: pvTotals(cand), score: s.score, win: s.win, gain: g.gain, se: g.se, sure: g.gain > 2 * g.se };

      // What each next upgrade is worth, and what the materials and badges in hand buy right now.
      plan.base8 = pvScoreOf(pv, live, 800).score;
      plan.next = [];
      pv.gear.forEach(function (g, k) { ['level', 'tier'].forEach(function (kind) { plan.next = plan.next.concat(pvUpgradeRows(pv, live, plan.base8, k, kind)); }); });
      var sp = pvSpend(pv, keepBadges);
      plan.buy = { steps: sp.steps };
      if (sp.steps.length) {
        var b2 = pvCopy(pv); b2.gear = sp.gear;
        var s2 = pvScoreOf(b2, pool), g2 = pvGap(plan.cur, s2);
        plan.buy.score = s2.score; plan.buy.gain = g2.gain; plan.buy.se = g2.se; plan.buy.build = b2;
      }
      done(plan);
    } catch (e) { done(null, e); }
  }

  // Does the simulator see the real battles the way they went? Each recorded
  // battle is replayed with its recorded fighters.
  function pvReplay(rec, sims) {
    var A = arSide(rec.o), B = arSide(rec.e), w = 0, rounds = 0;
    for (var i = 0; i < sims; i++) {
      var r = rlDuel(A, B, rec.f === 1, 1000 + i * 7919);
      w += r.win === rec.w ? 1 : 0; rounds += r.rounds;
    }
    return { p: w / sims, rounds: rounds / sims };
  }

  /* ============================================================
     12g. LABORATORY MULTIPLIER  (for the Economy tab)

     Every laboratory craft yields 2 + whole hundreds of the Laboratory
     enhancer's boost (5 at boost 387), NO chance of one more for the
     leftover percent: four running jobs at boost 420 each claimed exactly
     6.0000 per tick. The boost is level * (1 + tier/100) * (1 +
     efficiency/100), the enhancer counting its level at half; efficiency is
     the base_module_efficiency_boost skill. Read out of the game's code and
     checked against what it displays (docs/model-base.md).
     ============================================================ */

  var BB_HALF = { 'Quantum server': 1, 'Laboratory enhancer': 1 };
  var BB_ENHANCER = 'Laboratory enhancer';

  function bbEffLevel(m) { return BB_HALF[m.name] ? m.level / 2 : m.level; }
  function bbBoost(m, eff) { return bbEffLevel(m) * (1 + (m.tier || 0) / 100) * (1 + eff / 100); }
  function bbWhole(boost) { return Math.floor(boost / 100); }

  // Crafts per lab job. Whole hundreds only; with BB_LAB_FRAC = 1 the
  // leftover percent would count as a chance of one more.
  var BB_LAB_FRAC = 0;
  function bbCrafts(boost) { var w = bbWhole(boost); return 2 + w + BB_LAB_FRAC * (boost / 100 - w); }
  function bbLabMult(enh, eff) { return enh ? bbCrafts(bbBoost(enh, eff)) : 1; }
  function bbX(n) { return '\u00d7' + String(Math.round(n * 100) / 100); }

  /* ============================================================
     12h. BATTLING  (which clone upgrade pays)

     The game's own PvE fight, rebuilt from its client code (the code behind
     its Simulate and Find optimal build buttons) and checked on the user's
     account against every number the Battling page prints, the round log's
     hits, and the Simulate winrate. A fight pays the same whatever the
     rounds, so an upgrade only pays by letting you hold a higher enemy level
     at the target winrate. See docs/model-battling.md.
     ============================================================ */

  var BT_NPC_WEAK = {
    brutes: ['kinetic', 'explosive'], spectres: ['energy', 'electromagnetic'], glacials: ['explosive', 'incendiary'],
    machiners: ['energy', 'electromagnetic'], scorchers: ['chemical', 'kinetic'], toxoids: ['incendiary', 'chemical'],
    miners: ['kinetic', 'explosive'], dusters: ['electromagnetic', 'chemical']
  };
  var BT_NPC_DMG = 7, BT_NPC_HULL = 1300, BT_CLONE_CRIT = 30, BT_ARMOR_K = 170000;
  var BT_CAP = { lifesteal: 36, defense: 50, armor_penetration: 50, block: 40, stun: 40 };
  var BT_DOT_PCT = 45, BT_DOT_ROUNDS = 5, BT_STUN_ROUNDS = 1, BT_MAX_ROUNDS = 100;
  // The game's optimizer farms at 98% or better. Near 98% one level moves the
  // winrate by only about 0.03 to 0.05%, less than a 20,000-fight simulation
  // wobbles, so each level is found in two passes: a coarse search at 2,000
  // fights a winrate, then every level within BT_WIN of its answer at
  // BT_FINE fights (BT_HEAD for the current build, BT_FARM for the winrate
  // at the level farmed). Every option uses the same random numbers, so
  // options are compared on equal luck: levels come out about +-1 to 2, a
  // cliff in the winrate exactly. All of it runs in the background worker
  // (section 12i), about a minute for a full Battling tab.
  var BT_TARGET = 98, BT_RUNS = 2000, BT_SEED = 20260924;
  var BT_FINE = 20000, BT_HEAD = 60000, BT_FARM = 100000, BT_WIN = 3, BT_SPLIT_RUNS = 3000;
  var BT_SPEND = 1e9;                             // options are priced at about 1B

  function btRng(seed) {
    var a = seed | 0;
    return function () {
      a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Catalysts count at their "default" activity only, as the game's fight
  // does: base x rarity x range, half for a halved one.
  function btCatalysts(slots) {
    var out = {};
    slots.forEach(function (s) {
      ((s && s.catalysts) || []).forEach(function (c) {
        if (!c || !c.stat || (c.activity || 'default') !== 'default') return;
        out[c.stat] = (out[c.stat] || 0) + catVal(c) * (c.halved ? 0.5 : 1);
      });
    });
    return out;
  }

  // Everything the fight needs, from the game's memory; null when unreadable.
  function btRead(root) {
    var u = root && root.UserStore, p = u && u.player, ship = root && root.ShipStore, b = root && root.BattleStore;
    if (!p || !p.stats || !Array.isArray(p.clones) || !p.clones.length || !ship || !b) return null;
    var sq = root.squadronStore || {}, sk = p.skills || {}, lr = b.lastReward;
    function slot(e) {
      return e ? { value: numOr(e.value) || 0, bonuses: Array.isArray(e.bonuses) ? e.bonuses : [], anomaly: e.anomaly === true } : null;
    }
    var names = ['weapon_slot', 'shield_slot', 'laser_slot', 'probes_slot', 'engine_slot', 'sensors_slot'];
    var npc = String(b.currentNPC || '').toLowerCase();
    var sim = lr && typeof lr === 'object' ? lr.simulation : null;
    return {
      ctx: {
        stats: { power: numOr(p.stats.power) || 0, precision: numOr(p.stats.precision) || 0, evasion: numOr(p.stats.evasion) || 0, hull: numOr(p.stats.hull) || 0 },
        skills: { weapon: numOr(sk.battling_weapon_boost) || 0, hull: numOr(sk.battling_hull_boost) || 0, precision: numOr(sk.battling_precision_boost) || 0, evasion: numOr(sk.battling_evasion_boost) || 0 },
        weapon: slot(ship.weapon_slot), shield: slot(ship.shield_slot),
        cat: btCatalysts(names.map(function (n) { return ship[n]; })),
        clones: p.clones.map(function (c) { return { cc: numOr(c.critical_chance) || 0, cd: numOr(c.critical_damage) || 0, ds: numOr(c.dual_shot) || 0 }; })
      },
      available: numOr(p.stats.available) || 0,
      npc: npc, weak: BT_NPC_WEAK[npc] || null, level: numOr(b.currentNPCLevel),
      ss: numOr(sq.effectiveSSBattlingBoost) || 0,
      blocked: sq.ssBattlingBoostBlockedByEnemyClaim === true || !!(lr && lr.otherSquadInSameSystem === true),
      battling: b.isBattling === true,
      fightAt: numOr(b.nextActionAt),
      reward: lr && lr.name === 'credits' && sim && sim.mob ? { cr: numOr(lr.amount), xp: numOr(lr.xp), level: numOr(sim.mob.level), win: sim.win === 'player' } : null
    };
  }

  function btWeak(slot, weak) {
    if (!slot) return 0;
    if (slot.anomaly) return 30;
    var t = slot.bonuses.slice(0, 2), hits = t.filter(function (x) { return weak && weak.indexOf(x) >= 0; }).length;
    if (t.length === 1 && hits === 1) return 30;
    return t.length > 1 ? hits * 15 : 0;
  }

  // One fight's fixed numbers at an NPC level: the game's simulateBattle
  // before its first round.
  function btSetup(c, weak, level, ss) {
    var o = 1 + ss / 100, cat = c.cat;
    var dmg = c.stats.power * 7 * (1 + c.skills.weapon / 100) + (c.weapon ? c.weapon.value : 0);
    var wb = btWeak(c.weapon, weak) + btWeak(c.shield, weak);
    if (wb) dmg *= 1 + wb / 100;
    var E = c.stats.evasion * (1 + c.skills.evasion / 100) * o * (1 + (cat.evasion || 0) / 100);
    var D = c.stats.precision * (1 + c.skills.precision / 100) * o * (1 + (cat.precision || 0) / 100);
    var mobDmg = Math.floor(level * BT_NPC_DMG * 1.5), def = Math.min(cat.defense || 0, BT_CAP.defense);
    if (def > 0) mobDmg = Math.max(1, Math.floor(mobDmg * (1 - def / 100)));
    var armor = level * (1 - Math.min(cat.armor_penetration || 0, BT_CAP.armor_penetration) / 100);
    return {
      dmg: Math.floor(Math.ceil(dmg) * o),
      hp: Math.floor(Math.ceil(c.stats.hull * 7 * (1 + c.skills.hull / 100) + (c.shield ? c.shield.value : 0)) * o),
      mobDmg: mobDmg, mobHull: Math.floor(Math.pow(level, 1.1) * BT_NPC_HULL),
      mobHit: Math.ceil(level / (level + E) * 100), cloneHit: Math.ceil(D / (D + level) * 100),
      armorCut: armor / (armor + BT_ARMOR_K),
      stun: Math.min(cat.stun || 0, BT_CAP.stun), block: Math.min(BT_CAP.block, cat.block || 0), dot: cat.dot || 0, ls: cat.lifesteal || 0
    };
  }

  // One fight, round by round as the game plays it; true when the clones win.
  // R: the roll streams (rngStreams), one per kind of roll; see there.
  function btFight(s, clones, R) {
    var n = clones.length, hp = [], alive = n, mob = s.mobHull, stun = 0, dot = 0, dealt = 0, i, rMob, rBlock;
    var lsCap = Math.floor(s.hp * BT_CAP.lifesteal / 100);
    for (i = 0; i < n; i++) hp.push(s.hp);
    function attack(k) {
      var rHit = R.hit(), rCrit = R.crit();
      if (rHit >= s.cloneHit / 100) return;
      var crit = rCrit < clones[k].cc / 100;
      var d = Math.max(1, Math.floor(Math.ceil(crit ? s.dmg * (1 + (BT_CLONE_CRIT + clones[k].cd) / 100) : s.dmg) * (1 - s.armorCut)));
      mob -= d; dealt += d;
      if (s.ls > 0 && hp[k] < s.hp) {
        var h = Math.min(Math.floor(d * s.ls / 100), s.hp - hp[k], lsCap);
        if (h > 0) hp[k] += h;
      }
    }
    for (var round = 1; round < BT_MAX_ROUNDS; round++) {
      dealt = 0;
      if (R.stun() < s.stun / 100 && s.stun > 0 && stun === 0) stun = BT_STUN_ROUNDS;
      if (stun > 0) stun--;
      else {
        for (i = 0; i < n; i++) {
          if (hp[i] <= 0) continue;
          rMob = R.mobHit(); rBlock = R.block();
          if (rMob < s.mobHit / 100 && !(s.block > 0 && rBlock < s.block / 100)) hp[i] -= s.mobDmg;
          if (hp[i] <= 0) { hp[i] = 0; alive--; }
        }
      }
      if (!alive) return false;
      for (i = 0; i < n; i++) {
        if (hp[i] <= 0) continue;
        attack(i);
        if (R.dual() < clones[i].ds / 100) attack(i);
      }
      if (R.dot() < s.dot / 100 && s.dot > 0 && dot === 0) dot = BT_DOT_ROUNDS;
      if (dot > 0) { dot--; mob -= Math.floor(dealt * BT_DOT_PCT / 100); }
      if (mob <= 0) return true;
    }
    return false;
  }

  function btWinrate(c, weak, level, ss, runs) {
    var s = btSetup(c, weak, level, ss), w = 0;
    var R = rngStreams(BT_SEED, ['stun', 'mobHit', 'block', 'hit', 'crit', 'dual', 'dot']);
    for (var i = 0; i < runs; i++) if (btFight(s, c.clones, R)) w++;
    return 100 * w / runs;
  }

  // The highest level held at the target winrate, searched from `from` one
  // winrate at a time, so a caller can spread the work (btJob). next() returns
  // the level to test, or null when done (then .best is the answer).
  function btSearch(from, step0) {
    var lo = null, hi = null, step = step0 || 16, probe = Math.max(1, Math.round(from)), best = 0;
    return {
      next: function () { return probe; },
      tell: function (okAtProbe) {
        if (okAtProbe) { lo = probe; best = probe; } else hi = probe;
        if (hi === null) { probe = lo + step; step *= 2; return; }
        if (lo === null) {
          if (probe <= 1) { probe = null; return; }
          probe = Math.max(1, probe - step); step *= 2; return;
        }
        probe = hi - lo > 1 ? (lo + hi) >> 1 : null;
      },
      get best() { return best; }
    };
  }

  // What a clone stat costs from `from` up: 0.1 at a time, each step to value
  // v costing 5,000 x v x e^(0.15 v) (the game's cloneUpgradeCost, the same as
  // droids). Buys as many steps as `budget` allows.
  function btRaise(from, budget) {
    var v = Math.round(from * 10), cost = 0;
    for (;;) {
      var x = (v + 1) / 10, c = 5000 * x * Math.exp(0.15 * x);
      if (cost + c > budget || v > 5000) break;
      cost += c; v++;
    }
    return { to: v / 10, cost: cost };
  }


  function btCloneCopy(c, clones) {
    return { stats: c.stats, skills: c.skills, weapon: c.weapon, shield: c.shield, cat: c.cat, clones: clones };
  }

  // The upgrade options, each a changed copy of the context and its cost:
  // about 1B on one stat across every clone, 1B on the weakest clone's three
  // stats when one clone lags well behind, and the next clone.
  function btOptions(r, clonePrice) {
    var c = r.ctx, n = c.clones.length, out = [];
    [['ds', 'Dual shot'], ['cc', 'Crit chance'], ['cd', 'Crit damage']].forEach(function (k) {
      var cost = 0, before = [], after = [];
      var clones = c.clones.map(function (cl) {
        var up = btRaise(cl[k[0]], BT_SPEND / n), x = { cc: cl.cc, cd: cl.cd, ds: cl.ds };
        x[k[0]] = up.to; cost += up.cost; before.push(cl[k[0]]); after.push(up.to);
        return x;
      });
      // The typical clone's rise (the median): one lagging clone rises much more.
      var gains = after.map(function (v, i) { return v - before[i]; }).sort(function (a, b) { return a - b; });
      var gain = gains[(gains.length - 1) >> 1];
      out.push({ key: k[0], label: k[1] + ', all ' + n + ' clones +' + (Math.round(gain * 10) / 10), cost: cost, ctx: btCloneCopy(c, clones) });
    });
    var sums = c.clones.map(function (cl) { return cl.cc + cl.cd + cl.ds; });
    var weakest = sums.indexOf(Math.min.apply(null, sums)), top = Math.max.apply(null, sums);
    if (n > 1 && sums[weakest] < 0.8 * top) {
      var cost = 0, cl0 = c.clones[weakest], x = { cc: cl0.cc, cd: cl0.cd, ds: cl0.ds }, most = 0;
      ['cc', 'cd', 'ds'].forEach(function (k) { var up = btRaise(cl0[k], BT_SPEND / 3); x[k] = up.to; cost += up.cost; most = Math.max(most, up.to); });
      var clones = c.clones.slice(); clones[weakest] = x;
      out.push({ key: 'weak', label: 'Clone ' + (weakest + 1) + ': its 3 stats, up to ~' + Math.round(most), cost: cost, ctx: btCloneCopy(c, clones) });
    }
    var more = c.clones.concat([{ cc: 0, cd: 0, ds: 0 }]);
    out.push({ key: 'clone', label: 'Buy clone ' + (n + 1) + (clonePrice ? ' (' + (clonePrice.est ? '~' : '') + fmt(clonePrice.v, 0) + ')' : ''), cost: clonePrice ? clonePrice.v : null, est: clonePrice ? clonePrice.est : false, ctx: btCloneCopy(c, more) });
    return out;
  }

  // The next clone's price: the game's own answer when it was seen at this
  // clone count, else ten times per clone from the last one seen (the same
  // rule as droids), else unknown.
  function cloneCount() {
    var p = S.storeState && S.storeState.UserStore && S.storeState.UserStore.player;
    return p && Array.isArray(p.clones) ? p.clones.length : 0;
  }
  function nextClonePrice() {
    var cp = S.clonePrice, n = cloneCount();
    if (!cp || !(cp.v > 0) || !(cp.n > 0) || !n) return null;
    return cp.n === n ? { v: cp.v, est: false } : { v: cp.v * Math.pow(10, n - cp.n), est: true };
  }

  // The highest level held at 98%: the coarse search, then every level within
  // BT_WIN of its answer at `runs` fights on the same random numbers, keeping
  // the highest at 98% or more (the window moves when the answer is on its
  // edge). `tick` is called after each winrate, for the progress line.
  function btMaxLevel(ctx, weak, ss, from, runs, tick) {
    var s = btSearch(from || 1), L;
    while ((L = s.next()) !== null) { s.tell(btWinrate(ctx, weak, L, ss, BT_RUNS) >= BT_TARGET); tick(); }
    // `best` is the highest level seen at 98% in any window: once the
    // window has moved up past it, it is the answer (going back down would
    // swing between two windows forever when the winrate sits just under 98%).
    var c = s.best || 1, lo = Math.max(1, c - BT_WIN), hi = c + BT_WIN, wr = {}, best = 0;
    for (var guard = 0; guard < 60; guard++) {
      for (L = lo; L <= hi; L++) if (wr[L] === undefined) { wr[L] = btWinrate(ctx, weak, L, ss, runs); tick(); if (wr[L] >= BT_TARGET && L > best) best = L; }
      if (best === hi) { lo = hi + 1; hi += BT_WIN; continue; }
      if (!best && lo > 1) { hi = lo - 1; lo = Math.max(1, lo - BT_WIN); continue; }
      break;
    }
    return best;
  }

  function btWithStats(ctx, st) { return { stats: st, skills: ctx.skills, weapon: ctx.weapon, shield: ctx.shield, cat: ctx.cat, clones: ctx.clones }; }

  // The stat split that wins most a few levels above the current max: the
  // free points into the best single stat, then moves of 16, then 6 points
  // between stats while one helps (same random numbers throughout).
  function btBestSplit(ctx, weak, ss, free, level, tick) {
    var keys = ['power', 'precision', 'evasion', 'hull'];
    function copy(st) { return { power: st.power, precision: st.precision, evasion: st.evasion, hull: st.hull }; }
    function score(st) { tick(); return btWinrate(btWithStats(ctx, st), weak, level, ss, BT_SPLIT_RUNS); }
    var st = null, sc = -1;
    keys.forEach(function (k) { var t = copy(ctx.stats); t[k] += free; var v = score(t); if (v > sc) { sc = v; st = t; } });
    [16, 6].forEach(function (step) {
      for (var round = 0; round < 10; round++) {
        var moved = false;
        keys.forEach(function (a) {
          keys.forEach(function (b) {
            if (a === b || st[b] < step) return;
            var t = copy(st); t[a] += step; t[b] -= step;
            var v = score(t);
            if (v > sc) { sc = v; st = t; moved = true; }
          });
        });
        if (!moved) break;
      }
    });
    return st;
  }

  /* ============================================================
     12i. BACKGROUND WORKER

     The heavy maths (the PvE fights of the Battling and Equipment tabs, the
     PvP build planner and its duel replays) runs in a Web Worker, a
     separate thread, so the game never waits for it. Tampermonkey runs this
     script inside a wrapper that made the same fights 25 to 45 times slower
     on the page (3.20.0 froze the game that way); a worker made from a Blob
     runs at full speed, outside it. The worker's code is these functions'
     own source text, so it is exactly the code the tests check; WK_VARS
     and WK_FNS must list everything they use (t/worker_unit.js runs the
     worker source on its own and fails on anything missing).
     ============================================================ */

  function WK_VARS() {
    return {
      BT_NPC_DMG: BT_NPC_DMG, BT_NPC_HULL: BT_NPC_HULL, BT_CLONE_CRIT: BT_CLONE_CRIT, BT_ARMOR_K: BT_ARMOR_K, BT_CAP: BT_CAP,
      BT_DOT_PCT: BT_DOT_PCT, BT_DOT_ROUNDS: BT_DOT_ROUNDS, BT_STUN_ROUNDS: BT_STUN_ROUNDS, BT_MAX_ROUNDS: BT_MAX_ROUNDS,
      BT_TARGET: BT_TARGET, BT_RUNS: BT_RUNS, BT_SEED: BT_SEED, BT_FINE: BT_FINE, BT_HEAD: BT_HEAD, BT_FARM: BT_FARM, BT_WIN: BT_WIN, BT_SPLIT_RUNS: BT_SPLIT_RUNS,
      AR_ASSUME: AR_ASSUME, AR_SPREAD: AR_SPREAD, CLONE_CRIT_BASE: CLONE_CRIT_BASE, PVP_HP_MULT: PVP_HP_MULT, PVP_SKILLS: PVP_SKILLS, PVP_STATS: PVP_STATS,
      PV_CONTESTED: PV_CONTESTED, PV_DECIDED: PV_DECIDED, PV_FLOOR: PV_FLOOR, PV_MAX_BATTLES: PV_MAX_BATTLES, PV_MIN_EACH: PV_MIN_EACH,
      PV_SEARCH_MAX: PV_SEARCH_MAX, PV_SEED: PV_SEED, PV_SIMS: PV_SIMS,
      PV_META: PV_META, PV_META_COPIES: PV_META_COPIES,
      RL_A: RL_A, RL_B: RL_B, RL_MAX_CLONES: RL_MAX_CLONES, RL_MAX_ROUNDS: RL_MAX_ROUNDS
    };
  }
  function WK_FNS() {
    return [numOr, btRng, btWeak, btSetup, btFight, btWinrate, btSearch, btMaxLevel, btWithStats, btBestSplit,
      arAssume, arDraws, arSide, pvAllocate, pvBestAssign, pvCompositions, pvCopy, pvGap, pvGearBase, pvGearVal, pvLevelCost,
      pvMetaPool, pvNeedFor, pvPlanRun, pvPool, pvPoolRef, pvReplay, pvSample, pvScore, pvScoreOf, pvSkills, pvSpend, pvTerm,
      pvTierCost, pvTotals, pvUpgradeRows, rlDuel, rlLeft, rlLoad, rlMe, rlPhase, rlSlot, rngStreams];
  }

  // The worker's own message handler: one job per worker.
  function wkMain() {
    self.onmessage = function (e) {
      var job = e.data, n = 0;
      function tick() { n++; if (n % 5 === 0) self.postMessage({ type: 'tick', n: n }); }
      try {
        if (job.kind === 'battling') {
          var cur = job.current;
          var max = btMaxLevel(cur, job.weak, job.ss, job.level, BT_HEAD, tick);
          var farm = job.level ? btWinrate(cur, job.weak, job.level, job.ss, BT_FARM) : null;
          self.postMessage({ type: 'head', max: max, farm: farm, farmRuns: BT_FARM });
          job.options.forEach(function (o, i) {
            var ctx = o.ctx, st = null;
            if (o.split) { st = btBestSplit(cur, job.weak, job.ss, o.free, max + 8, tick); ctx = btWithStats(cur, st); }
            self.postMessage({ type: 'option', i: i, max: btMaxLevel(ctx, job.weak, job.ss, max, BT_FINE, tick), stats: st });
          });
        } else if (job.kind === 'levels') {
          // The others start from the first answer, as the Battling tab's
          // options start from its max: the same search gives the same level.
          var from = job.from;
          job.ctxs.forEach(function (c, i) { var m = btMaxLevel(c, job.weak, job.ss, from, BT_FINE, tick); if (i === 0) from = m; self.postMessage({ type: 'lv', i: i, max: m }); });
        } else if (job.kind === 'pvp') {
          pvPlanRun(job.pv, job.recs, job.keep, function (plan, err) {
            self.postMessage({ type: 'plan', plan: plan || null, err: err ? String((err && err.message) || err) : null });
            self.postMessage({ type: 'done' });
          });
          return;
        } else if (job.kind === 'replay') {
          job.recs.forEach(function (rec, i) {
            var res;
            try { res = pvReplay(rec, job.sims); } catch (e) { res = { p: null, rounds: null }; }
            self.postMessage({ type: 'replay', i: i, res: res });
          });
        }
        self.postMessage({ type: 'done' });
      } catch (err) {
        self.postMessage({ type: 'error', err: String((err && err.message) || err) });
      }
    };
  }

  function wkSource() {
    var v = WK_VARS();
    return Object.keys(v).map(function (k) { return 'var ' + k + ' = ' + JSON.stringify(v[k]) + ';'; }).join('\n') + '\n' +
      WK_FNS().map(String).join('\n') + '\n(' + String(wkMain) + ')();';
  }

  // Starts one job in its own worker. onMsg gets every message; the worker
  // is closed after 'done' or 'error'. Returns the worker (for stopping), or
  // null when the browser refuses a worker (the job is then not run: doing
  // it on the page would freeze the game).
  var wkUrl = null;
  function wkRun(job, onMsg) {
    var w;
    try {
      if (!wkUrl) wkUrl = URL.createObjectURL(new Blob([wkSource()], { type: 'text/javascript' }));
      w = new Worker(wkUrl);
    } catch (e) { S.wkFail = String((e && e.message) || e); return null; }
    var rec = { kind: job.kind, at: Date.now(), end: 0, err: null };
    w.onmessage = function (e) {
      var m = e.data;
      if (m && (m.type === 'done' || m.type === 'error')) { w.terminate(); rec.end = Date.now(); rec.err = m.err || null; }
      try { onMsg(m); } catch (err) { setErr('background work: ' + ((err && err.message) || err)); }
    };
    w.onerror = function (e) { w.terminate(); rec.end = Date.now(); rec.err = (e && e.message) || 'the worker stopped'; try { onMsg({ type: 'error', err: (e && e.message) || 'the worker stopped' }); } catch (err) {} };
    w.postMessage(JSON.parse(JSON.stringify(job)));
    S.wkLast = rec;
    return w;
  }

  /* ---- the Barracks boost ----
     The game shows effectiveSSBattlingBoost 0 until its Battling page or an
     Install Catalyst window loads it. The last value it loaded is kept
     (socalc:barracks) and used, marked, until it loads again. When a button
     needs it and it is not loaded, the game is asked once per page load
     with its own squadronStore.refreshEffectiveSSBattlingBoost(), the read
     its Battling page makes every time it opens (GET
     /api/squadrons/effective-ss-battling-boost; the user's choice,
     2026-09-25, docs/decisions.md). */

  var boostAsked = false;
  function barracks() {
    var sq = (S.storeState && S.storeState.squadronStore) || {};
    var live = gameSquadron();
    if (live) sq = live;
    if (sq.ssBattlingBoostLoaded === true) {
      var v = numOr(sq.effectiveSSBattlingBoost) || 0;
      if (!S.barracks || S.barracks.v !== v || Date.now() - (S.barracks.t || 0) > 3600000) { S.barracks = { v: v, t: Date.now(), from: 'game' }; store.set('barracks', S.barracks); }
      return { v: v, remembered: false, blocked: sq.ssBattlingBoostBlockedByEnemyClaim === true };
    }
    return S.barracks && isFinite(S.barracks.v) ? { v: S.barracks.v, t: S.barracks.t, remembered: true } : null;
  }
  function gameSquadron() {
    try { return findVueApp().config.globalProperties.$pinia.state.value.squadronStore || null; } catch (e) { return null; }
  }
  // Asks the game once per page load; calls then() when the answer is in, or
  // after 10 s either way.
  function askGameForBoost(then) {
    if (boostAsked) return false;
    var sq = gameSquadron();
    if (!sq || sq.ssBattlingBoostLoaded === true) return false;
    boostAsked = true;
    try {
      var s = findVueApp().config.globalProperties.$pinia._s.get('squadronStore');
      if (!s || typeof s.refreshEffectiveSSBattlingBoost !== 'function') return false;
      s.refreshEffectiveSSBattlingBoost();
      S.boostAskedAt = Date.now();
    } catch (e) { return false; }
    var t0 = Date.now();
    (function look() {
      var q = gameSquadron();
      if ((q && q.ssBattlingBoostLoaded === true) || Date.now() - t0 > 10000) then();
      else setTimeout(look, 500);
    })();
    return true;
  }

  /* ============================================================
     12j. EQUIPMENT  (your items, catalysts, and what you own that is better)

     Each item has rows of 4 catalyst slots, one row per purpose ("Slots
     for" in the game's Install Catalyst window): weapon and shield Default,
     Galaxy boss, Dungeons; engine and sensors Default, Voyager; laser and
     probes Default, Exploring & Voyager, Crafting, Galaxy boss, Dungeons.
     A catalyst's `activity` is the row it sits in. In one row, a stat
     twice counts the weaker at half (the game marks it `halved`; checked on
     all 48 of the user's equipped catalysts) and there is no third. Totals
     add up over all items; caps apply to the total. Worth: base x rarity x
     range / 100, the game's catalyst module. See docs/model-battling.md.
     ============================================================ */

  var EQ_LABEL = {
    defense: 'Defense', armor_penetration: 'Armor pen', lifesteal: 'Lifesteal', stun: 'Stun', block: 'Block', dot: 'DoT',
    precision: 'Precision', evasion: 'Evasion', battling_xp: 'XP', battling_credits: 'Credits', gathering_xp: 'XP',
    gathering_yield: 'Yield', exploring_xp: 'XP', cosmic_dust_bonus: 'Cosmic dust', crafting_xp: 'XP', crafting_scrap: 'Scrap',
    catalyst_drop_chance: 'Catalyst drops', fuel_efficiency: 'Fuel efficiency', voyager_jumps_bonus: 'Voyager jumps',
    base_upkeep_reduction: 'Base upkeep'
  };
  var EQ_ITEMS = [['weapon_slot', 'Weapon'], ['shield_slot', 'Shield'], ['engine_slot', 'Engine'], ['sensors_slot', 'Sensors'], ['laser_slot', 'Laser'], ['probes_slot', 'Probes']];
  var EQ_ROWS = {
    weapon_slot: ['default', 'galaxyboss', 'dungeons'], shield_slot: ['default', 'galaxyboss', 'dungeons'],
    engine_slot: ['default', 'voyager'], sensors_slot: ['default', 'voyager'],
    laser_slot: ['default', 'exploring', 'crafting', 'galaxyboss', 'voyager', 'dungeons'], probes_slot: ['default', 'exploring', 'crafting', 'galaxyboss', 'voyager', 'dungeons']
  };
  var EQ_ROW_NAME = { default: 'Default', galaxyboss: 'Galaxy boss', dungeons: 'Dungeons', voyager: 'Voyager', exploring: 'Exploring', crafting: 'Crafting' };
  // In a Default row a catalyst works where its stat belongs; in the other
  // rows, in that row's activity. Fuel efficiency is read while exploring,
  // Voyager jumps by the Voyager (the game's own calls).
  var EQ_NATURAL = {
    defense: 'battling', armor_penetration: 'battling', lifesteal: 'battling', stun: 'battling', block: 'battling', dot: 'battling',
    precision: 'battling', evasion: 'battling', battling_xp: 'battling', battling_credits: 'battling',
    gathering_xp: 'gathering', gathering_yield: 'gathering', exploring_xp: 'exploring', cosmic_dust_bonus: 'exploring',
    voyager_jumps_bonus: 'voyager', crafting_xp: 'crafting', crafting_scrap: 'crafting',
    catalyst_drop_chance: 'utility', fuel_efficiency: 'exploring', base_upkeep_reduction: 'utility'
  };
  var EQ_PURPOSES = [['battling', 'Battling'], ['galaxyboss', 'Galaxy boss'], ['dungeons', 'Dungeons'], ['gathering', 'Gathering'],
    ['exploring', 'Exploring'], ['voyager', 'Voyager'], ['crafting', 'Crafting'], ['utility', 'Utility']];
  // The game activity each purpose is read in. Per item, an activity uses
  // that item's own row for it if the row holds any catalyst, else the next
  // in the game's chain (Voyager falls back to Exploring), else Default: a
  // filled row replaces Default, it does not add to it (the game's
  // getEquippedOn / getCatalystActivityChain).
  var EQ_ACT = { battling: 'default', gathering: 'default', utility: 'default', galaxyboss: 'galaxyboss', dungeons: 'dungeons',
    exploring: 'exploring', voyager: 'voyager', crafting: 'crafting' };
  var EQ_CHAIN = { voyager: ['voyager', 'exploring', 'default'] };
  // Which stats each purpose shows: the fight stats in the three fights, and
  // otherwise the stats that belong to it.
  function eqShows(p, stat) {
    var nat = EQ_NATURAL[stat];
    if (p === 'galaxyboss' || p === 'dungeons') return nat === 'battling';
    if (p === 'voyager') return nat === 'voyager' || stat === 'exploring_xp' || stat === 'cosmic_dust_bonus';
    return nat === p;
  }
  // An item's active row for one activity: { row, cats }, or null.
  function eqActive(byRow, act) {
    var chain = EQ_CHAIN[act] || (act === 'default' ? ['default'] : [act, 'default']);
    for (var i = 0; i < chain.length; i++) if (byRow[chain[i]] && byRow[chain[i]].length) return { row: chain[i], cats: byRow[chain[i]] };
    return null;
  }
  // Where a total stops counting: the PvE fight (BT_CAP), and the Galaxy
  // boss caps its My Stats tab shows (used from the game when loaded).
  var EQ_CAPS = {
    battling: { defense: 50, armor_penetration: 50, block: 40, stun: 40 },
    galaxyboss: { armor_penetration: 100, defense: 60, lifesteal: 36, block: 25 },
    // The utility stats stop at 60: 60% each, and 60 jumps (the game's
    // catalyst*Cap values).
    utility: { catalyst_drop_chance: 60, base_upkeep_reduction: 60 },
    exploring: { fuel_efficiency: 60 },
    voyager: { voyager_jumps_bonus: 60 }
  };
  // Galaxy boss skill tree levels that add to the same totals (GB_TREE_EFFECTS).
  var EQ_GB_SKILL = { defense: ['gb_defense', [0, 5, 10, 15]], lifesteal: ['gb_lifesteal', [0, 2, 4, 6]] };
  var EQ_BOOST = { gathering: 1, exploring: 1, voyager: 1, crafting: 1, utility: 1 };

  var eqVal = catVal;
  function eqPurpose(row, stat) {
    if (row === 'default') return EQ_NATURAL[stat] || 'utility';
    return row;
  }

  function eqRead(root) {
    if (!root || !root.ShipStore) return null;
    var items = [];
    EQ_ITEMS.forEach(function (it) {
      var e = root.ShipStore[it[0]];
      if (!e) return;
      items.push({
        key: it[0], label: it[1], level: numOr(e.level) || 0,
        cats: (Array.isArray(e.catalysts) ? e.catalysts : []).map(function (c) {
          return { stat: c.stat, category: c.category, rarity: c.rarity, range: numOr(c.range) || 0, row: c.activity || 'default', halved: c.halved === true, slot: numOr(c.slotIndex) || 0 };
        })
      });
    });
    var inv = ((root.CatalystStore && root.CatalystStore.catalysts) || []).filter(function (c) { return c && !c.equippedOn; }).map(function (c) {
      return { stat: c.stat, category: c.category, rarity: c.rarity, range: numOr(c.range) || 0, onMarket: !!c.onMarket };
    });
    var gb = root.GalaxyBossStore || {};
    return items.length ? { items: items, inv: inv, gbSkills: gb.skills || {}, gbStats: gb.myStats || null } : null;
  }

  // A row's worth of one stat: the best in full, a second of the same stat half.
  function eqRowStat(cats, stat) {
    var v = cats.filter(function (c) { return c.stat === stat; }).map(eqVal).sort(function (a, b) { return b - a; });
    var t = 0;
    for (var i = 0; i < v.length; i++) t += i === 0 ? v[i] : v[i] / 2;
    return t;
  }

  function eqRows(items) {
    var rows = [];
    items.forEach(function (it) {
      var by = {};
      it.cats.forEach(function (c) { (by[c.row] = by[c.row] || []).push(c); });
      Object.keys(by).forEach(function (r) { rows.push({ item: it, row: r, cats: by[r] }); });
    });
    return rows;
  }

  // For each purpose, each item's row that counts there (see EQ_ACT).
  // inherited: the item has no row of that activity's own, so another counts.
  function eqActiveRows(rs) {
    var items = [], byItem = {};
    rs.forEach(function (r) {
      var k = r.item.key;
      if (!byItem[k]) { byItem[k] = {}; items.push(r.item); }
      byItem[k][r.row] = r.cats;
    });
    var out = [];
    EQ_PURPOSES.forEach(function (pp) {
      var act = EQ_ACT[pp[0]];
      items.forEach(function (it) {
        var a = eqActive(byItem[it.key], act);
        if (a) out.push({ p: pp[0], item: it, row: a.row, cats: a.cats, inherited: a.row !== act });
      });
    });
    return out;
  }

  function eqAnalyse(g) {
    var rows = eqRows(g.items);
    function totals(rs) {
      var t = {};
      eqActiveRows(rs).forEach(function (a) {
        var seen = {};
        a.cats.forEach(function (c) {
          if (seen[c.stat] || !eqShows(a.p, c.stat)) return;
          seen[c.stat] = 1;
          t[a.p] = t[a.p] || {};
          t[a.p][c.stat] = (t[a.p][c.stat] || 0) + eqRowStat(a.cats, c.stat);
        });
      });
      Object.keys(EQ_GB_SKILL).forEach(function (s) {
        var lv = numOr(g.gbSkills[EQ_GB_SKILL[s][0]]) || 0, add = EQ_GB_SKILL[s][1][lv] || 0;
        if (add) { t.galaxyboss = t.galaxyboss || {}; t.galaxyboss[s] = (t.galaxyboss[s] || 0) + add; }
      });
      return t;
    }
    var tot = totals(rows);
    var caps = {};
    Object.keys(EQ_CAPS).forEach(function (p) { caps[p] = {}; Object.keys(EQ_CAPS[p]).forEach(function (s) { caps[p][s] = EQ_CAPS[p][s]; }); });
    var ms = g.gbStats;
    if (ms) {
      if (ms.armorPenCap) caps.galaxyboss.armor_penetration = numOr(ms.armorPenCap);
      if (ms.defenseCap) caps.galaxyboss.defense = numOr(ms.defenseCap);
      if (ms.lifestealCap) caps.galaxyboss.lifesteal = numOr(ms.lifestealCap);
      if (ms.blockCap) caps.galaxyboss.block = numOr(ms.blockCap);
    }
    function capOf(p, s) { return caps[p] && caps[p][s] !== undefined ? caps[p][s] : Infinity; }

    // Upgrades: a spare catalyst in place of an equipped one of the same stat
    // (the row keeps its shape). Picked one at a time, best first: Default
    // rows before the others (the everyday activities), then the biggest
    // gain that still counts under its cap. Each spare is used once.
    var byKey = {};
    g.inv.filter(function (c) { return !c.onMarket && CAT_MAX[c.stat]; }).forEach(function (c) { var k = c.category + '|' + c.stat; (byKey[k] = byKey[k] || []).push(c); });
    Object.keys(byKey).forEach(function (k) { byKey[k].sort(function (a, b) { return eqVal(b) - eqVal(a); }); byKey[k] = byKey[k].slice(0, 12); });
    // A row only helps where it is the row that counts: a Default row is
    // not read for an activity the item has its own row for.
    var live = {};
    eqActiveRows(rows).forEach(function (x) { live[x.p + '|' + x.item.key + '|' + x.row] = 1; });
    var used = [], done = [], ups = [], cur = tot;
    for (var guard = 0; guard < 60; guard++) {
      var best = null;
      rows.forEach(function (r) {
        r.cats.forEach(function (c, i) {
          var pc = eqPurpose(r.row, c.stat);
          if (done.indexOf(c) >= 0 || !eqShows(pc, c.stat) || !live[pc + '|' + r.item.key + '|' + r.row]) return;   // does nothing where it sits
          var cands = byKey[c.category + '|' + c.stat] || [], p = eqPurpose(r.row, c.stat), cap = capOf(p, c.stat);
          for (var j = 0; j < cands.length; j++) {
            var x = cands[j];
            if (used.indexOf(x) >= 0 || eqVal(x) <= eqVal(c)) continue;
            var raw = eqRowStat(r.cats.map(function (y, k) { return k === i ? x : y; }), c.stat) - eqRowStat(r.cats, c.stat);
            var T = (cur[p] && cur[p][c.stat]) || 0, gain = Math.min(cap, T + raw) - Math.min(cap, T);
            if (gain < 0.05) continue;
            var pri = r.row === 'default' ? 1 : 0;
            if (!best || pri > best.pri || (pri === best.pri && gain > best.gain)) best = { pri: pri, gain: gain, raw: raw, r: r, i: i, c: c, x: x, p: p, cap: cap };
            break;                         // candidates are sorted: the first usable one is this slot's best
          }
        });
      });
      if (!best) break;
      used.push(best.x); done.push(best.c, best.x);
      best.r.cats = best.r.cats.map(function (y, k) { return k === best.i ? best.x : y; });
      cur = totals(rows);
      ups.push({ item: best.r.item.label, itemKey: best.r.item.key, row: best.r.row, purpose: best.p, stat: best.c.stat, from: best.c, to: best.x, gain: best.gain, raw: best.raw, cap: best.cap });
    }
    rows = eqRows(g.items);             // back to what is equipped (the search changed copies)

    var halved = [];
    rows.forEach(function (r) { r.cats.forEach(function (c) { if (c.halved) halved.push({ item: r.item.label, row: r.row, c: c }); }); });
    // Spare: cannot replace anything equipped of its stat and kind.
    var eqMin = {};
    g.items.forEach(function (it) { it.cats.forEach(function (c) { var k = c.category + '|' + c.stat, v = eqVal(c); if (eqMin[k] === undefined || v < eqMin[k]) eqMin[k] = v; }); });
    var spare = {}, spareN = 0, market = 0;
    g.inv.forEach(function (c) {
      if (c.onMarket) { market++; return; }
      var k = c.category + '|' + c.stat;
      if (eqMin[k] !== undefined && eqVal(c) > eqMin[k]) return;
      spareN++;
      var sp = spare[c.stat] = spare[c.stat] || { n: 0, best: null };
      sp.n++;
      if (!sp.best || eqVal(c) > eqVal(sp.best)) sp.best = c;
    });
    var empty = {};
    g.items.forEach(function (it) {
      (EQ_ROWS[it.key] || []).forEach(function (r) { if (!it.cats.some(function (c) { return c.row === r; })) (empty[r] = empty[r] || []).push(it.label); });
    });
    return { items: g.items, rows: rows, active: eqActiveRows(rows), tot: tot, caps: caps, gbStats: ms, ups: ups, halved: halved, spare: spare, spareN: spareN, market: market, empty: empty, invN: g.inv.length };
  }

  // Swaps that change the PvE fight: weapon and shield Default rows.
  function eqFightUps(a) {
    return a.ups.filter(function (u) { return u.row === 'default' && u.purpose === 'battling' && (u.itemKey === 'weapon_slot' || u.itemKey === 'shield_slot'); });
  }
  function eqLevelKey(u) { return u.itemKey + '|' + u.row + '|' + u.from.slot; }

  // The weaker of two of a stat in one row counts half: the halved marks of
  // a swapped copy, worked out again.
  function eqRehalve(cats) {
    var rows = {};
    cats.forEach(function (c) { var r = c.activity || 'default'; (rows[r] = rows[r] || []).push(c); });
    Object.keys(rows).forEach(function (r) {
      var by = {};
      rows[r].forEach(function (c) { (by[c.stat] = by[c.stat] || []).push(c); });
      Object.keys(by).forEach(function (st) {
        by[st].sort(function (x, y) { return eqVal(y) - eqVal(x); });
        by[st].forEach(function (c, i) { c.halved = i > 0; });
      });
    });
  }
  // A copy of the game's store with some catalysts swapped; the store itself
  // is never touched. A swap is { itemKey, row, slot, to }.
  function eqStoreWith(root, swaps) {
    var ship = {};
    Object.keys(root.ShipStore).forEach(function (k) { ship[k] = root.ShipStore[k]; });
    swaps.forEach(function (u) {
      var e = ship[u.itemKey];
      if (!e) return;
      var cats = (e.catalysts || []).map(function (c) {
        if ((c.activity || 'default') === u.row && (numOr(c.slotIndex) || 0) === u.slot) return { stat: u.to.stat, rarity: u.to.rarity, range: u.to.range, activity: c.activity, halved: false, slotIndex: c.slotIndex };
        return { stat: c.stat, rarity: c.rarity, range: c.range, activity: c.activity, halved: c.halved, slotIndex: c.slotIndex };
      });
      eqRehalve(cats);
      var copy = {};
      Object.keys(e).forEach(function (k) { copy[k] = e[k]; });
      copy.catalysts = cats;
      ship[u.itemKey] = copy;
    });
    var r2 = {};
    Object.keys(root).forEach(function (k) { r2[k] = root[k]; });
    r2.ShipStore = ship;
    return r2;
  }
  function eqSwap(u) { return { itemKey: u.itemKey, row: u.row, slot: u.from.slot, to: u.to }; }

  /* ============================================================
     13. UI
     ============================================================ */

  var THEME = store.get('theme', 'light');

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.root{--bg:#f4f6f8;--card:#fff;--tx:#1f2933;--mu:#6b7785;--bd:#e1e6eb;--ac:#2b7fa8;--tile:#eef3f7;--in:#fff;',
    '--good:#2f9e63;--warn:#b97b12;--bad:#cf4b45;--sh:0 8px 28px rgba(20,30,40,.22);',
    'font:13px/1.45 -apple-system,"Segoe UI",Roboto,system-ui,sans-serif;color:var(--tx)}',
    '.root.dark{--bg:#1a2129;--card:#222b35;--tx:#dbe4ec;--mu:#8898a8;--bd:#2f3b47;--ac:#63b6dc;--tile:#1f2831;--in:#1a2129;',
    '--good:#5ecb8f;--warn:#e0b04f;--bad:#e07a72;--sh:0 8px 28px rgba(0,0,0,.5)}',
    '.root *{font-variant-numeric:tabular-nums}',

    '#btn{position:fixed;top:10px;left:10px;display:flex;align-items:center;gap:7px;background:var(--card);color:var(--tx);',
    'font-weight:600;font-size:12px;padding:6px 12px;border:1px solid var(--bd);border-radius:999px;cursor:grab;user-select:none;box-shadow:var(--sh)}',
    '#btn:active{cursor:grabbing}',
    '#btn .dot{width:8px;height:8px;border-radius:50%;background:var(--mu)}',
    '#btn .lg{position:relative;display:flex}#btn .lg .dot{position:absolute;right:-3px;bottom:-3px;width:7px;height:7px;box-shadow:0 0 0 1.5px var(--card)}',
    '.dk #btn{position:static;box-shadow:none;cursor:pointer;padding:5px 12px 5px 9px}.dk #btn:active{cursor:pointer}',
    'svg.logo{width:16px;height:16px;flex:none;display:block}',
    '#btn.ok .dot{background:var(--good)}#btn.bad .dot{background:var(--bad)}#btn.busy .dot{background:var(--warn)}',

    '#panel{position:fixed;top:52px;left:10px;width:440px;max-height:86vh;display:flex;flex-direction:column;',
    'background:var(--bg);border:1px solid var(--bd);border-radius:12px;box-shadow:var(--sh);overflow:hidden}',
    '#bar{background:var(--card);padding:9px 12px;cursor:grab;display:flex;justify-content:space-between;align-items:center;',
    'user-select:none;border-bottom:1px solid var(--bd)}',
    '#bar b{font-size:13px;font-weight:700;letter-spacing:.2px}',
    '#bar .ttl{display:flex;align-items:center;gap:6px;min-width:0}',
    '#bar .beta{font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--warn);',
    'border:1px solid var(--warn);border-radius:4px;padding:0 4px;line-height:14px;opacity:.85}',
    '#bar .ver{font-size:10px;color:var(--mu)}',
    '#bar .ctl{display:flex;gap:4px}',
    '#bar .g{cursor:pointer;color:var(--mu);padding:2px 8px;border-radius:6px;font-size:12px}',
    '#bar .g.on{color:var(--ac)}',
    '#bar .g:hover{background:var(--tile);color:var(--tx)}',
    '#quota{padding:5px 12px;font-size:11px;color:var(--mu);display:flex;justify-content:space-between;background:var(--card);border-bottom:1px solid var(--bd)}',
    '#quota .warn{color:var(--warn)}',
    '#tabs{display:flex;padding:0 6px;background:var(--card);border-bottom:1px solid var(--bd);overflow-x:auto;scrollbar-width:none}#tabs::-webkit-scrollbar{display:none}',
    '#tabs button{display:flex;align-items:center;gap:5px;background:none;border:0;border-bottom:2px solid transparent;color:var(--mu);padding:7px 7px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}',
    '#tabs button:hover{color:var(--tx)}',
    '#tabs button.on{color:var(--ac);border-bottom-color:var(--ac);font-weight:600}',
    '#tabs .ti img,#tabs .ti svg{width:20px;height:20px;display:block;opacity:.75}#tabs button.on .ti img,#tabs button.on .ti svg,#tabs button:hover .ti img{opacity:1}',
    '#tabs button.hasic .tn{display:none}#tabs button.hasic.on .tn{display:inline}#tabs .ti:empty{display:none}',
    '#body{overflow:auto;padding:12px}',
    '.bsub{color:var(--mu);font-size:11px;margin-bottom:6px}.foot{color:var(--mu);font-size:10px;margin-top:10px}',
    '.gobar{display:flex;gap:10px;align-items:center;margin:6px 0 8px}.gobar .mu{color:var(--mu);font-size:11px}',
    '.gobar button,button.mini{background:var(--ac);color:#0d1b24;border:0;border-radius:7px;padding:6px 10px;font:inherit;font-weight:600;cursor:pointer}',
    'button.mini{padding:2px 8px;font-size:11px;margin-left:8px}.gobar button[disabled],button.mini[disabled]{opacity:.5;cursor:default}',
    'table.t td.grp{color:var(--ac);font-weight:600}table.t td.r{text-align:right;white-space:nowrap}table.t td.b{font-weight:600}',
    'details{border-top:1px solid var(--bd);padding:4px 0;font-size:12px}summary{cursor:pointer}details .card{margin-top:6px}',
    '.det{padding:2px 0 2px 14px;color:var(--mu);font-size:11px}.det b{color:var(--tx);font-weight:600}',
    '.ship{display:grid;grid-template-columns:78px 1fr 78px;grid-template-rows:repeat(3,64px);gap:4px;margin:6px 0}',
    '.shippic{grid-row:1/4;grid-column:2;display:flex;align-items:center;justify-content:center}.shippic img{max-width:100%;max-height:190px;object-fit:contain}',
    '.item{display:flex;flex-direction:column;align-items:center;cursor:pointer;border-radius:8px;padding:2px}.item.on{background:var(--card)}',
    '.ibox{position:relative;width:38px;height:38px;border:1px solid #7b3fb8;background:#2a1b3d;border-radius:4px;display:flex;align-items:center;justify-content:center}',
    '.item.on .ibox{border-color:var(--ac)}.iname{font-size:11px}.ilv{font-size:10px;color:var(--ac)}',
    '.badge{position:absolute;top:-6px;right:-8px;background:var(--good);color:#0d1b24;font-size:9px;font-weight:700;border-radius:8px;padding:0 4px}',
    '.rows{background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:6px 8px;margin-bottom:6px}',
    '.crow{display:flex;align-items:center;gap:4px;margin:3px 0 8px}.rname{width:78px;font-size:11px;color:var(--mu)}',
    '.cat{position:relative;width:32px;height:32px;border:2px solid;border-radius:5px;background:#1b1f2a;display:flex;align-items:center;justify-content:center}',
    '.cat.empty{border:1px dashed var(--bd);background:transparent}.cat.half{opacity:.6}',
    '.cat.sugg{border-style:dashed;margin-right:6px}.arrow{position:absolute;top:-7px;right:-5px;color:var(--good);font-size:10px}',
    '.hv{position:absolute;bottom:-4px;right:-3px;font-size:9px;color:var(--warn)}.hint{font-size:10px;margin-top:4px;color:var(--mu)}',
    '.lvb{position:absolute;bottom:-12px;left:50%;transform:translateX(-50%);font-size:9px;color:var(--good);white-space:nowrap}',
    '#tip{position:fixed;z-index:10;pointer-events:none;background:#10151c;color:#dbe4ec;border:1px solid #2f3b47;border-radius:7px;padding:6px 8px;max-width:280px;display:none;box-shadow:0 8px 28px rgba(0,0,0,.5);font-size:12px}',
    '#tip div:first-child{font-weight:600}#tip div{white-space:nowrap}',

    '.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
    '.seg{display:flex;gap:6px;margin:2px 0 10px}',
    '.seg button{flex:1;padding:6px 0;border:1px solid var(--bd);background:var(--card);border-radius:8px;color:var(--mu);font:inherit;font-size:12px;cursor:pointer}',
    '.seg button.on{background:var(--tile,var(--card));color:var(--ac);border-color:var(--ac);font-weight:600}',
    '.tile{background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:8px 10px;min-width:0}',
    '.tl{color:var(--mu);font-size:11px}',
    '.tv{font-size:18px;font-weight:650;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tv.est{color:var(--mu)}.tv.good{color:var(--good)}.tv.warn{color:var(--warn)}.tv.bad{color:var(--bad)}',
    '.ts{color:var(--mu);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tiles.wr .ts{white-space:normal}',

    '.card{background:var(--card);border:1px solid var(--bd);border-radius:9px;margin-top:10px;overflow:hidden}',
    'table.t{width:100%;border-collapse:collapse;font-size:12px}',
    'table.t th{color:var(--mu);font-weight:500;font-size:11px;text-align:right;padding:6px 8px;border-bottom:1px solid var(--bd);background:var(--tile)}',
    'table.t td{text-align:right;padding:5px 8px}',
    'table.t th:first-child,table.t td:first-child{text-align:left}',
    'table.t tr+tr td{border-top:1px solid var(--bd)}',
    'table.t td.good{color:var(--good)}table.t td.warn{color:var(--warn)}table.t td.bad{color:var(--bad)}table.t td.mu{color:var(--mu)}',
    'table.t tr.hl td{background:var(--tile);font-weight:600}',

    '.kvs{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px;font-size:12px}',
    '.kv i{font-style:normal;color:var(--mu);margin-right:5px}',
    '.line{font-size:11px;margin-top:8px;color:var(--mu)}',
    '.line.warn{color:var(--warn)}.line.bad{color:var(--bad)}.line.good{color:var(--good)}',
    '.empty{color:var(--mu);padding:18px 4px;text-align:center}',

    'h4{margin:16px 0 6px;font-size:11px;font-weight:600;color:var(--mu);letter-spacing:.3px}',
    'button.mg{display:flex;width:100%;margin:12px 0 6px;padding:0;border:0;background:none;color:var(--mu);font:inherit;font-size:11px;font-weight:600;letter-spacing:.3px;cursor:pointer;text-align:left}button.mg span{margin-left:auto;font-weight:400}button.mg:hover{color:var(--ac)}',
    'h4:first-child{margin-top:0}',
    '.sh{display:flex;align-items:flex-end;gap:8px;margin:16px 0 6px}.sh h4{margin:0;flex:1;padding-bottom:5px}',
    '.sh label.sp{display:flex;align-items:center;gap:6px}.sh label.sp input{width:86px;margin:0;text-align:right}',
    '.sh button.lk{background:none;border:0;color:var(--ac);font:inherit;font-size:11px;cursor:pointer;padding:0 0 5px}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    'label{display:block;color:var(--mu);font-size:11px}',
    'label.c{display:flex;align-items:center;gap:6px;color:var(--tx);font-size:12px;padding:2px 0}',
    'input,select{width:100%;margin-top:2px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px}',
    'input:focus,select:focus{outline:2px solid var(--ac);outline-offset:-1px}',
    'input[type=checkbox]{width:auto;margin:0}',
    '.row{display:flex;gap:8px;margin-top:12px}',
    'button.act{flex:1;background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:7px;padding:7px 10px;cursor:pointer;font:inherit;font-size:12px}',
    'button.act:hover{border-color:var(--ac);color:var(--ac)}button.act[disabled]{opacity:.45;cursor:default}',
    'pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:9px;margin:8px 0 0;',
    'font:11px/1.45 Consolas,"SF Mono",Menlo,monospace;color:var(--tx)}'
  ].join('');

  var hostEl = document.createElement('div');
  hostEl.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  var sr = hostEl.attachShadow({ mode: 'open' });
  var st = document.createElement('style'); st.textContent = CSS; sr.appendChild(st);
  var lookStyle = document.createElement('style'); sr.appendChild(lookStyle);   // gameLook()

  var root = document.createElement('div');
  root.className = 'root ' + (THEME === 'dark' ? 'dark' : 'light');
  sr.appendChild(root);

  var btn = document.createElement('div');
  // The logo: an astrolabe's ring with its hour marks and a star pointer.
  var LOGO = (function () {
    var ticks = '';
    for (var i = 0; i < 12; i++) {
      var a = i * Math.PI / 6, c = Math.cos(a), s2 = Math.sin(a);
      ticks += '<line x1="' + (32 + 27 * c).toFixed(1) + '" y1="' + (32 + 27 * s2).toFixed(1) + '" x2="' + (32 + 22 * c).toFixed(1) + '" y2="' + (32 + 22 * s2).toFixed(1) + '" stroke="#63b6dc" stroke-width="2"/>';
    }
    return '<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="none" stroke="#63b6dc" stroke-width="4"/>' +
      '<circle cx="32" cy="32" r="19" fill="none" stroke="#63b6dc" stroke-width="1.6" opacity=".6"/>' + ticks +
      '<path d="M32 13 L37 30 L32 51 L27 30 Z" fill="#e8b84a"/><circle cx="32" cy="32" r="3.4" fill="#0b1016" stroke="#e8b84a" stroke-width="2"/>' +
      '<circle cx="32" cy="3.5" r="3" fill="#63b6dc"/></svg>';
  })();
  btn.id = 'btn'; btn.innerHTML = '<span class="lg">' + LOGO + '<span class="dot"></span></span>Astrolabe';
  root.appendChild(btn);

  // The tab bar uses the game's own icons: the pictures of its left menu
  // (read from the page, so they follow the game's files) and two icons of
  // its sprite. The open tab also shows its name; a tab whose icon is not
  // there yet shows its name instead.
  var TABS = [
    ['out', 'Gathering', 'img', '#/gathering'], ['bat', 'Battling', 'img', '#/battling'], ['eq', 'Equipment', 'img', '#/player'],
    ['mkt', 'Market', 'img', '#/market'], ['eco', 'Economy', 'sym', 'boost_income'], ['battle', 'PvP', 'img', '#/battlefield'],
    ['an', 'Anomalies', 'sym', 'anomaly'], ['gal', 'Galaxy', 'img', '#/galaxy']
  ];
  function tabIcons() {
    TABS.forEach(function (t) {
      var b = panel.querySelector('#tabs button[data-tab="' + t[0] + '"]'), slot = b && b.querySelector('.ti');
      if (!slot || slot.firstChild) return;
      if (t[2] === 'img') {
        var im = document.querySelector('a[href="' + t[3] + '"] img'), src = im && im.getAttribute('src');
        if (src) slot.innerHTML = '<img src="' + String(src).replace(/"/g, '&quot;') + '" alt="">';
      } else if (document.getElementById(t[3])) {
        spriteIcons([t[3]]);
        slot.innerHTML = svgIcon(t[3], 20);
      }
      if (slot.firstChild) b.classList.add('hasic');
    });
  }

  var panel = document.createElement('div');
  panel.id = 'panel'; panel.style.display = 'none';
  panel.innerHTML =
    '<div id="bar"><span class="ttl">' + LOGO + '<b>Astrolabe</b><span class="beta" title="Still being added to and tested">beta</span>' +
    '<span class="ver">v' + esc(scriptVersion()) + '</span></span><span class="ctl">' +
    '<span class="g" id="settings" title="Settings">&#9881;</span>' +
    '<span class="g" id="theme" title="Light / dark">&#9680;</span>' +
    '<span class="g" id="close">hide</span></span></div>' +
    '<div id="quota"><span id="q1"></span><span id="q2"></span></div>' +
    '<div id="tabs">' + TABS.map(function (t, i) {
      return '<button data-tab="' + t[0] + '"' + (i ? '' : ' class="on"') + ' title="' + t[1] + '"><span class="ti"></span><span class="tn">' + t[1] + '</span></button>';
    }).join('') + '</div><div id="body"></div>' +
    '<svg width="0" height="0" style="position:absolute"><defs id="sprite"></defs></svg><div id="tip"></div>';
  root.appendChild(panel);

  function mount() { if (document.body && !document.body.contains(hostEl)) document.body.appendChild(hostEl); }
  mount();
  // Only the panel's own parents matter, so watching every change in the
  // whole game page is not needed. The tick re-checks
  // as well, so a rebuilt page is picked up within a few seconds either way.
  var pend = false;
  function watchMount() {
    if (pend) return;
    pend = true;
    requestAnimationFrame(function () { pend = false; mount(); });
  }
  try {
    var mo = new MutationObserver(watchMount);
    mo.observe(document.documentElement, { childList: true });
    if (document.body) mo.observe(document.body, { childList: true });
  } catch (e) {}

  function draggable(el, handle, key, onClick, locked) {
    var down = false, moved = false, sx = 0, sy = 0, sl = 0, sT = 0;
    var saved = store.get(key, null);
    if (saved) { el.style.left = saved.l + 'px'; el.style.top = saved.t + 'px'; }
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      down = true; moved = false; sx = e.clientX; sy = e.clientY;
      var r = el.getBoundingClientRect(); sl = r.left; sT = r.top;
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (locked && locked()) return;
      moved = true;
      el.style.left = clamp(0, window.innerWidth - 60, sl + dx) + 'px';
      el.style.top = clamp(0, window.innerHeight - 24, sT + dy) + 'px';
    }, true);
    window.addEventListener('mouseup', function (e) {
      if (!down) return;
      down = false;
      if (moved) { var r = el.getBoundingClientRect(); store.set(key, { l: Math.round(r.left), t: Math.round(r.top) }); }
      else if (onClick) onClick(e);
    }, true);
  }

  draggable(btn, btn, 'btnPos', function () {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    if (panel.style.display === 'flex') { if (!store.get('panelPos', null)) panelHome(); refreshFromStore(); render(); }
  }, function () { return docked; });

  /* ---- the button in the game's top bar ----
     The button sits in the game's own top bar, just left of the crown (the
     right-hand list of Quasar's header toolbar), in a small host of its own
     so the game's styles cannot reach it. The game can rebuild its top bar,
     so this is checked every second and the button put back; with no top
     bar to be found it floats as before. */
  var docked = false;
  var dock = document.createElement('div');
  dock.className = 'astrolabe-dock';
  dock.style.cssText = 'display:flex;align-items:center;margin-right:10px';
  var dockSr = dock.attachShadow({ mode: 'open' });
  var dockSt = document.createElement('style'); dockSt.textContent = CSS; dockSr.appendChild(dockSt);
  var dockRoot = document.createElement('div'); dockRoot.className = root.className + ' dk'; dockSr.appendChild(dockRoot);   // .dk: the docked look
  function topBarList() {
    try {
      var l = document.querySelectorAll('header.q-header .q-toolbar > .q-list.justify-end');
      return l.length ? l[l.length - 1] : null;
    } catch (e) { return null; }
  }
  function dockCheck() {
    var list = topBarList();
    if (list) {
      if (dock.parentNode !== list) list.insertBefore(dock, list.firstChild);
      if (btn.parentNode !== dockRoot) dockRoot.appendChild(btn);
      docked = true;
    } else if (docked || btn.parentNode !== root) {
      if (dock.parentNode) dock.parentNode.removeChild(dock);
      root.insertBefore(btn, root.firstChild);
      docked = false;
    }
  }
  dockCheck();
  setInterval(function () { try { dockCheck(); } catch (e) {} }, 1000);
  // A smaller window must not leave the panel out of reach (not saved: the
  // spot you chose comes back when the window does).
  window.addEventListener('resize', function () {
    if (panel.style.display === 'none') return;
    var r = panel.getBoundingClientRect();
    if (r.right > window.innerWidth) panel.style.left = Math.max(0, Math.round(window.innerWidth - r.width - 4)) + 'px';
    if (r.top > window.innerHeight - 40) panel.style.top = Math.max(0, Math.round(window.innerHeight - 40)) + 'px';
  });
  // Just under the button, its right edges lined up (or the first place, when
  // the button floats).
  function panelHome() {
    if (!docked) { panel.style.left = '10px'; panel.style.top = '52px'; return; }
    var r = btn.getBoundingClientRect(), w = panel.offsetWidth || 440;
    panel.style.left = clamp(4, Math.max(4, window.innerWidth - w - 4), Math.round(r.right - w)) + 'px';
    panel.style.top = Math.round(r.bottom + 6) + 'px';
  }
  draggable(panel, panel.querySelector('#bar'), 'panelPos', null);
  panel.querySelector('#close').addEventListener('click', function (e) { e.stopPropagation(); panel.style.display = 'none'; });
  panel.querySelector('#theme').addEventListener('click', function (e) {
    e.stopPropagation();
    THEME = THEME === 'dark' ? 'light' : 'dark';
    root.className = 'root ' + THEME;
    dockRoot.className = root.className + ' dk';
    store.set('theme', THEME);
  });

  var tab = 'out';
  // Every tab but Settings is redrawn by the regular update. Settings is left
  // alone so a redraw does not throw away what is being typed in it.
  function liveTab() { return tab !== 'in'; }
  panel.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () { tab = b.getAttribute('data-tab'); render(); });
  });
  // The hover cards of the Equipment tab (anything with a data-tip).
  (function () {
    var body = panel.querySelector('#body'), tip = panel.querySelector('#tip');
    body.addEventListener('mousemove', function (e) {
      var c = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!c) { tip.style.display = 'none'; return; }
      tip.innerHTML = c.getAttribute('data-tip').split('|').map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
      tip.style.display = 'block';
      tip.style.left = Math.max(4, Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = Math.max(4, Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8)) + 'px';
    });
    body.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  })();
  // Settings opens from this header icon rather than sitting in the
  // tab bar, to leave room there for the tabs someone actually switches
  // between. Which control shows as "on" is settled centrally in render0(),
  // since this click is not one of the #tabs buttons.
  panel.querySelector('#settings').addEventListener('click', function (e) { e.stopPropagation(); tab = 'in'; render(); });

  /* ---- small building blocks ---- */

  function tile(label, value, sub, cls) {
    return '<div class="tile"><div class="tl">' + esc(label) + '</div><div class="tv' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</div>' +
      (sub ? '<div class="ts">' + esc(sub) + '</div>' : '') + '</div>';
  }

  // A cell is a string, or {t: text, c: class}. No head: no header row.
  function tbl(head, rows, hlRow) {
    var h = '<div class="card"><table class="t">' + (head ? '<thead><tr>' +
      head.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead>' : '') + '<tbody>';
    rows.forEach(function (r, i) {
      h += '<tr' + (hlRow === i ? ' class="hl"' : '') + '>' + r.map(function (c) {
        if (c === null || c === undefined) return '<td class="mu">--</td>';
        if (typeof c === 'object') return '<td class="' + (c.c || '') + '">' + esc(c.t) + '</td>';
        return '<td>' + esc(c) + '</td>';
      }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function kvs(pairs) {
    return '<div class="kvs">' + pairs.filter(function (p) { return p; }).map(function (p) {
      return '<span class="kv"><i>' + esc(p[0]) + '</i>' + esc(p[1]) + '</span>';
    }).join('') + '</div>';
  }

  function line(text, cls) { return '<div class="line' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</div>'; }
  function sect(t) { return '<h4>' + esc(t) + '</h4>'; }
  function pct(x, dp) { return x === null || x === undefined || isNaN(x) ? '--' : (x * 100).toFixed(dp === undefined ? 1 : dp) + '%'; }

  var FIELD_MAP = {};

  function field(id, label, bag, key, type) {
    FIELD_MAP[id] = { bag: bag, key: key, type: type || 'num' };
    var v = S[bag][key];
    if (type === 'check') return '<label class="c"><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + '>' + label + '</label>';
    if (type === 'node') {
      var o = Object.keys(NODES).map(function (n) { return '<option' + (n === v ? ' selected' : '') + '>' + n + '</option>'; }).join('');
      return '<label>' + label + '<select id="' + id + '">' + o + '</select></label>';
    }
    return '<label>' + label + '<input type="number" step="any" id="' + id + '" value="' + (typeof v === 'number' ? Math.round(v * 100) / 100 : v) + '"></label>';
  }

  function wireFields() {
    Object.keys(FIELD_MAP).forEach(function (id) {
      var el = panel.querySelector('#' + id);
      if (!el) return;
      var f = FIELD_MAP[id];
      el.addEventListener(f.type === 'num' ? 'input' : 'change', function () {
        S[f.bag][f.key] = f.type === 'check' ? el.checked : (f.type === 'node' ? el.value : (numOr(el.value) === null ? 0 : numOr(el.value)));
        if (f.key === 'node') S.inputs.autoNode = false;   // a manual choice stops the auto-follow
        saveInputs();
        if (f.key === 'activeOnly' && S.storeState) refreshFromStore();
        if (f.key === 'marketAuto' || f.key === 'reserve') scheduleMarket();
        if (f.key === 'storePoll') startStorePoll();
        // Rebuilding the tab on every keystroke drops the cursor from a number
        // box, so typing only refreshes the quota line.
        if (tab === 'in' && f.type === 'num') renderQuota(); else render();
      });
    });
  }

  /* ---- Suggestions (bottom of Yield) ---- */

  function arrow(a, b) { return a === b ? '--' : fmt(a) + ' \u2192 ' + fmt(b); }

  function renderSuggest(crPerH) {
    var cx = upgradeContext();
    if (!cx) return '';
    var h = '<div class="sh"><h4>Suggestions</h4><label class="sp">Spend<input id="f_spend" type="text" inputmode="decimal" autocomplete="off" placeholder="all" value="' + esc(amountText(S.inputs.spendLimit)) + '"></label>' +
      (S.inputs.spendLimit > 0 ? '<button class="lk" id="b_spendall">all</button>' : '') + '</div>';
    if (spendErr) h += line(spendErr, 'warn');
    if (cx.need) return h + line('Prices are needed first.');

    var pl = upgradePlan(cx), dr = droidOption(cx), have = S.credits || 0;
    if (pl.limit && pl.limit > pl.avail && pl.avail > 0) h += line('You have ' + fmt(pl.avail) + ' to spend, less than the ' + fmt(pl.limit) + ' entered.');
    if (pl.steps) {
      h += '<div class="tiles">' +
        tile('Spend', fmt(pl.cost), 'of ' + fmt(pl.budget) + (pl.limit && pl.limit < pl.avail ? ' limit' : ' credits')) +
        tile('Extra / h', '+' + fmt(pl.gain), '+' + (pl.base ? (pl.gain / pl.base * 100).toFixed(1) : '0') + '% of ' + fmt(pl.base)) +
        tile('Pays back', durFmt(pl.payback), 'break-even', pl.payback !== null && pl.payback <= S.inputs.maxPaybackDays * 24 ? 'good' : 'warn') + '</div>';

      // Droids that get the same plan are shown as one row.
      var groups = [];
      pl.rows.forEach(function (r) {
        if (!r.cost) return;
        var key = r.from.concat(r.to).join('/'), g = groups[groups.length - 1];
        if (g && g.key === key) { g.last = r.idx; g.cost += r.cost; g.n++; }
        else groups.push({ key: key, first: r.idx, last: r.idx, r: r, cost: r.cost, n: 1 });
      });
      var rows = groups.map(function (g) {
        return [g.first === g.last ? '#' + g.first : '#' + g.first + '-' + g.last,
          arrow(g.r.from[0], g.r.to[0]), arrow(g.r.from[1], g.r.to[1]), arrow(g.r.from[2], g.r.to[2]), fmt(g.cost)];
      });
      h += tbl(['Droid', 'Efficiency', 'Storage', 'Maneuver', 'Cost'], rows);
      h += kvs([
        ['First step pays back', durFmt(pl.first)],
        ['Last step', durFmt(pl.last)],
        pl.stop === 'payback' ? ['Stopped at', S.inputs.maxPaybackDays + ' d limit'] : null
      ]);
    } else {
      h += line(have <= (S.inputs.keepCredits || 0) ? 'No spare credits for upgrades.' : (pl.limit && pl.limit < pl.avail && pl.stop === 'budget' ? 'Nothing fits in ' + fmt(pl.limit) + '. Enter a larger amount, or "all".' : 'No upgrade pays back within ' + S.inputs.maxPaybackDays + ' days.'));
    }

    if (dr) {
      var short = dr.cost - have;
      h += tbl(['Other option', 'Cost', 'Extra / h', 'Pays back'], [[
        'Buy droid #' + dr.n, (dr.est ? '~' : '') + fmt(dr.cost), '+' + fmt(dr.gain), durFmt(dr.payback)]]);
      h += line((short > 0
        ? 'Droid #' + dr.n + ': ' + fmt(short) + ' short' + (crPerH > 0 ? ', about ' + durFmt(short / crPerH) + ' of income' : '') + '. Assumes a new droid starts at 0% and is upgraded to your average.'
        : 'Droid #' + dr.n + ' is affordable now. Assumes a new droid starts at 0% and is upgraded to your average.') +
        (dr.est ? ' Its price is estimated (x10 per droid) until you open your droids panel in the game.' : ''));
    }
    return h;
  }

  /* ---- Yield ---- */

  function sourcesTotal() { return S.sources.reduce(function (a, x) { return a + x.pct; }, 0); }

  function renderOut() {
    var p = projection(), hours = Math.max(0, S.inputs.hours), crPerH = 0, anyDepth = false, partial = false, missing = [], rows = [];
    p.rows.forEach(function (r) {
      var b = bookFor(S.books, r.name);
      if (b.bid === null && b.ask === null) missing.push(r.name);
      var f = fillAgainst(b.bidDepth, r.qty * hours), cr = null;
      if (f) { anyDepth = true; if (f.unfilled > 0) partial = true; cr = f.total / (hours || 1); }
      else if (b.bid !== null) cr = b.bid * r.qty;
      if (cr !== null) crPerH += cr;
      rows.push([r.name, fmt(r.qty), priceTxt(b.bid), priceTxt(b.ask), cr === null ? null : fmt(cr)]);
    });

    var emp = p.emp, st = p.st, nHere = st ? st.n : 0;
    var cls = emp ? '' : 'est';
    var ds = effectiveDroids(), avgF = ds.length ? ds.reduce(function (a, d) { return a + 1 + (d.eff + d.sto) / 100; }, 0) / ds.length : 1;

    var h = '<div class="tiles">' +
      tile('Credits / h', fmt(crPerH), anyDepth ? 'order book' : 'top of book') +
      tile('Credits / ' + hours + 'h', fmt(crPerH * hours)) +
      tile('Survival', pct(p.sim.survival), emp ? emp.n + ' actions' : 'estimate ' + nHere + '/' + S.inputs.minActions, cls) +
      tile('Rare share', pct(p.sim.rareChance), emp ? emp.n + ' actions' : 'estimate ' + nHere + '/' + S.inputs.minActions, cls) +
      tile('Common / h', fmt(p.sim.common), 'all four') +
      tile('Rare / h', fmt(p.sim.rare), p.node.rare) + '</div>';

    h += tbl(['Resource', '/ h', 'Bid', 'Ask', 'Cr / h'], rows, rows.length - 1);

    h += kvs([
      ['Node', S.inputs.node + (S.inputs.autoNode ? '' : ' (manual)')],
      ['Droids', String(p.sim.count)],
      ['Level', String(S.inputs.gatheringLevel)],
      S.sources.length ? ['Resource bonus', '+' + fmt(sourcesTotal()) + '%'] : null,
      ['Ore / droid', fmt(p.sim.kCommon * avgF, 0) + ' / ' + fmt(p.sim.kRare * avgF, 0)],
      st && st.taxRate !== null ? ['Squadron tax', pct(st.taxRate, 1) + ' of gross'] : null
    ]);

    // Only problems and the age of the prices are shown here.
    if (!S.storeOk) h += line('The game page is not readable yet.', 'warn');
    else if (S.gather && !S.gather.isGathering) h += line('Not gathering right now, nothing new is logged.', 'warn');
    if (S.authFail) h += line('API key refused, prices will not refresh.', 'bad');
    else if (!S.key && !S.marketSource) h += line('No API key found. Add it in Settings.', 'warn');
    else if (S.lastErr) h += line(S.lastErr, 'bad');
    else if (S.marketStamp) h += line('Prices ' + hhmm(Date.now() - S.marketStamp) + ' old');
    else h += line('No prices yet.', 'warn');
    var hold = marketHold();
    if (hold) h += line(hold, 'warn');
    if (p.sim.rareChance >= 1) h += line('Rare chance reads 100%, so common output is zero. Check the rare-chance mods on your ship in the game, or Rare chance +% in Settings.', 'warn');
    if (partial) h += line('Not enough bid depth for ' + hours + 'h of output.', 'warn');
    if (missing.length && S.marketSource) h += line('No prices for: ' + missing.join(', '), 'warn');

    h += '<div class="row"><button class="act" id="b_market"' + (remaining('market') > 0 && !tripped('market') ? '' : ' disabled') + '>Refresh prices (1 call)</button></div>';
    h += renderSuggest(crPerH);

    // What was actually logged: per-survivor ore (Common/h and Rare/h above are
    // rates, this is the raw amount) and the per-resource split behind the /h
    // column, in case it ever needs checking.
    h += sect('Logged actions');
    if (!st) {
      h += line('No gathering actions logged on the ' + esc(S.inputs.node) + ' node yet.');
    } else {
      h += kvs([
        ['Actions', st.n + ', ' + ((st.last - st.first) / 3.6e6).toFixed(1) + 'h logged'],
        ['Common ore', (st.kCommon !== null ? fmt(st.kCommon * avgF, 0) : '--') + ' per survivor'],
        ['Rare ore', (st.kRare !== null ? fmt(st.kRare * avgF, 0) : '--') + ' per survivor']
      ]);
      var order = p.node.commons.concat([p.node.rare]);
      var actRows = order.map(function (n) {
        var k = normName(n), cnt = st.perRes[k] || 0;
        return [n, String(cnt), pct(cnt / st.n)];
      });
      h += tbl(['Resource', 'Actions', 'Share'], actRows, actRows.length - 1);
      if (st.n < S.inputs.minActions) h += line((S.inputs.minActions - st.n) + ' more actions before the /h split above uses this instead of an even guess.');
      else if (st.n < 60) h += line('Small sample. Settles after about 60 actions.');
    }
    return h;
  }

  /* ---- Settings ---- */

  function renderIn() {
    FIELD_MAP = {};
    var h = sect('Scenario') + '<div class="grid">' +
      field('f_node', 'Node type', 'inputs', 'node', 'node') +
      field('f_hours', 'Hours', 'inputs', 'hours') + '</div>' +
      '<div class="grid" style="margin-top:8px">' +
      field('f_anode', 'Follow current node', 'inputs', 'autoNode', 'check') +
      field('f_uobs', 'Use measured values', 'inputs', 'useObserved', 'check') + '</div>';

    h += sect('Upgrade suggestions') + '<div class="grid">' +
      field('f_keep', 'Credits to keep', 'inputs', 'keepCredits') +
      field('f_pay', 'Max payback (days)', 'inputs', 'maxPaybackDays') + '</div>';

    h += sect('Battle plan') + '<div class="grid">' +
      field('f_kb', 'Badges to keep', 'inputs', 'keepBadges') +
      field('f_gap', 'Least gain worth a change (win %)', 'inputs', 'bestGap') + '</div>';

    h += sect('Prices') + '<div class="grid">' +
      field('f_mauto', 'Auto-refresh market', 'inputs', 'marketAuto', 'check') +
      field('f_res', 'Calls kept in reserve', 'inputs', 'reserve') + '</div>';

    // The key belongs to each player. It is read from their own game account;
    // pasting one here overrides that. The saved key is never shown back.
    var keyMsg = S.authFail ? 'The server refused this key' + (S.authMsg ? ': "' + S.authMsg + '"' : '') + (S.bannedUntil ? ', suspended until ' + atTxt(S.bannedUntil) : '') +
        '. ' + (S.gameKey && S.gameKey !== S.key ? 'Your game account holds a different key; it is tried next.' : 'The key matches the one in your game account, so check Profile > Game API: regenerate it if the game shows none, and make sure this is the Steam realm key.')
      : (!S.key ? 'No key found in your game account. Copy it from Profile > Game API and paste it here.'
        : (S.keySource === 'manual' ? 'Using the key you entered (' + S.key.length + ' characters).' : 'Using the key from your game account (' + S.key.length + ' characters).'));
    h += sect('API key') +
      '<label><input type="password" id="f_key" autocomplete="off" value="" placeholder="' +
      (!S.key ? 'paste your API key, then press Enter' : (S.keySource === 'manual' ? 'saved key in use, type a new one and press Enter' : 'found automatically; type one to override')) + '"></label>';
    if (keySavedAt && Date.now() - keySavedAt < 120000) h += line('Key saved ' + hhmm(Date.now() - keySavedAt).replace(/^0m$/, 'just now') + (S.busy ? ', trying it now...' : S.authFail ? ', and refused.' : S.lastErr ? ', last try: ' + S.lastErr : ', prices ' + (S.marketStamp ? hhmm(Date.now() - S.marketStamp) + ' old' : 'not loaded yet') + '.'), S.authFail ? 'bad' : 'good');
    h += line(keyMsg, !S.key || S.authFail ? 'warn' : '');
    if (S.gameKey && S.key && S.gameKey !== S.key && !S.authFail) h += line('Your game account shows a different key (' + S.gameKey.length + ' characters). If this one is refused, the game\'s is tried next.', 'mu');

    // Without a readable game page the droid stats have to be typed in.
    if (!S.storeOk || !(S.droids && S.droids.length)) {
      h += sect('Droids (manual)') + '<div class="grid">' +
        field('f_dn', 'Count', 'inputs', 'droidCount') +
        field('f_gl', 'Gathering level', 'inputs', 'gatheringLevel') +
        field('f_de', 'Avg efficiency %', 'inputs', 'droidEff') +
        field('f_ds', 'Avg storage %', 'inputs', 'droidSto') +
        field('f_dm', 'Avg maneuver %', 'inputs', 'droidMan') +
        field('f_brc', 'Rare chance +%', 'inputs', 'bRareChance') +
        field('f_bdg', 'Dodge +%', 'inputs', 'bDodge') + '</div>';
    } else {
      h += sect('Droids') + '<div class="grid">' +
        field('f_act', 'Active droids only', 'inputs', 'activeOnly', 'check') + '</div>';
    }

    h += sect('Recorded data') +
      '<div class="row" style="margin-top:0"><button class="act" id="b_clearacts">Clear action log</button></div>';
    h += '<div class="row"><label class="c"><input type="checkbox" id="f_recan"' + (S.inputs.recAnomalies === false ? '' : ' checked') + '>Record anomaly drops</label></div>';
    if (Object.keys(S.anomalies).length) h += '<div class="row" style="margin-top:0"><button class="act" id="b_clearan">Clear anomaly log</button></div>';
    h += sect('Panel') + '<div class="row" style="margin-top:0"><button class="act" id="b_panelhome">Put the panel back under the button</button></div>';
    h += sect('Troubleshooting') +
      '<div class="row" style="margin-top:0"><button class="act" id="b_report">Copy report</button></div>' +
      line('Copies a short report of what the script sees, to paste into a chat. Your API key is never included.');
    return h;
  }

  /* ---- Battle ---- */

  var bsub = 'cur', bshow = false;
  var pvBusy = null, pvFailed = null, pvMemo = { key: null, plan: null };
  var pvCheck = {}, pvCheckBusy = false;

  function grp(x) { return Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function cap(x) { x = String(x || ''); return x.charAt(0).toUpperCase() + x.slice(1); }
  function pts1(x) { return (x >= 0 ? '+' : '') + x.toFixed(1); }

  function whenTxt(ms) {
    var d = new Date(ms), n = new Date(), t = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var day = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    return day === 0 ? 'Today ' + t : (day === 1 ? 'Yesterday ' + t : d.getDate() + '/' + (d.getMonth() + 1) + ' ' + t);
  }

  // Watches the game's loaded duel and keeps a small record of it, whichever
  // tab is open. The game empties that slot every time you go back to the
  // Duels log (Battlefield > Battle Log > Arena), so a look every 10 seconds
  // could miss a duel you opened and left. This looks once a second, and each
  // look is one guarded read of one field, not a search of the game's memory.
  var REC_WATCH_MS = 1000;   // how often the loaded-duel slot is looked at
  var REC_TRIES = 5;         // looks a duel that will not file gets before it is left alone
  var recSeen = null;        // the loaded duel, once it is filed or given up on
  var recTries = { fp: null, n: 0 };
  var recRoot = null, recFindAt = 0, recTimer = null;

  // The live game state, found once and kept. The Arena store only exists
  // after the Arena page has been opened, so it is read from here and not from
  // the copy the last 10-second tick took, which may predate it.
  function recState() {
    if (recRoot && !recRoot.UserStore) recRoot = null;
    if (!recRoot && Date.now() - recFindAt >= 3000) {
      recFindAt = Date.now();
      try { var p = findPinia(); recRoot = (p && p.state && p.state.value) || null; } catch (e) {}
    }
    return recRoot;
  }

  // A duel is recorded whenever the game has one loaded: right after a
  // fight, or when one is opened in Battlefield > Battle Log > Arena.
  function recTick() {
    if (S.inputs.recBattles === false) return;
    var st = recState(), A = st && st.PvPArenaStore, d;
    try { d = A && A.currentDuel; } catch (e) { return; }
    if (!d || !d.logs || !d.logs.length) return;
    var fp = (d._id || '') + '|' + d.logs.length;
    if (fp === recSeen) return;
    var me = st.UserStore && st.UserStore.username;
    var rec = arBuild(d, me, readPvp(st), Date.now());
    if (!rec) {
      // Something may just not be readable yet (our build, our name), so it
      // gets a few more looks before it is left alone.
      if (recTries.fp !== fp) recTries = { fp: fp, n: 0 };
      if (++recTries.n >= REC_TRIES) recSeen = fp;
      return;
    }
    recSeen = fp;
    var key = arKey(rec);
    if (S.battles.some(function (r) { return arKey(r) === key; })) return;
    S.battles.push(rec);
    S.battles.sort(function (x, y) { return x.t - y.t; });
    if (S.battles.length > AR_MAX) S.battles = S.battles.slice(-AR_MAX);
    store.set('battles', S.battles);
    if (panel.style.display !== 'none' && tab === 'battle') render();
  }

  // The plan takes a couple of seconds, in small pieces after the tab has
  // drawn. It is kept until the build, the recorded battles or the settings change.
  function pvRequest(pv) {
    var recs = S.battles, keep = S.inputs.keepBadges || 0;
    // With no duels on record the plan still runs, against the meta field.
    var key = pvPlanKey(pv, keep, recs);
    if (pvMemo.key === key) return pvMemo.plan;
    if (pvBusy !== key && pvFailed !== key) {
      pvBusy = key;
      // In the background worker (12i): same code, same seeds, same plan.
      var w = wkRun({ kind: 'pvp', pv: pv, recs: recs, keep: keep }, function (m) {
        if (m.type !== 'plan' && m.type !== 'error') return;
        if (pvBusy === key) pvBusy = null;
        if (m.type === 'error' || m.err || !m.plan) { pvFailed = key; setErr('The battle plan failed: ' + (m.err || 'no plan')); }
        else pvMemo = { key: key, plan: m.plan };
        if (panel.style.display !== 'none' && tab === 'battle') render();
      });
      if (!w) { pvBusy = null; pvFailed = key; setErr('The battle plan needs a background worker, and this browser refused one.'); }
    }
    return null;
  }

  // One build as two small tables: where the points go, and what each piece
  // does. When `vs` is given, every value that differs from it is green.
  function buildTables(b, tot, vs, vsTot) {
    var g = pvGearBase(b), g0 = vs ? pvGearBase(vs) : null;
    function c(x, y, f) { return vs && x !== y ? { t: f ? f(x) : String(x), c: 'good' } : (f ? f(x) : String(x)); }
    var h = tbl(['Stat', 'Points', 'Gear + pet', 'Total'], PVP_STATS.map(function (s) {
      return [cap(s), c(b.pts[s], vs && vs.pts[s], grp), c(g[s], vs && g0[s], grp), c(tot[s], vs && vsTot[s], grp)];
    }));
    h += tbl(['Piece', 'Level', 'Tier', 'Stat', 'Skill'], b.gear.map(function (x, i) {
      var o = vs && vs.gear[i];
      return [cap(x.name), c(x.L, o && o.L), c(x.T, o && o.T), c(cap(x.stat), o && cap(o.stat)), c(cap(x.skill), o && cap(o.skill))];
    }));
    return h;
  }

  function hitLines(t, ref, t1) {
    var a = t.precision / (t.precision + ref.evasion), b = ref.precision / (ref.precision + t.evasion);
    if (!t1) return kvs([['You hit', pct(a, 0)], ['They hit', pct(b, 0)]]);
    var a1 = t1.precision / (t1.precision + ref.evasion), b1 = ref.precision / (ref.precision + t1.evasion);
    return kvs([['You hit', pct(a, 0) + ' \u2192 ' + pct(a1, 0)], ['They hit', pct(b, 0) + ' \u2192 ' + pct(b1, 0)]]);
  }

  function subTabs() {
    return '<div class="seg">' + [['cur', 'Current'], ['best', 'Best'], ['up', 'Upgrades'], ['fights', 'Duels']].map(function (x) {
      return '<button data-sub="' + x[0] + '"' + (bsub === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>';
    }).join('') + '</div>';
  }

  function renderBattle() {
    var pv = S.storeOk ? readPvp(S.storeState) : null;
    if (!pv) return '<div class="empty">The battlefield data is not readable yet.</div>';
    var h = subTabs();
    if (bsub === 'fights') return h + renderFights();
    var plan = pvRequest(pv);
    if (bsub === 'best') return h + renderBest(pv, plan);
    if (bsub === 'up') return h + renderUp(pv, plan);
    return h + renderCur(pv, plan);
  }

  function waitLine() {
    return S.battles.length ? line(S.lastErr && pvFailed ? S.lastErr : 'Working out the numbers...') : '';
  }

  function renderCur(pv, plan) {
    var t0 = pvTotals(pv), h = '';
    h += '<div class="tiles">' + tile('Damage', grp(t0.damage), 'per clone hit') + tile('Health', grp(t0.hp), 'per clone') +
      tile('Win rate', plan ? pvPct(plan.cur.score) + '%' : '--',
        plan ? (plan.synthetic ? 'vs the meta field' : '\u00b1' + seTxt(plan.cur.se) + ', ' + plan.pool + ' duel' + (plan.pool === 1 ? '' : 's')) : 'working') + '</div>';
    h += sect('Stat points') + buildTables(pv, t0);
    if (plan) h += hitLines(t0, plan.ref);
    else h += waitLine();
    h += line(plan && plan.synthetic
      ? 'Read from your game. The win rate is how often this build wins a simulated duel against the meta field at your own total stat (see Best), half attacking and half defending. It switches to your real opponents once ' + PV_FLOOR + ' duels are on record.'
      : 'Read from your game. The win rate is how often this build wins a simulated duel against the arena opponents on record, half of them attacking and half defending.');
    if (plan) h += confLine(plan);
    return h;
  }

  // The meta from self-play next to the build as it is: points per stat at
  // this player's own total, so it can be copied straight into the game.
  // The second column is the best answer to a ladder of even-split players.
  // Where the PvP points go to land on a split, with the gear and pet as they
  // are: the target total per stat is its share of (points + gear + pet), and
  // the points make up what the gear does not. A stat the gear already pushes
  // past its target gets no points, and its surplus is spread over the others
  // by their shares, so the pool is spent in full.
  function metaPoints(pv, frac) {
    var base = pvGearBase(pv), pool = Math.max(0, Math.round(pv.pool)), total = pool;
    PVP_STATS.forEach(function (s) { total += base[s]; });
    var pts = {}, open = PVP_STATS.slice(), left = pool;
    for (var guard = 0; guard < 5 && open.length; guard++) {
      var share = 0; open.forEach(function (s) { share += frac[PVP_STATS.indexOf(s)]; });
      var baseOpen = 0; open.forEach(function (s) { baseOpen += base[s]; });
      var over = [];
      open.forEach(function (s) {
        var want = (left + baseOpen) * frac[PVP_STATS.indexOf(s)] / share - base[s];
        if (want < 0) { pts[s] = 0; over.push(s); } else pts[s] = want;
      });
      if (!over.length) break;
      open = open.filter(function (s) { return over.indexOf(s) < 0; });
    }
    // whole points that add up to the pool
    var used = 0; PVP_STATS.forEach(function (s) { pts[s] = Math.floor(pts[s] || 0); used += pts[s]; });
    while (used < pool) { var best = null, bd = -Infinity; PVP_STATS.forEach(function (s, i) { var d = frac[i] * total - base[s] - pts[s]; if (d > bd) { bd = d; best = s; } }); pts[best]++; used++; }
    return pts;
  }

  // The active stat of each gear piece, chosen so the split is reachable: of
  // all 4^pieces assignments, the one whose totals (with the points then
  // placed by metaPoints) land nearest the target shares. The assignment
  // itself is worth nothing, only the totals are (checked by simulation: any
  // assignment that still lets the points reach 35/15/15/35 scores the
  // same); it matters once the gear is most of the total, where one piece per
  // stat usually lands closest. Ties keep the pieces as they are.
  function metaGear(pv, frac) {
    var n = pv.gear.length, total = Math.pow(PVP_STATS.length, n), best = null;
    // "Nearest" is judged by the planner's own strength formula against a
    // meta opponent at the same total (pvTerm), not by distance in the
    // shares: too little precision or evasion hurts more than too much, and
    // the formula knows that (30/20/20/30 beats 40/10/10/40, as the
    // simulation also says).
    var budget = Math.max(0, Math.round(pv.pool)), b0 = pvGearBase(pv);
    PVP_STATS.forEach(function (s) { budget += b0[s]; });
    var ref = { precision: frac[1] * budget, evasion: frac[2] * budget };
    for (var a = 0; a < total; a++) {
      var c = pvCopy(pv), x = a, same = true;
      for (var i = 0; i < n; i++) { c.gear[i].stat = PVP_STATS[x % PVP_STATS.length]; if (c.gear[i].stat !== pv.gear[i].stat) same = false; x = Math.floor(x / PVP_STATS.length); }
      var pts = metaPoints(c, frac), base = pvGearBase(c), t = {}, score = 0, sum = 0, off = 0;
      PVP_STATS.forEach(function (s) { t[s] = base[s] + pts[s]; score += pvTerm(s, t[s], ref); sum += t[s]; });
      PVP_STATS.forEach(function (s, i) { off = Math.max(off, Math.abs((sum ? t[s] / sum : 0) - frac[i])); });
      // An assignment that lands on the split (every share within a point)
      // is as good as any other that does, so the pieces stay as they are
      // when they already allow it; the formula only decides when none does.
      var hit = off <= 0.01, cand = { gear: c.gear, pts: pts, base: base, t: t, score: score, same: same, hit: hit };
      if (!best) { best = cand; continue; }
      if (hit && !best.hit) best = cand;
      else if (hit === best.hit) {
        if (hit) { if (same) best = cand; }   // any assignment that lands is fine: keep the pieces as they are when they do
        else if (score > best.score + 1e-9 || (same && score >= best.score - 1e-9)) best = cand;
      }
    }
    return best;
  }

  function metaTable(pv, t0) {
    var budget = t0.power + t0.precision + t0.evasion + t0.hull;
    var meta = PV_META[0].f, naive = PV_NAIVE_BEST, gm = metaGear(pv, meta), gn = metaGear(pv, naive), pm = gm.pts, pn = gn.pts;
    var rows = PVP_STATS.map(function (s, i) {
      var now = t0[s], share = budget ? now / budget : 0;
      return [cap(s), grp(pv.pts[s] || 0) + ' pts, ' + grp(now) + ' (' + Math.round(share * 100) + '%)',
        { t: grp(pm[s]) + ' pts', c: Math.abs(pm[s] - (pv.pts[s] || 0)) > 1 ? 'good' : '' }, grp(gm.t[s]) + ' (' + Math.round(gm.t[s] / budget * 100) + '%)',
        { t: grp(pn[s]) + ' pts', c: Math.abs(pn[s] - (pv.pts[s] || 0)) > 1 ? 'good' : '' }];
    });
    function gearTxt(g) { return g.map(function (x) { return cap(x.name) + ' ' + cap(x.stat); }).join(', '); }
    rows.push(['Gear stats', gearTxt(pv.gear), { t: gm.same ? 'as now' : gearTxt(gm.gear), c: gm.same ? '' : 'good' }, '', { t: gn.same ? 'as now' : gearTxt(gn.gear), c: gn.same ? '' : 'good' }]);
    rows.push(['Skills', pv.gear.map(function (g) { return cap(g.skill); }).join(', '), { t: 'Block x4, or DoT + Block x3', c: 'b' }, '', { t: 'Block x4', c: 'b' }]);
    var h = sect('The meta, at your total stat') + tbl(['', 'You now', 'Meta: your points', 'Meta total', 'Even-split ladder: points'], rows);
    h += line('"Your points" is where to put your ' + grp(pv.pool) + ' PvP stat points, with the gear stats in the row below, to land on that split; green differs from now. Which stat a piece carries is worth nothing in itself: it only matters that the points can still reach the split. The row picks the assignment that lands nearest; a stat the gear already pushes past its share gets no points.', 'mu');
    h += line('From self-play on this simulator at equal total stat: the split no build beats on average. Attacker and defender want the same split; the defender can afford a DoT piece or two. Stun and Focus lose at equal budget. Against a young ladder of even-split players, more precision pays.', 'mu');
    h += line('Total stat decides most duels before the split does: 15% less than your opponent is 3 wins in 100 whatever the build. Gear levels and tiers beat any re-split.', 'mu');
    return h;
  }

  // An error bar reads better with a decimal while it is small.
  function seTxt(se) { return se >= 10 ? String(Math.round(se)) : String(Math.round(se * 10) / 10); }

  // How sure the numbers are, in plain words, and what would tighten them.
  function confLine(plan) {
    var n = plan.pool, se = plan.cur ? plan.cur.se : 50;
    if (plan.synthetic) {
      return line('Meta field: ' + (n ? n + ' duel' + (n === 1 ? '' : 's') : 'no duel') + ' on record, under the ' + PV_FLOOR +
        ' needed, so the numbers are against the simulated equal-budget meta instead of your real opponents. Fight in the arena, or open duels in Battlefield > Battle Log > Arena, and they take over.', 'warn');
    }
    var word = se > 12 ? 'Rough' : (se > 7 ? 'Fair' : (se > 4 ? 'Good' : 'Strong'));
    var txt = word + ': ' + n + ' duel' + (n === 1 ? '' : 's') + ' on record, win rate good to about ' +
      String.fromCharCode(177) + seTxt(se) + ' points.';
    if (plan.need > 0) txt += ' About ' + plan.need + ' more would bring it to ' + String.fromCharCode(177) + '5.';
    return line(txt, n < PV_FLOOR ? 'warn' : '');
  }

  function renderBest(pv, plan) {
    if (!plan) return waitLine() || line('Working out the numbers...');
    var t0 = pvTotals(pv);
    if (plan.stop) {
      return '<div class="tiles">' + tile('Duels', String(plan.pool), 'on record') +
        tile('Win rate', pvPct(plan.cur.score) + '%', '\u00b1' + seTxt(plan.cur.se)) +
        tile('Verdict', 'Nothing to tune', plan.decided + ' already settled', 'good') + '</div>' +
        line('Every opponent on record is one you always beat or always lose to, so no change of build would alter a single result. This will have something to say once you meet someone closer to your own strength.') +
        confLine(plan) + metaTable(pv, t0);
    }
    var f = plan.free, h = '';
    // The gain has to beat its own error bar, not a number I picked.
    var bar = Math.max(2 * f.se, S.inputs.bestGap || 0), worth = f.gain > bar;
    var pm = String.fromCharCode(177);
    if (!worth && !bshow) {
      h += '<div class="tiles">' + tile('Win rate now', pvPct(plan.cur.score) + '%', pm + seTxt(plan.cur.se)) +
        tile('Best found', pvPct(f.score) + '%', pts1(f.gain) + ' ' + pm + seTxt(f.se)) +
        tile('Verdict', 'In range', 'keep your build', 'good') + '</div>';
      h += line('The best change found is worth ' + pts1(f.gain) + ' points of win rate, give or take ' + seTxt(f.se) +
        '. That is inside the noise, so it is not a real improvement and your build stays as it is.');
      h += confLine(plan);
      h += '<div class="row"><button class="act" id="b_showbest">Show the best found anyway</button></div>';
      return h + metaTable(pv, t0);
    }
    h += '<div class="tiles">' + tile('Damage', grp(f.totals.damage), 'now ' + grp(t0.damage)) + tile('Health', grp(f.totals.hp), 'now ' + grp(t0.hp)) +
      tile('Win rate', pvPct(f.score) + '%', pts1(f.gain) + ' ' + pm + seTxt(f.se), worth ? 'good' : '') + '</div>';
    h += sect('Suggested build') + buildTables(f.build, f.totals, pv, t0);
    h += hitLines(t0, plan.ref, f.totals);
    if (worth) h += line('Free changes only, nothing to buy. Green is different from your current build. Worth ' + pts1(f.gain) +
      ' points of win rate, give or take ' + seTxt(f.se) + ', measured against the same opponents with the same rolls.');
    else h += line('Worth ' + pts1(f.gain) + ' points give or take ' + seTxt(f.se) + ': inside the noise.', 'warn');
    h += confLine(plan);
    return h + metaTable(pv, t0);
  }

  function renderUp(pv, plan) {
    var h = '', rows;
    if (plan && !plan.stop) rows = plan.next;
    else {
      rows = []; pv.gear.forEach(function (g, i) { rows = rows.concat(pvUpgradeRows(pv, null, 0, i)); });
      if (!plan && S.battles.length) h += waitLine();
      if (plan && plan.thin) h += line('Costs only: with ' + plan.pool + ' duel' + (plan.pool === 1 ? '' : 's') +
        ' on record out of ' + plan.floor + ', there is not enough to say what an upgrade is worth.', 'warn');
      else if (plan) h += line('Costs only: every opponent on record is already settled either way, so no upgrade would change a result.', 'warn');
    }
    if (plan && !plan.stop && plan.buy.steps.length) {
      h += '<div class="tiles">' + tile('Win rate now', pvPct(plan.cur.score) + '%', '') + tile('After buying', pvPct(plan.buy.score) + '%', pts1(plan.buy.gain) + ' points', 'good') + tile('Steps', String(plan.buy.steps.length), 'upgrades') + '</div>';
      h += sect('Affordable now') + tbl(['Piece', 'Upgrade', 'Cost'], plan.buy.steps.map(function (x) {
        return [cap(x.name), cap(x.kind) + ' ' + x.from + ' \u2192 ' + x.to, grp(x.cost) + ' ' + x.res];
      }));
    }
    rows = rows.slice().sort(function (a, b) { return (b.gain === null ? 0 : b.gain) - (a.gain === null ? 0 : a.gain); }).slice(0, 6);
    h += sect('Next upgrades') + tbl(['Upgrade', 'Cost', 'You have', 'Gain'], rows.map(function (r) {
      return [cap(r.name) + ' ' + r.kind + ' ' + (r.from + 1), grp(r.cost) + ' ' + r.res, { t: grp(r.have), c: r.have >= r.cost ? 'good' : '' }, r.gain === null ? null : pts1(r.gain)];
    }));
    h += line('Gain is the change in win rate, in points, from that one upgrade on its own.');
    if (plan && !plan.stop) h += confLine(plan);
    return h;
  }

  var PV_CHECK_SIMS = 40;   // replays per duel: enough to see if the model picks the winner
  var PV_CHECK_MAX = 40;    // how many of the most recent duels get checked

  function pvCheckRun() {
    if (pvCheckBusy) return;
    // Only the recent ones: the check is a sanity reading on the model, not a
    // census, and replaying 200 duels trickles work for nine seconds.
    var todo = S.battles.slice(-PV_CHECK_MAX).filter(function (r) { return !pvCheck[arKey(r)]; });
    if (!todo.length) return;
    pvCheckBusy = true;
    // All of them in one background job (12i), each result as it comes.
    var w = wkRun({ kind: 'replay', recs: todo, sims: PV_CHECK_SIMS }, function (m) {
      if (m.type === 'replay') pvCheck[arKey(todo[m.i])] = m.res || { p: null, rounds: null };
      if (m.type === 'done' || m.type === 'error') {
        todo.forEach(function (r) { if (!pvCheck[arKey(r)]) pvCheck[arKey(r)] = { p: null, rounds: null }; });
        pvCheckBusy = false;
      }
      if (panel.style.display !== 'none' && tab === 'battle' && bsub === 'fights') render();
    });
    if (!w) { todo.forEach(function (r) { pvCheck[arKey(r)] = { p: null, rounds: null }; }); pvCheckBusy = false; }
  }

  function renderFights() {
    var recs = S.battles, h = '', n = recs.length;
    var wins = recs.filter(function (r) { return r.w; }).length, stale = recs.filter(function (r) { return r.a; }).length;
    var plan = pvMemo.plan;
    h += '<div class="tiles">' +
      tile('Recorded', n + ' / ' + AR_MAX, n < PV_FLOOR ? (PV_FLOOR - n) + ' more to use real opponents' :(n ? 'last ' + whenTxt(recs[n - 1].t).toLowerCase() : 'none yet'),
        n < PV_FLOOR ? 'warn' : '') +
      tile('Record', wins + (wins === 1 ? ' win' : ' wins'), (n - wins) + (n - wins === 1 ? ' loss' : ' losses')) +
      tile('Useful', plan && plan.contested !== undefined ? String(plan.contested) : '--',
        plan && plan.contested !== undefined ? plan.decided + ' already settled' : 'not worked out yet',
        plan && plan.contested >= PV_CONTESTED ? 'good' : '') + '</div>';
    if (plan && plan.contested !== undefined)
      h += line('Useful counts the opponents a change of build could actually swing. The settled ones are those this build always beats, or never beats: they look the same whatever you do, so the tuning ignores them.');
    if (n) {
      h += tbl(['When', 'Result', 'Their clones', 'Their damage', 'Rounds'], recs.slice(-6).reverse().map(function (r) {
        return [whenTxt(r.t) + (r.a ? ' ~' : ''), { t: r.w ? 'Won' : 'Lost', c: r.w ? 'good' : 'bad' },
          String(r.e.n), fmt(r.e.d, 0), String(r.r)];
      }));
      if (stale) h += line('~ marks a duel fought on a different build of yours. Its opponent is still recorded exactly, but the precision and evasion read off it are less reliable.');
      var ok = recs.slice(-PV_CHECK_MAX).map(function (r) { return pvCheck[arKey(r)]; }).filter(function (x) { return x && x.p !== null; });
      if (ok.length) {
        var avgP = ok.reduce(function (a, x) { return a + x.p; }, 0) / ok.length, sim = ok.reduce(function (a, x) { return a + x.rounds; }, 0) / ok.length;
        var real = recs.reduce(function (a, r) { return a + r.r; }, 0) / n;
        h += kvs([['Model check', 'real winner in ' + pct(avgP, 0) + ' of replays'], ['Rounds', Math.round(real) + ' real / ' + Math.round(sim) + ' simulated']]);
        h += line('Each duel is replayed with the two fighters as recorded. Opponent precision, evasion, skills and crit are estimates; clones, health and damage are read from the log.');
      }
    } else {
      h += line('Recording runs in the background, whatever tab is open. Fight in the arena, or open any duel in Battlefield > Battle Log > Arena, and it is filed away here.');
    }
    var kb = n ? Math.max(1, Math.round(JSON.stringify(recs).length / 1024)) : 0;
    h += kvs([['Stored', kb + ' KB'], ['Names', 'not saved']]);
    h += '<div class="row"><label class="c"><input type="checkbox" id="f_rec"' + (S.inputs.recBattles === false ? '' : ' checked') + '>Record duels</label></div>';
    if (n) h += '<div class="row" style="margin-top:0"><button class="act" id="b_clearrec">Clear recorded duels</button></div>';
    if (n) pvCheckRun();
    return h;
  }

  /* ---- Anomalies ---- */

  function renderAn() {
    var rows = anRows(), total = 0;
    rows.forEach(function (r) { total += r.n; });
    var h = '<div class="tiles">' +
      tile('Drops recorded', grp(total), rows.length ? 'seen so far' : '') +
      tile('Players', String(rows.length), rows.length ? 'have found one' : '') + '</div>';
    if (!rows.length) {
      h += line('No rare anomaly drop seen yet. These are announced to everyone in Main chat, so nothing needs to be done in-game; just leave the tab open, or any tab, and one will be picked up as soon as it is posted.');
      h += line('Only the last 200 Main messages are kept by the game, and only what happens while the game tab is open can be seen, so this is a count from when watching began, not a full history.', 'warn');
    } else {
      h += tbl(['Player', 'Rare anomalies'], rows.map(function (r) { return [r.name, { t: grp(r.n), c: r.n === rows[0].n ? 'good' : '' }]; }));
      h += line('Counted from "found a rare anomaly" messages in Main chat, seen while the game tab was open. Only the last 200 Main messages are kept by the game, so a drop from before watching began, or from while the tab was closed, is missed.');
    }
    return h;
  }

  /* ---- Galaxy tab ---- */

  function renderGalaxy() {
    var t = galaxyToday(), m = galaxySum(30);
    var voy = S.storeState && S.storeState.Voyager;
    var rewardBonus = voy ? numOr(voy.reward_bonus) : null;
    var ex = S.storeState && S.storeState.ExploreStore;
    var lr = ex && ex.lastRewards;
    var dustBonus = lr && lr.cosmic_dust_detail ? numOr(lr.cosmic_dust_detail.bonus) : null;

    var h = '<div class="tiles wr">' +
      tile('Jumps today', grp(t.mj + t.vj), (t.mj || t.vj) ? (t.mj + ' manual · ' + t.vj + ' voyager') : '') +
      tile('XP today', fmt(t.mx + t.vx, 0), '') +
      tile('Dust today', fmt(t.md + t.vd, 0), (t.mdt || t.vdt) ? (fmt((t.mdt || 0) + (t.vdt || 0), 0) + ' to tax') : '') +
      tile('Credits today', fmt((t.mc || 0) + (t.vc || 0), 0), 'published only') +
      '</div>';

    if (m.days) {
      h += kvs([
        ['Last ' + m.days + ' day' + (m.days === 1 ? '' : 's'), grp(m.mj + m.vj) + ' jumps'],
        ['XP', fmt(m.mx + m.vx, 0)],
        ['Dust', fmt(m.md + m.vd, 0)],
        ['Credits', fmt((m.mc || 0) + (m.vc || 0), 0)]
      ]);
    } else {
      h += line('No jumps logged yet. A manual jump is picked up the instant you arrive; a Voyager jump as each waypoint is reached. Nothing needs doing in-game beyond that - just leave a tab open.');
    }

    h += kvs([
      ['Voyager reward bonus', rewardBonus !== null ? '+' + fmt(rewardBonus, 0) + '%' : '--'],
      ['Cosmic dust bonus, last jump', dustBonus !== null ? '+' + fmt(dustBonus * 100, 0) + '%' : '--']
    ]);

    h += renderBoxes(t, m);
    h += line('Credits: published discoveries only, not box credits. Voyager assumes you publish, so a route kept private is overcounted.');
    h += line('Boxes count only when you publish or claim in this browser.');
    h += line('Daily totals only, no system names or times. Voyager XP counts on the day you claim.');
    return h;
  }

  var galBoxOpen = store.get('galBoxOpen', false) === true;

  // A box names its resources the game's way (dark_matter, kept as "dark
  // matter"): shown as the Gathering tab names them, or capitalised.
  function boxResName(k) {
    for (var n in NODES) {
      var names = NODES[n].commons.concat([NODES[n].rare]);
      for (var i = 0; i < names.length; i++) if (normName(names[i]) === k) return names[i];
    }
    return k.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  // t: today's totals, m: the last 30 days (galaxySum). Counting began at
  // S.boxSince, shown as the calendar date.
  function renderBoxes(t, m) {
    var d = new Date(S.boxSince), since = d.getDate() + '/' + (d.getMonth() + 1);
    var all = galaxySumsSince(30, S.boxSince), boxes = m.mb + m.vb;
    if (!boxes) {
      return line((all ? 'No mystery box yet since ' + since : 'No mystery box in the last 30 days') +
        (m.mp || m.vq ? ' (' + grp(m.mb) + ' of ' + grp(m.mp) + ' publishes, ' + grp(m.vb) + ' of ' + grp(m.vq) + ' Voyager claims)' : '') + '.');
    }
    var total = function (o) { return Object.keys(o).reduce(function (s, k) { return s + o[k]; }, 0); };
    var rate = function (b, of) { return of ? pct(b / of, 0) : '--'; };
    var h = sect(all ? 'Mystery boxes since ' + since : 'Mystery boxes, last 30 days') + '<div class="tiles wr">' +
      tile('Boxes', grp(boxes), grp(t.mb + t.vb) + ' today') +
      tile('Box credits', fmt(m.bc, 0), '') +
      tile('Common resources', fmt(total(m.bcm), 0), '') +
      tile('Rare resources', fmt(total(m.brm), 0), '') +
      '</div>';
    h += '<button class="mg" id="b_galbox">' + (galBoxOpen ? '▾ ' : '▸ ') + 'What dropped' +
      '<span>' + esc(rate(m.mb, m.mp) + ' manual · ' + rate(m.vb, m.vq) + ' voyager') + '</span></button>';
    if (galBoxOpen) {
      var res = function (o) {
        return Object.keys(o).sort(function (a, b) { return o[b] - o[a] || (a < b ? -1 : 1); })
          .map(function (k) { return [boxResName(k), grp(o[k])]; });
      };
      h += tbl(null, [
        ['Manual publishes', grp(m.mb) + ' of ' + grp(m.mp)],
        ['Voyager claims', grp(m.vb) + ' of ' + grp(m.vq)],
        ['Credits', grp(m.bc)]
      ].concat(res(m.bcm), res(m.brm)));
    }
    return h;
  }

  /* ---- Battling tab ----
     Your max enemy level at 98% and what raises it: catalysts you own, the
     best stat split, clone upgrades. Nothing runs until the button; the
     fights run in the background worker (12i), about a minute. */

  var btRun = null;       // { sig, at, p, head, res[], done, ticks, worker, error, wait }


  // What the worker needs, or why nothing can be worked out yet.
  function btPlan() {
    var st = S.storeOk ? S.storeState : null;
    if (!st) return { wait: 'Waiting for the game to load.' };
    var r = btRead(st);
    if (!r) return { wait: 'Nothing to work out yet: open the game\'s Battling page once, with your clones fighting.' };
    if (!r.weak) return { wait: 'Unknown enemy "' + r.npc + '": the fight maths does not know its weaknesses.' };
    if (!(r.level > 0)) return { wait: 'No enemy level chosen yet in the game.' };
    var b = barracks();
    if (!b) return { boostWait: true, wait: boostAsked ? 'The game did not send your Barracks boost. Open its Battling page once; it is remembered after that.' : 'Your Barracks boost is not loaded yet: the button asks the game for it first.' };
    r.ss = b.v;
    if (b.remembered) r.blocked = false;
    var options = [];
    var g = eqRead(st), fu = g ? eqFightUps(eqAnalyse(g)) : [];
    fu.forEach(function (u) {
      options.push({ group: 'cat', label: u.item + ' ' + EQ_LABEL[u.stat].toLowerCase() + ': ' + u.from.rarity + ' ' + u.from.range + ' → ' + u.to.rarity + ' ' + u.to.range, ctx: btRead(eqStoreWith(st, [eqSwap(u)])).ctx });
    });
    if (fu.length > 1) options.push({ group: 'cat', label: 'All ' + fu.length + ' together', ctx: btRead(eqStoreWith(st, fu.map(eqSwap))).ctx });
    options.push({ group: 'stats', split: true, free: r.available, label: r.available > 0 ? 'Best split, with your ' + r.available + ' free points' : 'Best split of your points', ctx: r.ctx });
    var cp = nextClonePrice();
    btOptions(r, cp).forEach(function (o) {
      options.push({ group: 'clones', label: o.key === 'clone' ? 'Clone ' + (r.ctx.clones.length + 1) + ' (starting at 0 / 0 / 0' + (cp ? ', ' + (cp.est ? '~' : '') + fmt(cp.v, 0) : '') + ')' : o.label, ctx: o.ctx });
    });
    var sig = JSON.stringify([r.ctx, r.npc, r.level, r.ss, r.available, fu.map(function (u) { return [eqLevelKey(u), u.to.rarity, u.to.range]; })]);
    return { r: r, b: b, sig: sig, options: options };
  }

  function btGo() {
    if (btRun && btRun.worker) btRun.worker.terminate();
    if (askGameForBoost(btGo)) { btRun = { wait: 'Asking the game for your Barracks boost…' }; render(); return; }
    var p = btPlan();
    if (p.wait) { btRun = { wait: p.wait }; render(); return; }
    var job = { kind: 'battling', current: p.r.ctx, weak: p.r.weak, ss: p.r.ss, level: p.r.level, options: p.options.map(function (o) { return { ctx: o.ctx, split: !!o.split, free: o.free || 0 }; }) };
    var run = { sig: p.sig, at: Date.now(), p: p, head: null, res: [], done: false, ticks: 0, worker: null };
    run.worker = wkRun(job, function (m) {
      if (btRun !== run) return;
      if (m.type === 'tick') run.ticks = m.n;
      else if (m.type === 'head') run.head = m;
      else if (m.type === 'option') run.res[m.i] = m;
      else if (m.type === 'done') { run.done = true; run.worker = null; }
      else if (m.type === 'error') { run.error = m.err; run.worker = null; }
      // Progress ticks redraw at most once a second; answers at once.
      if (m.type === 'tick' && Date.now() - (run.drawn || 0) < 1000) return;
      run.drawn = Date.now();
      if (tab === 'bat' && panel.style.display !== 'none') render();
    });
    if (!run.worker) run = { wait: 'This browser refused the background worker, so nothing is worked out (doing it on the page would freeze the game).' };
    btRun = run;
    render();
  }

  function renderBattling() {
    var p;
    try { p = btPlan(); } catch (e) { p = { wait: 'Could not read the game: ' + ((e && e.message) || e) }; }
    var h = '';
    if (p.r) {
      h += '<div class="bsub">' + esc(p.r.npc.charAt(0).toUpperCase() + p.r.npc.slice(1)) + ' · level ' + grp(p.r.level) + ' · Barracks +' + grp(p.r.ss) + '%' +
        (p.b && p.b.remembered ? ' (remembered from ' + esc(new Date(p.b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + ')' : '') + '</div>';
      if (p.r.blocked) h += line('You are fighting in another squadron\'s system: your Barracks boost does not count here.', 'warn');
    }
    var busy = btRun && btRun.worker, canAsk = p.boostWait && !boostAsked;
    h += '<div class="gobar"><button id="b_btgo"' + (busy || (p.wait && !canAsk) ? ' disabled' : '') + '>' + (btRun && btRun.head ? 'Work it out again' : 'Work out my max and best upgrades') + '</button>' +
      '<span class="mu">' + (busy ? 'working… ' + btRun.ticks + ' fight sets' : btRun && btRun.done ? 'worked out at ' + new Date(btRun.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'about a minute, in the background') + '</span></div>';
    if (p.wait) h += line(p.wait, 'warn');
    if (btRun && btRun.wait && btRun.wait !== p.wait) h += line(btRun.wait, 'warn');
    if (btRun && btRun.error) h += line('Stopped: ' + btRun.error, 'warn');
    if (btRun && btRun.done && p.sig && btRun.sig !== p.sig) h += line('Your build, gear or level changed since: press to update.', 'warn');
    if (btRun && btRun.head) {
      var hd = btRun.head, se = hd.farm === null ? 0 : 196 * Math.sqrt(hd.farm / 100 * (1 - hd.farm / 100) / hd.farmRuns);
      h += '<div class="tiles">' + tile('Max at 98%', grp(hd.max), 'enemy level') +
        (hd.farm === null ? '' : tile('Winrate at ' + grp(btRun.p.r.level), hd.farm.toFixed(2) + '%', '±' + se.toFixed(2))) + '</div>';
      var rows = [];
      [['cat', 'Catalysts you own'], ['stats', 'Stat points'], ['clones', 'Clone upgrades, about 1B each']].forEach(function (g) {
        var list = btRun.p.options.map(function (o, i) { return { o: o, r: btRun.res[i] }; }).filter(function (x) { return x.o.group === g[0]; });
        if (!list.length) return;
        rows.push([{ t: g[1], c: 'grp' }, '', '']);
        list.forEach(function (x) {
          var label = x.o.label;
          if (x.o.split && x.r && x.r.stats) label += ': power ' + x.r.stats.power + ' · precision ' + x.r.stats.precision + ' · evasion ' + x.r.stats.evasion + ' · hull ' + x.r.stats.hull;
          var d = x.r ? x.r.max - hd.max : null;
          rows.push([label, x.r ? { t: grp(x.r.max), c: 'r' } : { t: '…', c: 'mu r' }, x.r ? { t: (d > 0 ? '+' : d < 0 ? '' : '±') + d, c: 'r ' + (d > 0 ? 'good' : 'mu') } : '']);
        });
      });
      h += tbl(['What', 'Max', 'Levels'], rows);
      if (btRun.res.some(function (x, i) { return x && btRun.p.options[i].split; })) h += line('Compare the split with the game\'s own "Find optimal build": the game\'s answer is the one to trust.', 'mu');
    }
    h += '<div class="foot">The game\'s own fight rules: 60,000 to 100,000 fights for your max and winrate, 20,000 a level for each option, on the same random numbers, so levels are about ±1 to 2 (a cliff in the winrate is exact).</div>';
    return h;
  }

  /* ---- Equipment tab ----
     A small copy of the game's ship screen (its own pictures and icons),
     the upgrades from the catalysts you own, totals by purpose, and battle
     levels for the weapon and shield swaps on a button. */

  var eqSel = null;       // the item whose rows are shown
  var eqLv = null;        // { sig, keys, res, worker, done, boost, wait, error }
  var eqIcons = {};       // sprite symbols already copied into the panel

  // The game's SVG icons live in one sprite in the page: copy the ones
  // needed (and whatever they point at) into the panel, once each.
  function spriteIcons(ids) {
    var defs = sr.getElementById('sprite');
    if (!defs) return;
    ids.forEach(function add(id) {
      if (eqIcons[id]) return;
      var el = document.getElementById(id);
      if (!el) return;
      eqIcons[id] = 1;
      defs.insertAdjacentHTML('beforeend', el.outerHTML);
      (el.innerHTML.match(/url\(#([^)"']+)\)|href="#([^"]+)"/g) || []).forEach(function (m) {
        var r = /#([^)"']+)/.exec(m);
        if (r && !el.querySelector('[id="' + r[1] + '"]')) add(r[1]);
      });
    });
  }
  function svgIcon(id, size) { return '<svg class="ic" width="' + size + '" height="' + size + '"><use href="#' + id + '"/></svg>'; }
  // The ship's picture from the files the game has loaded, the large one
  // when the ship screen has been shown. The game downloads it only when a
  // screen showing the ship opens, so after a reload there is usually
  // nothing to find (checked 2026-09-27: one .webp loaded in 178 requests,
  // the ship not among them). The name is therefore remembered once seen
  // and reused, so the picture is there straight away next time.
  function shipPicture(root) {
    try {
      var icon = String((root.ShipStore.skin && root.ShipStore.skin.icon) || '');
      var base = icon.replace(/\.\w+$/, '');
      if (!base) return null;
      var urls = performance.getEntriesByType('resource').map(function (e) { return e.name; });
      // Hashed names can hold a dash (reaper-B8e-DOol.webp, reaper-small-B8PABJKz.webp).
      var big = '/assets/' + base + '-', small = '/assets/' + base + '-small-';
      var ok = function (u) { return !shipPicBad[u]; };
      var found = urls.filter(function (u) { return u.indexOf(big) >= 0 && u.indexOf(small) < 0 && /\.(webp|png|jpe?g)(\?|$)/.test(u) && ok(u); })[0] ||
        urls.filter(function (u) { return u.indexOf(small) >= 0 && ok(u); })[0] || null;
      if (found) { shipPicKeep(icon, found); return found; }
      // Not loaded this time: the one remembered for this same ship.
      var kept = store.get('shippic', null);
      return (kept && kept.icon === icon && typeof kept.url === 'string' && ok(kept.url)) ? kept.url : null;
    } catch (e) { return null; }
  }
  function shipPicKeep(icon, url) {
    var kept = store.get('shippic', null);
    if (kept && kept.icon === icon && kept.url === url) return;   // nothing changed, no write
    store.set('shippic', { icon: icon, url: url });
  }
  // A remembered name goes stale when the game is rebuilt (its files are
  // named by a hash of their contents). The picture then fails to load, so it
  // is forgotten and looked for again on the next draw. A name the game asked
  // for this page load can fail too (a request that 404s still leaves an entry
  // behind), so a failed one is also set aside for the rest of this page load:
  // without that, forgetting it and finding it again would redraw forever.
  var shipPicBad = {};
  function shipPicForget(url) {
    if (!url) return;
    shipPicBad[url] = true;
    var kept = store.get('shippic', null);
    if (kept && kept.url === url) store.set('shippic', null);
  }

  /* ---- the game's own look ----
     The background and the ship effect you equipped in the game are style
     rules of the game's own stylesheet, named by the class of what is
     equipped (PremiumStore.socialBackgrounds.class, e.g. nebula-grey;
     ShipStore.effect.class, e.g. glow_basic-white). The background's
     picture goes behind the whole panel in the dark theme, faded to 40% as
     on the game's ship screen; the effect's rules and the animation they
     name are copied into the panel for the ship picture. Read again only
     when what is equipped changes (the game has about 8,000 rules, a few
     ms to look through). */
  var lookKey = null, lookFx = null;
  function lookClass(x) { return typeof x === 'string' && /^[\w-]{1,60}$/.test(x) ? x : null; }
  function gameRules(fn) {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sh = document.styleSheets[i], rs;
      try { rs = sh.cssRules; } catch (e) { continue; }
      (function walk(list) {
        for (var j = 0; j < list.length; j++) {
          var r = list[j];
          if (!r.selectorText && r.cssRules && !r.name) walk(r.cssRules);
          else fn(r, sh);
        }
      })(rs || []);
    }
  }
  function namesClass(sel, cls) { return new RegExp('\\.' + cls.replace(/-/g, '\\-') + '(?![\\w-])').test(sel || ''); }
  function gameLook() {
    var st = S.storeState || {}, bg = null, fx = null;
    try { bg = lookClass(st.PremiumStore.socialBackgrounds.class); } catch (e) {}
    try { fx = lookClass(st.ShipStore.effect.class); } catch (e) {}
    var key = bg + '|' + fx;
    if (key === lookKey) return;
    lookKey = key;
    var url = null, fxCss = [], anims = {};
    try {
      gameRules(function (r, sh) {
        if (bg && !url && r.style && namesClass(r.selectorText, bg)) {
          var m = /url\((['"]?)(.*?)\1\)/.exec(r.style.backgroundImage || '');
          if (m) { try { url = new URL(m[2], sh.href || location.href).href; } catch (e) {} }
        }
        if (fx && r.style && namesClass(r.selectorText, fx)) {
          fxCss.push(r.cssText);
          String(r.style.animationName || '').split(',').forEach(function (a) { a = a.trim(); if (a && a !== 'none') anims[a] = 1; });
        }
      });
      if (fxCss.length) gameRules(function (r) { if (r.name && anims[r.name] && r.cssRules) fxCss.push(r.cssText); });
    } catch (e) {}
    if (url && /["\\\n]/.test(url)) url = null;
    lookFx = fxCss.length ? fx : null;
    S.look = { bg: bg, bgFound: !!url, fx: fx, fxRules: fxCss.length };
    lookStyle.textContent = (url ? '.root.dark #panel{background:linear-gradient(rgba(26,33,41,.6),rgba(26,33,41,.6)),#1a2129 url("' + url + '") center/cover no-repeat}' +
      '.root.dark #bar,.root.dark #quota,.root.dark #tabs{background:rgba(34,43,53,.6)}' : '') + fxCss.join('\n');
  }

  var EQ_RCOL = { normal: '#9aa5b1', uncommon: '#3fae70', rare: '#3f8fe0', unique: '#d4a030', epic: '#9d6ae8', legendary: '#e67e2e' };
  var EQ_POS = { weapon_slot: [0, 0], engine_slot: [1, 0], laser_slot: [2, 0], shield_slot: [0, 2], sensors_slot: [1, 2], probes_slot: [2, 2] };
  function eqF1(x) { var r = Math.round(x * 10) / 10; return r % 1 === 0 ? r.toFixed(0) : r.toFixed(1); }
  function eqF2(x) { return x < 1 ? String(Math.round(x * 100) / 100) : eqF1(x); }
  function eqCat(c) { return c.rarity + ' ' + c.range; }

  function eqLevelSig(a, st, b) {
    var r = btRead(st);
    return JSON.stringify([r && r.ctx, r && r.level, b && b.v, eqFightUps(a).map(function (u) { return [eqLevelKey(u), u.to.rarity, u.to.range]; })]);
  }
  function eqGoLevels(a) {
    if (eqLv && eqLv.worker) eqLv.worker.terminate();
    if (askGameForBoost(function () { eqGoLevels(a); })) { eqLv = { wait: 'Asking the game for your Barracks boost…' }; render(); return; }
    var st = S.storeState, b = barracks(), r = st && btRead(st);
    if (!b) { eqLv = { wait: 'Your Barracks boost is not loaded: open the game\'s Battling page once; it is remembered after that.' }; render(); return; }
    if (!r || !r.weak || !(r.level > 0)) { eqLv = { wait: 'Open the game\'s Battling page once, with your clones fighting.' }; render(); return; }
    var ups = eqFightUps(a), keys = ['cur'], ctxs = [r.ctx];
    ups.forEach(function (u) { keys.push(eqLevelKey(u)); ctxs.push(btRead(eqStoreWith(st, [eqSwap(u)])).ctx); });
    if (ups.length > 1) { keys.push('all'); ctxs.push(btRead(eqStoreWith(st, ups.map(eqSwap))).ctx); }
    var run = { sig: eqLevelSig(a, st, b), keys: keys, res: {}, worker: null, done: false, boost: b, npc: r.npc };
    run.worker = wkRun({ kind: 'levels', ctxs: ctxs, weak: r.weak, ss: b.v, from: r.level }, function (m) {
      if (eqLv !== run) return;
      if (m.type === 'lv') run.res[keys[m.i]] = m.max;
      else if (m.type === 'done') { run.done = true; run.worker = null; }
      else if (m.type === 'error') { run.error = m.err; run.worker = null; }
      if (tab === 'eq' && panel.style.display !== 'none') render();
    });
    if (!run.worker) run = { wait: 'This browser refused the background worker, so levels are not worked out (doing it on the page would freeze the game).' };
    eqLv = run;
    render();
  }
  // "969 → 1,058 +89 lv", or null when not worked out.
  function eqLvText(key) {
    if (!eqLv || !eqLv.res || eqLv.res.cur === undefined || eqLv.res[key] === undefined) return null;
    var d = eqLv.res[key] - eqLv.res.cur;
    return grp(eqLv.res.cur) + ' → ' + grp(eqLv.res[key]) + '  ' + (d < 0 ? '' : '+') + d + ' lv';
  }

  function eqStatText(p, s, v, a) {
    var lab = EQ_LABEL[s] || s;
    var cap = a.caps[p] && a.caps[p][s];
    // Voyager jumps are whole jumps, not a percentage (the game floors them).
    if (s === 'voyager_jumps_bonus') {
      var j = Math.floor(v), cj = cap === undefined ? 60 : cap;
      return lab + ' ' + Math.min(j, cj) + '/' + cj + (j > cj ? ' (' + j + ': ' + (j - cj) + ' wasted)' : '');
    }
    if (cap === undefined) return (EQ_BOOST[p] || s === 'battling_xp' || s === 'battling_credits') ? lab + ' +' + eqF1(v) + '%' : lab + ' ' + eqF1(v);
    if (v > cap + 0.05) return lab + ' ' + eqF1(cap) + '/' + eqF1(cap) + ' (' + eqF1(v) + ': ' + eqF1(v - cap) + ' wasted)';
    return lab + ' ' + eqF1(v) + '/' + eqF1(cap);
  }

  function eqShip(a, root) {
    // Only gains of 0.5% or more are marked here, like the table below.
    var upOf = function (c) { return a.ups.filter(function (u) { return u.from === c && u.gain >= 0.5; })[0] || null; };
    var n = {};
    a.items.forEach(function (it) { n[it.key] = it.cats.filter(function (c) { return upOf(c); }).length; });
    if (!eqSel || !a.items.some(function (it) { return it.key === eqSel; })) {
      var firstUp = a.items.filter(function (it) { return n[it.key]; })[0];
      eqSel = (firstUp || a.items[0]).key;
    }
    var ids = ['weapon', 'shield', 'engine', 'sensors', 'laser', 'probes'];
    a.items.forEach(function (it) { it.cats.forEach(function (c) { ids.push('catalyst_' + c.stat); }); });
    a.ups.forEach(function (u) { ids.push('catalyst_' + u.to.stat); });
    spriteIcons(ids);
    var pic = shipPicture(root);
    var h = '<div class="ship"><div class="shippic' + (lookFx ? ' ' + lookFx : '') + '">' + (pic ? '<img src="' + esc(pic) + '" alt="">' : '') + '</div>';
    a.items.forEach(function (it) {
      var pos = EQ_POS[it.key] || [0, 0];
      h += '<div class="item' + (it.key === eqSel ? ' on' : '') + '" data-item="' + it.key + '" style="grid-row:' + (pos[0] + 1) + ';grid-column:' + (pos[1] + 1) + '">' +
        '<div class="ibox">' + svgIcon(it.key.replace('_slot', ''), 30) + (n[it.key] ? '<span class="badge">▲' + (n[it.key] > 1 ? n[it.key] : '') + '</span>' : '') + '</div>' +
        '<div class="iname">' + esc(it.label) + '</div><div class="ilv">Lvl ' + esc(it.level) + '</div></div>';
    });
    h += '</div>';
    var it = a.items.filter(function (x) { return x.key === eqSel; })[0];
    if (!it) return h;
    h += '<div class="rows">';
    (EQ_ROWS[it.key] || []).forEach(function (r) {
      var cats = it.cats.filter(function (c) { return c.row === r; }), cells = [];
      for (var i = 0; i < 4; i++) cells.push(cats.filter(function (c) { return c.slot === i; })[0] || null);
      cats.forEach(function (c) { if (cells.indexOf(c) < 0) { var e = cells.indexOf(null); if (e >= 0) cells[e] = c; } });
      h += '<div class="crow"><div class="rname">' + esc(EQ_ROW_NAME[r] || r) + '</div>';
      cells.forEach(function (c) {
        if (!c) { h += '<div class="cat empty"></div>'; return; }
        var u = upOf(c), v = eqVal(c) * (c.halved ? 0.5 : 1), lt = u ? eqLvText(eqLevelKey(u)) : null;
        var tip = (EQ_LABEL[c.stat] || c.stat) + ' (' + c.stat.replace(/_/g, ' ') + ')|' + eqCat(c) + '%: ' + eqF1(eqVal(c)) + (c.halved ? ', halved: counts ' + eqF1(v) : '') +
          '|' + (EQ_ROW_NAME[r] || r) + ' row, counts for ' + eqPurpose(r, c.stat);
        if (u) tip += '|▲ You own ' + eqCat(u.to) + '%: ' + eqF1(eqVal(u.to)) + '|Put it here: +' + eqF2(u.gain) + (u.raw - u.gain > 0.05 ? ' (cap ' + eqF1(u.cap) + ')' : '') + (lt ? '|Max level ' + lt : '');
        h += '<div class="cat' + (c.halved ? ' half' : '') + '" style="border-color:' + (EQ_RCOL[c.rarity] || '#9aa5b1') + '" data-tip="' + esc(tip) + '">' +
          svgIcon('catalyst_' + c.stat, 26) + (u ? '<span class="arrow">▲</span>' : '') + (c.halved ? '<span class="hv">½</span>' : '') + '</div>';
        if (u) h += '<div class="cat sugg" style="border-color:' + (EQ_RCOL[u.to.rarity] || '#9aa5b1') + '" data-tip="' + esc('Put this one in: ' + (EQ_LABEL[u.to.stat] || u.to.stat) + '|' + eqCat(u.to) + '%: ' + eqF1(eqVal(u.to)) + '|replaces ' + eqCat(c) + '%: +' + eqF2(u.gain) + (lt ? '|Max level ' + lt : '')) + '">' +
          svgIcon('catalyst_' + u.to.stat, 26) + (lt ? '<span class="lvb">' + esc(lt.replace(/^.*\s(\S+) lv$/, '$1')) + '</span>' : '') + '</div>';
      });
      h += '</div>';
    });
    return h + '<div class="mu hint">Hover a catalyst for its numbers. ▲ = one you own is better here by 0.5% or more (shown next to it, dashed). Tap another item to see its rows.</div></div>';
  }

  function renderEquipment() {
    var root = S.storeOk ? S.storeState : null, g = root ? eqRead(root) : null;
    if (!g) return line('Nothing to read yet: wait for the game to load.', 'warn');
    var a = eqAnalyse(g), h = '';
    var eq = a.items.reduce(function (n, it) { return n + it.cats.length; }, 0);
    h += '<div class="bsub">' + a.items.length + ' items · ' + eq + ' catalysts equipped · ' + a.invN + ' in your inventory</div>';
    h += eqShip(a, root);

    var fu = eqFightUps(a);
    h += '<h4>Upgrades from your catalysts' + (fu.length ? ' <button id="b_eqlv" class="mini"' + (eqLv && eqLv.worker ? ' disabled' : '') + '>' + (eqLv && eqLv.done ? 'Work out levels again' : 'Work out levels') + '</button>' : '') + '</h4>';
    if (fu.length && eqLv) {
      if (eqLv.wait) h += line(eqLv.wait, 'warn');
      else if (eqLv.error) h += line('Stopped: ' + eqLv.error, 'warn');
      else if (eqLv.worker) h += line('Working out battle levels in the background… ' + Object.keys(eqLv.res).length + ' of ' + eqLv.keys.length, 'mu');
      else {
        h += line('Levels: your max at 98% winrate against ' + eqLv.npc + ', Barracks +' + grp(eqLv.boost.v) + '%' + (eqLv.boost.remembered ? ' (remembered)' : '') + '.', 'mu');
        if (eqLv.sig !== eqLevelSig(a, root, barracks())) h += line('Your gear, build or level changed since: press again.', 'warn');
      }
    }
    if (!a.ups.length) h += line('Nothing you own beats what is equipped.');
    else {
      var order = EQ_PURPOSES.map(function (x) { return x[0]; });
      var ups = a.ups.slice().sort(function (x, y) { return (order.indexOf(x.purpose) - order.indexOf(y.purpose)) || (y.gain - x.gain); });
      var upRow = function (u) {
        var capped = u.raw - u.gain > 0.05, lt = fu.indexOf(u) >= 0 ? eqLvText(eqLevelKey(u)) : null;
        var r = [u.item + ' · ' + EQ_ROW_NAME[u.row], EQ_LABEL[u.stat] || u.stat, { t: eqCat(u.from) + ' → ' + eqCat(u.to), c: 'mu' },
          { t: '+' + eqF2(u.gain) + (u.stat === 'voyager_jumps_bonus' ? ' jumps' : '%') + (capped ? ' (cap ' + eqF1(u.cap) + ')' : ''), c: 'good r' }];
        if (fu.length) r.push(lt ? { t: lt, c: 'r' } : (fu.indexOf(u) >= 0 && eqLv && eqLv.worker ? { t: '…', c: 'mu r' } : ''));
        return r;
      };
      var big = ups.filter(function (u) { return u.gain >= 0.5; }), small = ups.filter(function (u) { return u.gain < 0.5; });
      var rows = big.map(upRow);
      if (fu.length > 1 && eqLv && eqLv.res && eqLv.res.all !== undefined) rows.push([{ t: 'All ' + fu.length + ' battling swaps together', c: 'b' }, '', '', '', { t: eqLvText('all'), c: 'r' }]);
      h += rows.length ? tbl(null, rows) : line('Only small gains (under 0.5%).');
      if (small.length) h += '<details><summary class="mu">' + small.length + ' small upgrades (under 0.5%)</summary>' + tbl(null, small.map(upRow)) + '</details>';
    }

    h += sect('By purpose');
    EQ_PURPOSES.forEach(function (pp) {
      var p = pp[0], t = a.tot[p];
      if (!t) return;
      var shown = t;
      if (p === 'galaxyboss' && a.gbStats) {
        // The game's own boss totals when loaded (catalysts plus skill tree).
        shown = { armor_penetration: numOr(a.gbStats.armorPenRaw) || 0, defense: numOr(a.gbStats.defenseRaw) || 0, lifesteal: numOr(a.gbStats.lifestealRaw) || 0, block: numOr(a.gbStats.blockRaw) || 0 };
        Object.keys(t).forEach(function (s2) { if (shown[s2] === undefined) shown[s2] = t[s2]; });
      }
      var parts = Object.keys(shown).map(function (s2) { return eqStatText(p, s2, shown[s2], a); });
      var detail = '';
      a.active.forEach(function (r) {
        if (r.p !== p) return;
        var cs = r.cats.filter(function (c) { return eqShows(p, c.stat); });
        if (!cs.length) return;
        detail += '<div class="det"><b>' + esc(r.item.label + ' · ' + EQ_ROW_NAME[r.row] + (r.inherited ? ' (no ' + EQ_ROW_NAME[EQ_ACT[p]] + ' row)' : '')) + '</b> ' + cs.map(function (c) {
          return esc((EQ_LABEL[c.stat] || c.stat) + ' ' + eqCat(c) + ' = ' + eqF1(eqVal(c) * (c.halved ? 0.5 : 1))) + (c.halved ? ' <span class="warn">(halved)</span>' : '');
        }).join(' · ') + '</div>';
      });
      h += '<details><summary><b>' + esc(pp[1]) + '</b> <span class="mu">' + esc(parts.join(' · ')) + '</span></summary>' + detail + '</details>';
    });
    var em = Object.keys(a.empty).map(function (r) { return EQ_ROW_NAME[r] + ' (' + a.empty[r].join(', ') + ')'; });
    if (em.length) h += '<div class="line"><b>Empty</b> <span class="mu">' + esc(em.join(' · ')) + '</span></div>' +
      (Object.keys(a.empty).some(function (r) { return r !== 'default'; }) ? line('An empty row uses that item\'s Default catalysts instead; a filled one replaces them.', 'mu') : '');
    h += '<details><summary>' + a.halved.length + ' halved catalysts</summary>' + a.halved.map(function (x) {
      return '<div class="det">' + esc(x.item + ' · ' + EQ_ROW_NAME[x.row] + ': ' + (EQ_LABEL[x.c.stat] || x.c.stat) + ' ' + eqCat(x.c) + ', ' + eqF1(eqVal(x.c)) + ' counts ' + eqF1(eqVal(x.c) / 2)) + '</div>';
    }).join('') + '</details>';
    var sp = Object.keys(a.spare).sort(function (x, y) { return a.spare[y].n - a.spare[x].n; });
    h += '<details><summary>' + a.spareN + ' spare catalysts no slot can use' + (a.market ? ' (' + a.market + ' on the market)' : '') + '</summary>' +
      sp.map(function (s2) { return '<div class="det">' + esc((EQ_LABEL[s2] || s2) + ' (' + s2.replace(/_/g, ' ') + ') ×' + a.spare[s2].n + ', best ' + eqCat(a.spare[s2].best)) + '</div>'; }).join('') + '</details>';
    h += '<div class="foot">Values are the game\'s own catalyst %. Galaxy boss totals come from its My Stats tab once opened. Levels: the game\'s own fight rules, 20,000 fights a level on the same random numbers, about ±1 to 2.</div>';
    return h;
  }

  /* ---- Market tab ----
     Every price here comes from the same hourly price list the Gathering tab
     uses (S.books), so this tab costs no extra API call. Only goods the game
     itself lists as a currency or a material are shown. Catalysts, items
     (weapons, lasers, shields, probes...) and pets differ one by one, so a
     single price per name means little for them: they are left out (the
     user's choice). */

  var MG_ORDER = ['Gathering resources', 'Laboratory materials', 'Enemy drop materials', 'Base building materials', 'Pet supplies', 'Currencies'];
  // Each material's group, by name, copied item by item from the game's own
  // Market page. The materials' `category` tags disagree with that page (it
  // puts Metal Scrap and Anomaly under Laboratory Materials), so they are not
  // used. A material not listed here is left out, and named in the Copy
  // report, rather than put in the wrong group.
  var MG_OF_NAME = {
    // Laboratory materials: Warp Capsule, Metal Scrap and Anomaly are the
    // three seen on the game's Market page. The other nine are the Economy
    // tab's crafting chain, not tradeable today: listed so they land in the
    // right group if that ever changes.
    'warp capsule': 'Laboratory materials', 'metal scrap': 'Laboratory materials', 'anomaly': 'Laboratory materials',
    'ingots': 'Laboratory materials', 'refined crystals': 'Laboratory materials', 'high end crystals': 'Laboratory materials',
    'propulsors': 'Laboratory materials', 'nanoconductors': 'Laboratory materials', 'fusion cells': 'Laboratory materials',
    'microcircuits': 'Laboratory materials', 'fuel cell casing': 'Laboratory materials', 'unstable fuel': 'Laboratory materials',
    // Enemy drop materials: all eight seen live under that header (Metal
    // Scrap excluded - it lives under Laboratory materials instead, above).
    'frost shard': 'Enemy drop materials', 'cog': 'Enemy drop materials', 'flame': 'Enemy drop materials',
    'horn': 'Enemy drop materials', 'slime': 'Enemy drop materials', 'condensed sand': 'Enemy drop materials',
    'bones': 'Enemy drop materials', 'ectoplasm': 'Enemy drop materials',
    // Base building materials: never seen tradeable, so never independently
    // confirmed against the live page (nothing here to expand and check);
    // grouped by the game's own item category for lack of a better source.
    'luminaris': 'Base building materials', 'aerolite': 'Base building materials', 'argoflux': 'Base building materials',
    'ferricrystal': 'Base building materials', 'cryovita': 'Base building materials',
    // Pet supplies
    'pet food': 'Pet supplies', 'enhanced warp capsule': 'Pet supplies'
  };
  var MG_CURRENCY = { stellar_tokens: 1, quantum_cores: 1, catalyst_parts: 1 };

  // The goods the game lists, with its own grouping and how much you hold.
  // Gathering resources sit in CurrencyStore; materials, each with the
  // game's own name, in MaterialsStore. Credits are what you pay with, not
  // a good.
  function gameGoods(root) {
    var out = {};
    try {
      var c = root.CurrencyStore || {};
      Object.keys(c).forEach(function (k) {
        if (k === 'credits') return;
        var q = numOr(c[k]);
        if (q === null) return;
        out[normName(k)] = { name: cap(normName(k)), q: q, g: MG_CURRENCY[k] ? 'Currencies' : 'Gathering resources' };
      });
    } catch (e) {}
    matList(root).forEach(function (m) {
      var g = MG_OF_NAME[normName(m.name)];
      if (g) out[normName(m.name)] = { name: cap(m.name), q: m.q, g: g };
    });
    return out;
  }

  // One row per priced good. "Worth" is your stock sold instantly, at the
  // best buy order: the safe number. Priced names the game does not list as
  // a good are returned in out (left out, and named in the report).
  function marketRows(books, goods) {
    var rows = [], out = [];
    Object.keys(books || {}).forEach(function (k) {
      var b = books[k];
      if (!b || (b.bid === null && b.ask === null)) return;
      var gd = goods[normName(k)];
      if (!gd) { out.push(b.name || k); return; }
      rows.push({ name: gd.name, g: gd.g, q: gd.q, bid: b.bid, ask: b.ask,
        gap: b.bid > 0 && b.ask !== null ? (b.ask - b.bid) / b.bid : null,
        worth: b.bid !== null && gd.q > 0 ? gd.q * b.bid : 0 });
    });
    return { rows: rows, out: out };
  }

  // In the game's order; inside a group, what you hold first (largest worth
  // first), then the rest by name.
  function marketGroups(rows) {
    var by = {};
    rows.forEach(function (r) {
      var g = by[r.g] || (by[r.g] = { g: r.g, rows: [], worth: 0 });
      g.rows.push(r); g.worth += r.worth;
    });
    return MG_ORDER.filter(function (g) { return by[g]; }).map(function (g) {
      by[g].rows.sort(function (a, b) { return (b.worth - a.worth) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
      return by[g];
    });
  }

  // For what you gather: a sell order 1 under the lowest sell instead of
  // selling at the best buy. Shown only when that gains 2 or more per unit;
  // it only pays if the order fills.
  function listGains(prodRows, books) {
    var out = [];
    (prodRows || []).forEach(function (r) {
      var b = bookFor(books, r.name);
      if (b.bid === null || b.ask === null || !(r.qty > 0)) return;
      var per = b.ask - 1 - b.bid;
      if (per >= 2) out.push({ name: r.name, at: b.ask - 1, per: per, perH: per * r.qty });
    });
    return out.sort(function (a, b) { return b.perH - a.perH; });
  }

  function exactNum(x) { return Math.abs(x - Math.round(x)) < 1e-9 ? grp(x) : String(+x.toFixed(2)); }

  // A market price: players list in whole credits, so no decimals ("12",
  // not "12.0"), and exact below a million ("3,497", not "3.50k", which
  // could be any of ten prices). A million and up stays short ("10.00M").
  function priceTxt(x) {
    if (x === null || x === undefined || isNaN(x)) return '--';
    return Math.abs(x) < 1e6 ? grp(x) : fmt(x);
  }

  var mktOpen = (function () { var o = store.get('mktOpen', null); return o && typeof o === 'object' ? o : { 'Gathering resources': true }; })();

  function renderMkt() {
    var goods = S.storeOk && S.storeState ? gameGoods(S.storeState) : {};
    var mr = marketRows(S.books, goods), groups = marketGroups(mr.rows);
    var p = null;
    try { p = projection(); } catch (e) {}
    var lg = p ? listGains(p.rows, S.books) : [];
    var total = 0, extra = 0;
    groups.forEach(function (g) { total += g.worth; });
    lg.forEach(function (x) { extra += x.perH; });

    var h = '<div class="tiles">' +
      tile('Your goods', total > 0 ? fmt(total) : '--', 'sold instantly') +
      tile('Listing bonus', lg.length ? '+' + fmt(extra) + ' / h' : '--', lg.length ? 'vs selling instantly' : 'no gap worth it', lg.length ? 'good' : '') +
      '</div>';

    if (!S.storeOk) h += line('The game page is not readable yet.', 'warn');
    if (S.marketStamp) h += line('Prices ' + hhmm(Date.now() - S.marketStamp) + ' old' + (nextMarketAt ? ', next refresh at ' + atTxt(nextMarketAt) : '') + '.');
    else h += line('No prices yet.', 'warn');
    var hold = marketHold();
    if (hold) h += line(hold, 'warn');

    groups.forEach(function (g) {
      var open = !!mktOpen[g.g];
      h += '<button class="mg" data-mg="' + esc(g.g) + '">' + (open ? '▾ ' : '▸ ') + esc(g.g) +
        '<span>' + g.rows.length + (g.worth > 0 ? ' · ' + fmt(g.worth) : '') + '</span></button>';
      if (open) h += tbl(['Item', 'Buy', 'Sell', 'Gap', 'Have', 'Worth'], g.rows.map(function (r) {
        return [r.name, priceTxt(r.bid), priceTxt(r.ask), r.gap === null ? null : pct(r.gap, 0), r.q > 0 ? fmt(r.q) : null, r.worth > 0 ? fmt(r.worth) : null];
      }));
    });

    if (lg.length) {
      h += sect('Sell orders instead of selling instantly');
      // Exact prices here, not rounded: "3.60k" would read as the sell price itself.
      h += tbl(['Resource', 'List at', 'Gain / unit', 'Extra / h'], lg.map(function (x) {
        return [x.name, exactNum(x.at), exactNum(x.per), { t: '+' + fmt(x.perH), c: 'good' }];
      }));
      h += line('Listed 1 below the cheapest seller instead of sold instantly. Only if it all sells: the game doesn\'t show how much sells, so it can be less.');
    }
    if (mr.out.length) h += line(mr.out.length + ' priced entries left out: catalysts, items, pets, or anything the game does not list as a material.');
    return h;
  }

  /* ---- Economy tab ----
     Craft or buy a Warp Capsule, and buy a resource direct or swap for it
     at the NPC Trader. Both use S.books: no extra API call. See
     docs/model-economy.md. */

  // The Laboratory chain from gathering resources to one Warp Capsule, read
  // off the game's Laboratory page. Each craft cycle uses "cost" of every
  // input listed, whatever the building's level, and pays out bbLabMult()
  // units, so each of the 3 stages is `mult` times cheaper: about mult^3
  // overall (729x at x9).
  var WARP_RECIPE = {
    ingots: { cur: ['gold', 'silver', 'copper', 'platinum'], cost: 10000 },
    refined_crystals: { cur: ['diamond', 'ruby', 'emerald', 'sapphire'], cost: 10000 },
    high_end_crystals: { cur: ['water', 'nitrogen', 'sulfur', 'carbon'], cost: 10000 },
    propulsors: { cur: ['helium', 'methane'], cost: 10000 },
    nanoconductors: { cur: ['ammonia', 'hydrogen'], cost: 10000 },
    fusion_cells: { cur: ['argon', 'dark matter'], cost: 1000 },
    microcircuits: { cur: ['silicon', 'cobalt'], cost: 1000 },
    fuel_cell_casing: { mat: ['ingots', 'refined_crystals', 'microcircuits'], cost: 20 },
    unstable_fuel: { mat: ['high_end_crystals', 'propulsors', 'nanoconductors', 'fusion_cells'], cost: 20 },
    warp_capsule: { mat: ['unstable_fuel', 'fuel_cell_casing'], cost: 10 }
  };

  // Recurses a recipe entry down to the raw currencies it costs for "qty"
  // crafted units, at Laboratory multiplier "mult" (1 with no enhancer
  // built - see warpCapsuleLabMult). Each craft cycle at a stage yields
  // "mult" units of that stage's output for a fixed "cost" of input, so
  // only qty/mult cycles are needed, not qty. A name with no recipe (a raw
  // currency - the base case) just adds its own amount.
  function expandToCurrencies(name, qty, mult, out) {
    out = out || {};
    var r = WARP_RECIPE[name];
    if (!r) { out[name] = (out[name] || 0) + qty; return out; }
    var cycles = qty / (mult > 0 ? mult : 1);
    (r.cur || []).forEach(function (c) { out[c] = (out[c] || 0) + cycles * r.cost; });
    (r.mat || []).forEach(function (m) { expandToCurrencies(m, cycles * r.cost, mult, out); });
    return out;
  }

  // The Base tab's own lab multiplier (bbLabMult: the enhancer's level and
  // tier, and the efficiency skill), 1 with no enhancer built. A small
  // reader of its own: this tab needs only that one number from the base.
  function warpCapsuleLabMult(root) {
    try {
      var eff = numOr(root.UserStore.player.skills.base_module_efficiency_boost) || 0;
      var enh = null;
      (root.BaseBuildingStore.base.modules || []).forEach(function (m) { if (m && m.name === BB_ENHANCER) enh = m; });
      return bbLabMult(enh, eff);
    } catch (e) { return 1; }
  }

  // The Galactic Exchange (Market > NPC Trader > Resources): a flat 90%
  // rate (you always lose 10%), a 1,000 minimum, and two closed tiers,
  // checked both ways in the game: the four rare resources only swap among
  // themselves, and so do the other sixteen.
  var NPC_RATE = 0.9;
  var NPC_RARE = ['argon', 'cobalt', 'dark matter', 'silicon'];
  var NPC_NORMAL = ['copper', 'gold', 'platinum', 'silver', 'carbon', 'nitrogen', 'sulfur', 'water',
    'ammonia', 'helium', 'hydrogen', 'methane', 'diamond', 'emerald', 'ruby', 'sapphire'];
  var NPC_ALL = NPC_NORMAL.concat(NPC_RARE);

  function npcTier(name) { return NPC_RARE.indexOf(name) >= 0 ? NPC_RARE : NPC_NORMAL; }

  // Per unit of "name": its own market prices, and the best same-tier swap
  // each way - to get one (a source's ask / 0.9, since you receive only 90%
  // of what you give) and to sell one you hold (swap it into a source and
  // sell that at its bid x 0.9). null where nothing is priced.
  function npcRoute(books, name) {
    var own = bookFor(books, name), gs = null, ss = null;
    npcTier(name).forEach(function (o) {
      if (o === name) return;
      var b = bookFor(books, o);
      if (b.ask !== null && (gs === null || b.ask / NPC_RATE < gs.v)) gs = { src: o, v: b.ask / NPC_RATE };
      if (b.bid !== null && (ss === null || b.bid * NPC_RATE > ss.v)) ss = { src: o, v: b.bid * NPC_RATE };
    });
    return {
      ask: own.ask, bid: own.bid,
      swap: gs ? gs.v : null, swapSrc: gs ? gs.src : null,
      swapSell: ss ? ss.v : null
    };
  }

  // One row per resource, alphabetical: the cheapest way to get it, per
  // unit. The API gives only the best price, never how much is listed there
  // (the official docs: hourly buy/sell per currency, no quantities), and
  // buying in the millions walks up the listings. So the row leads with
  // "upTo": the highest whole price the source may cost for the swap to
  // still beat buying direct (strictly below direct x 0.9 - a tie is not
  // worth the swap), which stays true however far the source's price
  // climbs. Rounded to 6 places first so 20 x 0.9 = 18 is treated as 18.
  // swap: true when swapping is the better (or the only) route.
  function npcTradeRows(books) {
    return NPC_ALL.slice().sort().map(function (name) {
      var r = npcRoute(books, name);
      var swap = r.swap !== null && (r.ask === null || r.swap < r.ask);
      return {
        name: cap(name), direct: r.ask, via: r.swap, src: r.swapSrc ? cap(r.swapSrc) : null, swap: swap,
        upTo: r.ask !== null ? Math.ceil(Math.round(r.ask * NPC_RATE * 1e6) / 1e6) - 1 : null,
        saves: swap && r.ask !== null ? 1 - r.swap / r.ask : null
      };
    });
  }

  // One Warp Capsule, at today's prices, after the lab enhancer:
  //  sellTotal: crafting with materials you hold - what they would sell for
  //             instead, at their bid (the Market tab's own "Worth");
  //  buyTotal:  buying every material outright, at its ask.
  // A material with no buyers or sellers (Dark Matter had none once) is
  // priced through its best same-tier swap instead of blanking the answer,
  // and listed in "viaSwap" so the tab can say so; a total is null only when
  // a material has no price either way. None of the nine materials between
  // the raw resources and the capsule trade, so there is no shortcut.
  function warpCapsuleCost(root, books) {
    var mult = warpCapsuleLabMult(root || {});
    var need = expandToCurrencies('warp_capsule', 1, mult);
    var buyTotal = 0, sellTotal = 0, viaSwap = [];
    Object.keys(need).sort().forEach(function (name) {
      var r = npcRoute(books, name), qty = need[name];
      var get = r.ask !== null ? r.ask : r.swap, sell = r.bid !== null ? r.bid : r.swapSell;
      buyTotal = (buyTotal === null || get === null) ? null : buyTotal + get * qty;
      sellTotal = (sellTotal === null || sell === null) ? null : sellTotal + sell * qty;
      if ((r.ask === null && r.swap !== null) || (r.bid === null && r.swapSell !== null)) viaSwap.push(cap(name));
    });
    var capsule = bookFor(books, 'warp capsule');
    return {
      mult: mult, need: need, viaSwap: viaSwap,
      buyTotal: buyTotal, sellTotal: sellTotal,
      marketBuy: capsule.ask, marketSell: capsule.bid
    };
  }

  var ecoOpen = store.get('ecoOpen', true) !== false;

  function renderEconomy() {
    var wc = warpCapsuleCost(S.storeState, S.books);
    var both = wc.marketBuy !== null && wc.sellTotal !== null, craftWins = both && wc.sellTotal < wc.marketBuy;
    var h = sect('Warp Capsule: craft or buy?') + '<div class="tiles">' +
      tile('Craft 1', wc.sellTotal !== null ? '~' + fmt(wc.sellTotal) : '--', 'your materials', craftWins ? 'good' : '') +
      tile('Buy 1', wc.marketBuy !== null ? fmt(wc.marketBuy) : '--', 'on the market', both && !craftWins ? 'good' : '') +
      tile('Lab enhancer', bbX(wc.mult), 'multiplier') +
      '</div>';

    if (both) {
      var diff = Math.abs(wc.marketBuy - wc.sellTotal);
      h += line((craftWins ? 'Craft' : 'Buy') + '. Saves ~' + fmt(diff) + ' per capsule.', craftWins ? 'good' : 'warn');
    } else if (wc.marketBuy === null) {
      h += line('No one is selling a Warp Capsule right now: nothing to compare against.', 'warn');
    } else {
      h += line('Some materials have no price at all yet: craft cost unknown.', 'warn');
    }
    if (wc.buyTotal !== null) {
      h += line('Buying all the materials instead: ~' + fmt(wc.buyTotal) +
        (wc.marketBuy !== null ? (wc.buyTotal < wc.marketBuy ? ', still cheaper than buying one.' : ', more than buying one.') : '.'));
    }
    if (wc.viaSwap.length) h += line('No market price for ' + (wc.viaSwap.length > 3 ? wc.viaSwap.length + ' materials' : wc.viaSwap.join(', ')) + ' right now: priced through a same-tier swap instead.');
    h += line('"Craft 1" is what the materials would sell for instead. Your ' + bbX(wc.mult) +
      ' lab enhancer counts at each of the 3 crafting steps, so bigger enhancer, cheaper capsule.');

    var rows = npcTradeRows(S.books), wins = rows.filter(function (r) { return r.swap; }).length;
    h += '<button class="mg" id="b_ecolist">' + (ecoOpen ? '▾ ' : '▸ ') + 'Cheapest way to get each resource' +
      '<span>' + wins + ' best by swap</span></button>';
    if (ecoOpen) {
      // Cost is what one unit really costs, not a listed price, so a swap
      // keeps one decimal below 1,000 (12.2) - rounding would hide close calls.
      var cost = function (x) { return Math.abs(x) < 1000 ? String(Math.round(x * 10) / 10) : priceTxt(x); };
      h += tbl(['Resource', 'Buy', 'Cost', 'Saves'], rows.map(function (r) {
        if (r.swap) return [r.name, { t: r.src + (r.upTo !== null ? ' up to ' + priceTxt(r.upTo) + ', swap' : ', swap (only way)'), c: 'good' },
          cost(r.via), r.saves !== null ? pct(r.saves, 0) : null];
        if (r.direct !== null) return [r.name, 'Direct', priceTxt(r.direct), null];
        return [r.name, null, null, null];
      }));
      h += line('"Up to": keep swapping while that resource costs this much or less; above it, buy direct. Cost: one unit, ' +
        pct(1 - NPC_RATE, 0) + ' swap loss included. Argon, Cobalt, Dark Matter and Silicon only swap among themselves.');
    }
    return h;
  }

  // A short plain-text report of what the script sees, copied by one button
  // in Settings, to paste into a chat when something looks wrong. It never
  // contains the API key: the key is scrubbed from the text even if some
  // value ever echoed it.
  function diagReport() {
    var L = [], now = Date.now();
    function ago(t) { return t ? hhmm(now - t) + ' ago' : 'never'; }
    function iso(t) { return t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'none'; }
    var ver = scriptVersion();
    L.push('Astrolabe ' + ver + ' report, ' + iso(now));
    L.push('Game page readable: ' + (S.storeOk ? 'yes' : 'no') + ', read ' + ago(S.lastStoreRead));
    L.push('Market calls: ' + used('market') + '/' + limitOf() + (tripped('market') ? ', PAUSED' : '') +
      ', reset ' + iso(S.budget.nextReset) + ', count read from the Profile page ' + ago(S.quotaSyncedAt));
    L.push('Auto refresh: ' + (S.inputs.marketAuto ? 'on' : 'off') + ', next ' + iso(nextMarketAt) + ', last try ' + ago(S.marketTry.at) +
      ', failures in a row ' + (S.marketTry.fails || 0) + ', host ' + (S.apiHost || 'none') +
      ', key ' + (S.key ? S.keySource + ', ' + S.key.length + ' chars' : 'missing') + (S.authFail ? ' (REFUSED: ' + (S.authMsg || '?') + ', ' + ago(S.authAt) + (S.bannedUntil ? ', suspended until ' + iso(S.bannedUntil) : '') + ')' : '') +
      ', game key ' + (S.gameKey ? S.gameKey.length + ' chars, ' + (S.gameKey === S.key ? 'same' : 'DIFFERENT') : 'not found') +
      ', etag ' + (S.marketCache && S.marketCache.etag ? 'kept' : 'none') + ', snapshot valid until ' + iso(S.marketCache && S.marketCache.validUntil));
    L.push('Hold: ' + (marketHold() || 'none'));
    L.push('Last error: ' + (S.lastErr || 'none') + (S.lastErr ? ' (' + ago(S.lastErrAt) + ')' : ''));
    L.push('Prices: ' + (S.marketSource || 'none') + ', ' + ago(S.marketStamp));
    var rr = [];
    try { rr = S.marketCache && S.marketCache.data ? rowsOf(S.marketCache.data) : []; } catch (e) {}
    var shapes = {};
    Object.keys(S.books || {}).forEach(function (k) { var sh = (S.books[k] && S.books[k].shape) || 'none'; shapes[sh] = (shapes[sh] || 0) + 1; });
    L.push('Price list: ' + rr.length + ' rows, ' + Object.keys(S.books || {}).length + ' names, shapes ' + JSON.stringify(shapes) +
      ', fields ' + (rr[0] && typeof rr[0] === 'object' ? Object.keys(rr[0]).join(',') : '-'));
    if (rr[0]) { var r0 = ''; try { r0 = JSON.stringify(rr[0]); } catch (e) {} L.push('First row: ' + r0.slice(0, 300)); }
    var goods = S.storeOk && S.storeState ? gameGoods(S.storeState) : {}, mr = marketRows(S.books, goods), priced = {};
    marketGroups(mr.rows).forEach(function (g) { L.push(g.g + ' (' + g.rows.length + '): ' + g.rows.map(function (r) { return r.name; }).join(', ')); });
    L.push('Left out (' + mr.out.length + '): ' + (mr.out.join(', ') || '-'));
    Object.keys(S.books || {}).forEach(function (k) { priced[normName(k)] = 1; });
    var noPrice = Object.keys(goods).filter(function (k) { return !priced[k]; });
    L.push('Game goods with no price (' + noPrice.length + '): ' + (noPrice.join(', ') || '-'));
    L.push('Game look: ' + (S.look ? 'background ' + (S.look.bg || 'none') + (S.look.bg ? (S.look.bgFound ? '' : ' (PICTURE NOT FOUND)') : '') + ', effect ' + (S.look.fx || 'none') + (S.look.fx ? ' (' + S.look.fxRules + ' rules)' : '') : 'not read yet'));
    var bb = S.barracks;
    L.push('Barracks boost: ' + (bb ? '+' + bb.v + '% from the ' + bb.from + ', ' + ago(bb.t) : 'never seen') +
      ', asked the game ' + (boostAsked ? ago(S.boostAskedAt) : 'no'));
    var wl = S.wkLast;
    L.push('Background work: ' + (wl ? wl.kind + ' started ' + ago(wl.at) + ', ' + (wl.end ? 'took ' + Math.round((wl.end - wl.at) / 1000) + ' s' + (wl.err ? ', ERROR ' + wl.err : ', ok') : 'still running') : 'none yet') +
      (S.wkFail ? ', WORKER REFUSED: ' + S.wkFail : ''));
    if (btRun && btRun.head) L.push('Battling: max ' + btRun.head.max + ' at level ' + btRun.p.r.level + ', winrate ' + (btRun.head.farm === null ? '-' : btRun.head.farm.toFixed(2) + '%') +
      ', options ' + btRun.p.options.map(function (o, i) { return btRun.res[i] ? btRun.res[i].max : '?'; }).join(',') + ', ' + ago(btRun.at));
    if (eqLv && eqLv.res) L.push('Equipment levels: ' + Object.keys(eqLv.res).map(function (k) { return k.replace(/_slot/, '') + ' ' + eqLv.res[k]; }).join(', '));
    var txt = L.join('\n');
    if (S.key) txt = txt.split(S.key).join('[key]');
    return txt;
  }

  /* ---- chrome ---- */

  function renderQuota() {
    if (panel.style.display === 'none') return;
    var q1 = panel.querySelector('#q1'), q2 = panel.querySelector('#q2');
    if (!q1) return;
    var n = used('market');
    q1.textContent = 'Market: ' + n + ' call' + (n === 1 ? '' : 's') + ' today';
    q2.textContent = 'resets ' + hhmm(S.budget.nextReset - Date.now());
    q1.className = remaining('market') <= S.inputs.reserve ? 'warn' : '';
  }

  // A broken tab must not take the tick down with it.
  function render() {
    try { render0(); } catch (e) { setErr('drawing the panel failed: ' + ((e && e.message) || e)); }
  }

  function render0() {
    if (panel.style.display === 'none') { btn.className = S.busy ? 'busy' : (S.lastErr ? 'bad' : (S.storeOk ? 'ok' : '')); return; }
    // Redrawing while someone types in the Spend box would throw the text away.
    if (spendEditing && tab === 'out' && panel.querySelector('#f_spend')) { renderQuota(); return; }
    var body = panel.querySelector('#body'), keep = body.scrollTop;
    // Open dropdowns stay open across the redraws of every update.
    var openKeys = {};
    body.querySelectorAll('details[open] > summary').forEach(function (x) { openKeys[tab + '|' + x.textContent.replace(/\d[\d,.]*/g, '#')] = 1; });
    tabIcons();
    gameLook();
    if (tab === 'out') { body.innerHTML = renderOut(); }
    else if (tab === 'battle') { body.innerHTML = renderBattle(); }
    else if (tab === 'an') { body.innerHTML = renderAn(); }
    else if (tab === 'mkt') { body.innerHTML = renderMkt(); }
    else if (tab === 'gal') { body.innerHTML = renderGalaxy(); }
    else if (tab === 'bat') { body.innerHTML = renderBattling(); }
    else if (tab === 'eq') { body.innerHTML = renderEquipment(); }
    else if (tab === 'eco') { body.innerHTML = renderEconomy(); }
    else { tab = 'in'; body.innerHTML = renderIn(); wireFields(); }
    body.querySelectorAll('details > summary').forEach(function (x) { if (openKeys[tab + '|' + x.textContent.replace(/\d[\d,.]*/g, '#')]) x.parentNode.open = true; });
    body.scrollTop = keep;
    // Settled here, not in each click handler, so it is right whichever
    // control changed tab: a #tabs button or the Settings gear icon.
    panel.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    var sEl = panel.querySelector('#settings'); if (sEl) sEl.classList.toggle('on', tab === 'in');
    wireButtons();
    renderQuota();
    btn.className = S.busy ? 'busy' : (S.lastErr ? 'bad' : (S.storeOk ? 'ok' : ''));
  }

  function wireButtons() {
    function on(id, fn, ev) {
      var el = panel.querySelector(id);
      if (el) el.addEventListener(ev || 'click', fn);
    }
    on('#f_key', function () {
      var typed = panel.querySelector('#f_key').value.trim();
      if (!typed) return;   // an empty box is not a key: nothing changes
      S.key = typed; S.keySource = 'manual';
      store.set('key', S.key); store.set('keySource', S.keySource);
      // A new key deserves a new try, right now: the refusal and the retry
      // back-off (which can have grown to an hour over weeks of failures)
      // are both dropped, and the tab is redrawn so the save shows.
      S.authFail = false; S.authMsg = null; S.bannedUntil = 0; setErr(null);
      S.marketTry.fails = 0; store.set('marketTry', S.marketTry);
      keySavedAt = Date.now();
      render();
      refreshMarket(true);
    }, 'change');   // on leaving the box (Tab, Enter or a click elsewhere), not per keystroke: a half-typed key once went out as a call and was refused
    on('#b_market', function () { refreshMarket(true); });
    on('#b_panelhome', function () { store.set('panelPos', null); panelHome(); });
    on('#b_report', function () {
      var txt = diagReport(), b = panel.querySelector('#b_report');
      function said(t) { if (!b) return; b.textContent = t; setTimeout(function () { b.textContent = 'Copy report'; }, 2000); }
      function manual() { try { window.prompt('Copy this report:', txt); } catch (e) {} said('Copy it from the box'); }
      try { navigator.clipboard.writeText(txt).then(function () { said('Copied'); }, manual); } catch (e) { manual(); }
    });
    on('#b_ecolist', function () { ecoOpen = !ecoOpen; store.set('ecoOpen', ecoOpen); render(); });
    on('#b_galbox', function () { galBoxOpen = !galBoxOpen; store.set('galBoxOpen', galBoxOpen); render(); });
    panel.querySelectorAll('[data-mg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var g = b.getAttribute('data-mg');
        mktOpen[g] = !mktOpen[g];
        store.set('mktOpen', mktOpen);
        render();
      });
    });
    on('#b_clearacts', function () {
      if (!confirm('Clear the gathering action log? Measured values start again from zero.')) return;
      S.acts = []; S.lastActKey = null; store.set('acts', []); store.set('lastActKey', null); render();
    });
    on('#f_recan', function () { S.inputs.recAnomalies = panel.querySelector('#f_recan').checked; saveInputs(); render(); }, 'change');
    on('#b_clearan', function () {
      if (!confirm('Clear the anomaly log? Every player\'s count goes back to zero.')) return;
      anClear(); render();
    });
    panel.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = b.getAttribute('data-sub');
        if (s) { bsub = s; bshow = false; }
        render();
      });
    });
    on('#b_showbest', function () { bshow = true; render(); });
    on('#b_btgo', btGo);
    on('#b_eqlv', function () { var g = S.storeOk ? eqRead(S.storeState) : null; if (g) eqGoLevels(eqAnalyse(g)); });
    panel.querySelectorAll('.item[data-item]').forEach(function (el) {
      el.addEventListener('click', function () { eqSel = el.getAttribute('data-item'); render(); });
    });
    // A remembered ship picture that no longer exists: forget it and redraw
    // once, so the next look finds the game's current file.
    panel.querySelectorAll('.shippic img').forEach(function (im) {
      im.addEventListener('error', function () {
        var u = im.getAttribute('src');
        im.removeAttribute('src');
        shipPicForget(u);
        render();
      });
    });
    on('#f_spend', function () { spendEditing = true; }, 'focus');
    on('#f_spend', function () { spendEditing = false; }, 'blur');
    on('#f_spend', function () {
      var v = parseAmount(panel.querySelector('#f_spend').value);
      spendEditing = false;
      if (v === null) spendErr = 'Not understood. Use 500M, 1.5B, 250k or "all".';
      else { spendErr = null; S.inputs.spendLimit = v; saveInputs(); }
      render();
    }, 'change');
    on('#b_spendall', function () { S.inputs.spendLimit = 0; spendErr = null; saveInputs(); render(); });
    on('#f_rec', function () { S.inputs.recBattles = panel.querySelector('#f_rec').checked; saveInputs(); render(); }, 'change');
    on('#b_clearrec', function () {
      if (!confirm('Clear the recorded duels? The Best build needs them.')) return;
      S.battles = []; store.set('battles', []); pvMemo = { key: null, plan: null }; pvCheck = {}; pvFailed = null; recSeen = null; recTries = { fp: null, n: 0 }; render();
    });
  }

  /* ============================================================
     14. SCHEDULING
     ============================================================ */

  var marketTimer = null, nextMarketAt = 0, pollTimer = null, lastPageQuotaTry = 0;

  function scheduleMarket() {
    if (marketTimer) clearTimeout(marketTimer);
    marketTimer = null;
    // A refused key would fail identically on every tick, so do not schedule.
    if (S.authFail || !S.key) { nextMarketAt = 0; return; }
    if (!S.inputs.marketAuto) { nextMarketAt = 0; return; }
    // Stated explicitly, even though spendable() is already 0 once tripped:
    // a tripped breaker should never depend on that chain staying correct
    // to actually stop scheduling.
    if (tripped('market')) { nextMarketAt = 0; return; }
    if (spendable('market') <= 0) { nextMarketAt = 0; return; }
    // After a failure the wait doubles (1, 2, 4, 8 minutes...) up to an hour,
    // measured from the last attempt: measuring from the last success is
    // what once made a failed call repeat every 5 seconds. Otherwise the next
    // call is due once a newer hourly snapshot is out.
    var fails = S.marketTry.fails || 0;
    // The server says when its next snapshot lands (Cache-Control); the
    // hourly mark is the fallback when no answer has said so yet.
    var valid = S.marketCache && S.marketCache.validUntil > Date.now() ? S.marketCache.validUntil + 15000 : 0;
    var due = fails ? (S.marketTry.at || 0) + Math.min(HOUR_MS, 60000 * Math.pow(2, fails - 1))
      : (valid || marketMarkAfter(S.marketStamp || 0));
    var wait = Math.max(5000, due - Date.now());
    nextMarketAt = Date.now() + wait;
    marketTimer = setTimeout(function () { refreshMarket(false); }, wait);
  }

  // Called on every update: nothing else schedules the next call after a
  // day's reset has lifted a stop.
  function marketWake() { if (!marketTimer && !S.busy) scheduleMarket(); }

  function startStorePoll() {
    if (pollTimer) clearInterval(pollTimer);
    // Never slower than 11 s: an action lands every 12 s, and a poll slower
    // than that silently skips actions from the gathering log.
    var secs = Math.min(11, Math.max(3, S.inputs.storePoll || 10));
    pollTimer = setInterval(function () { stage('the update', tick); }, secs * 1000);
  }

  // The loaded-duel slot and Main chat are watched on this same faster timer
  // (see recTick, anTick); a duel and an anomaly line can arrive between two
  // 10-second ticks of the normal refresh, so both get looked at every second.
  function startRecWatch() {
    if (recTimer) clearInterval(recTimer);
    recTimer = setInterval(function () { stage('recording the duel', recTick); stage('tallying anomalies', anTick); }, REC_WATCH_MS);
  }

  function tick() {
    mount();
    // A one-off failure should not leave the dot red for the rest of the day.
    if (S.lastErr && S.lastErrAt && Date.now() - S.lastErrAt > 600000) setErr(null);
    refreshFromStore();
    stage('listening for mystery boxes', boxListen);
    marketWake();
    if (actsDirty) saveActs(false);
    // Whenever the Game API tab happens to be open, take the real count, at
    // most every 30 s: that is how often those numbers can meaningfully
    // change, and each look reschedules the market.
    if (Date.now() - lastPageQuotaTry > 30000 && /^#\/profile/.test(location.hash)) { lastPageQuotaTry = Date.now(); readQuotaFromPage(); }
    if (panel.style.display !== 'none' && liveTab()) render();
    else renderQuota();
  }

  /* ============================================================
     15. BOOT
     ============================================================ */

  rollBudget();
  loadCachedMarket();
  startRecWatch();
  // The gathering log is saved at most once a minute; whatever is still
  // unsaved goes out when the page is hidden or closed.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushActs(); });
  window.addEventListener('pagehide', flushActs);

  // The Vue app may not have mounted yet; retry for a while, then give up
  // quietly and fall back to manual inputs.
  var tries = 0;
  (function tryStore() {
    var ok = stage('the first read', refreshFromStore);
    if (ok) { startStorePoll(); scheduleMarket(); render(); return; }
    if (++tries > 40) { startStorePoll(); scheduleMarket(); render(); return; }
    setTimeout(tryStore, 1000);
  })();

  render();
})();
