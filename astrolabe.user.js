// ==UserScript==
// @name         Astrolabe for Stellar Odyssey (beta)
// @namespace    stellarodyssey-calc
// @version      3.11.0
// @description  Gathering, market, arena and base calculator for Stellar Odyssey. Reads live game state from the page (free, unlimited) and spends the rate-limited API only on the market. Beta: actively being added to and tested.
// @match        *://steam.stellarodyssey.app/*
// @match        *://*.stellarodyssey.app/*
// @connect      steamapi.stellarodyssey.app
// @connect      api.stellarodyssey.app
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
     CHANGES IN 3.11.0

     A review pass: mistakes, dead code and speed. Nothing you see changes
     except that it no longer slows the game down as duels pile up.

     THE FREEZE. 3.10.0 raised the duel cap from 40 to 200 without
     re-checking the planner. Its cost grew with the number of duels on
     record while the work was still cut into fixed-size pieces, so the
     pieces got longer. Measured with 200 duels, every fight contested:
     9.9 s to plan and a single freeze of 992 ms. Now 2.0 s and about
     100 ms. Three changes did it:
       - the search for a better build runs on an even sample of 40
         contested opponents (PV_SEARCH_MAX). The reported win rate, error
         bar and gain are still measured over every opponent on record;
       - the six finalists between skill sets are settled on the FULL
         contested pool, because they are close together, which is exactly
         when a small sample misleads. With finalists on the sample only,
         one of five test pools picked a different skill and lost 2.5
         points; with this, all five picked the identical build;
       - slices are sized by the clock (PV_SLICE_MS = 35) rather than by a
         fixed count, and one scoring call is capped at 2000 battles.

     THE SIMULATOR. It was still the squadron relay engine: a line of
     fighters a side, the next stepping in when one died, a damage penalty
     after each win. Duels are one against one, so none of that could
     happen, but every hit paid for it. Now a one against one engine with
     reused clone buffers, 1.6x faster. Checked against the old engine over
     36,000 battles in six matchups: every one agrees on winner, rounds and
     both health fractions. (t/sim_equiv.js keeps the old engine from
     3.10.1 as the reference.)

     A BUG. Planning wrote two scratch fields (pRef, eRef) onto the stored
     duel records, so they were saved to disk. They are now passed in.

     DEAD CODE removed: rlWinRate, rlGauntlet, bbShownOut, the kill
     multiplier and kill counter, unread battle result fields, two orphaned
     CSS rules, a duplicate section number.

     THE MODEL CHECK on the Duels tab replayed every duel 100 times, which
     for 200 duels trickled work for nearly nine seconds. It now checks the
     40 most recent, 40 replays each.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.10.1

     Renamed. SO CALC is now ASTROLABE: an astrolabe is the old
     instrument for working out where you are from the stars, which is
     near enough what this does. Marked beta, in the name and as a pill
     beside the title, because it is still being added to and tested.

     The version number stays plain (3.10.1, not 3.10.1-beta) on purpose:
     Tampermonkey sorts a pre-release suffix BELOW the plain number, so
     dropping the word later would read as a downgrade and the update
     would be refused.

     Stored data is untouched. Settings, history and recorded duels stay
     under the socalc: keys they have always used - renaming those would
     wipe everything - so the rename costs you nothing.

     Note on installing: Tampermonkey tells scripts apart by name, so this
     arrives as a NEW entry beside the old SO CALC one, and both will run
     at once until the old one is deleted. Delete SO CALC after installing.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.10.0

     One duel is noisy. This version says how sure it is, and keeps quiet
     until it has something worth saying.

       A floor.      Nothing is suggested until 8 duels are on record.
                     Below that, whichever build came out ahead did so by
                     luck, and following it would be worse than leaving
                     the build alone. The Duels tab counts down to it.

       Easy fights   A fight you always win, or always lose, gives the
       ignored.      same result for every build, so it says nothing
                     about which build is better. Those are set aside and
                     the tuning runs on the ones that could go either
                     way. If fewer than 3 are left, it says so and offers
                     nothing rather than tuning against noise.

       An error bar. An opponent's precision and evasion are measured
                     from a few dozen swings, so each one is now carried
                     as five equally likely versions of itself, spread by
                     the standard error of those counts. A build is
                     scored against all five, so one that only wins
                     against the flattering version stops looking good.
                     The win rate comes with a +/- made from how much the
                     opponents disagree, and the Current tab says how
                     many more duels would bring it to +/-5.

       A real bar    The old rule was a fixed "better by 5 points".
       for change.   Now a change has to beat twice its own error bar,
                     measured by comparing the two builds opponent by
                     opponent with the same random numbers, which cancels
                     most of the noise. The setting stays as a floor.

     Records now keep the swing counts they were measured from, so an
     estimate read off 12 swings is no longer treated like one read off
     120. Duels recorded by 3.9.0 are kept: having no counts of their own,
     they are read as if they came from a short duel, so they carry more
     doubt than the new ones rather than less. 200 duels are kept now
     instead of 40, at about 290 bytes each.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.9.0

     The build suggestion now runs on ARENA duels instead of squadron
     battles. The arena is one fighter against one fighter, ten attacks a
     day plus whatever comes in, and its log carries hpLeft as
     "[hp/maxhp]" on every landed hit, so an opponent's clone count,
     health per clone and damage per hit are read as facts instead of
     guessed. Only precision, evasion, skills and the crit profile are
     still inferred, from how often each side hit and from the spread of
     the damage values.

     What that removes: the relay ordering and the damage penalty after
     each win, both of which existed only because squadron fights chain
     fighters together, and the second of which was partly a guess.

       Current   your build, and how often it wins in the arena.
       Best      a different build only when it is clearly better.
       Upgrades  next upgrades ranked by the change in win rate.
       Duels     the duels on record, with the model check.

     The score is now a win rate against the opponents you have actually
     met, which is a number that means something on its own.

     A duel is recorded whenever the game has one loaded, so fighting or
     opening any duel in Battlefield > Battle Log > Arena files it away.
     40 are kept, no player names. Squadron battle
     recording is gone; records made by 3.7.x are dropped on load.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.8.0

     New Base tab, for the base modules and the laboratory.

       Next    the three upgrades that would raise production most,
               ranked by how much more you would make, counting only the
               jobs you actually have running in the lab queue. Credits
               are treated as one purse, so only the first credit-funded
               row is offered today.
       Base    every module with its boost and its true average output.
       Lab     every laboratory building and forge with its craft timer,
               what it makes and how much an hour.

     The numbers come from the game's own code and were checked against
     what the game displays: the boost on all eight modules that show one,
     the printed output of six of them, the craft timers of four running
     jobs, the stellarium tier prices, the module level price and the
     credit cost of a laboratory level. Nothing here is applied to the
     game; the tab only reads and suggests.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.7.3  (speed, memory and safety; nothing was added)

     Every tab shows exactly what it showed in 3.7.2.

       - The script used to search the game's whole memory 17 times on
         every tick, about 750 ms every 10 seconds on a real account. The
         droids, the gathering level and the named counters are now read
         from where they are, the counters are only collected when a
         sample is actually due, and the market scan runs once a minute
         instead of every tick. A tick is now a few milliseconds.
       - One property that throws when read used to stop the script for
         good: the error escaped before the poll was ever started, and
         nothing was logged or recorded afterwards while the panel still
         looked normal. Every read is now guarded and each stage of a tick
         is isolated, so one bad value costs that stage, not the script.
       - The activity history kept 104 counters per sample even though
         about 90 of them never change. Only the ones that have actually
         moved are kept now (plus resources and the named ones), and the
         history is capped at 150 samples and 120 days. About 1.1 MB
         became roughly 150 KB.
       - The battle plan now works in smaller pieces, so it no longer
         holds the page for a third of a second at a time.
       - A saved API key is no longer written back into the settings box,
         matching what the comment there always claimed.
       - Smaller: settings are only saved when they change, the price age
         only restarts when the prices really change, a one-off error
         clears itself after 10 minutes, the panel is not redrawn while
         hidden, and the page-wide DOM watcher is gone.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.7.2  (fixes to the battle recorder, nothing else)

       - A battle is no longer recorded before your squad's builds have
         loaded (after a page reload they load once the Battlefield page
         has been opened). Before, it stored your fighters without
         precision and every enemy with a guessed 500 precision and 500
         evasion. It now waits, and records once the builds are known.
         Records of that kind made by 3.7.0 and 3.7.1 are dropped.
       - The winner is read from the log's "won" event when the battle has
         no winner field (a battle opened with "View battle" in the Battle
         Log has none, and used to be recorded as a loss).
       - The record carries the battle's own time and id, so a battle
         opened from the Battle Log is dated correctly and never stored
         twice.
       - "~" now means your side of that battle is approximate: one of
         your fighters has changed since (or left the squad), found by
         comparing today's build with the damage and health in the battle.
         It replaces the old "already in memory at start" mark.
       - Newest 20 battles are kept, by battle time.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.7.1

     Yield suggestions: a "Spend" box. Type how much to spend and the plan
     uses at most that (500M, 1.5B, 250k or plain digits; empty or "all" =
     everything above "Credits to keep", as before). It is saved, and
     applies when you press Enter or click away. The rest of the plan, the
     payback limit and the droid option are unchanged.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.7.0

     Battle tab, rebuilt. Four sub-tabs: Current, Best, Upgrades, Fights.
       - Squadron fights are relays, not duels: one fighter per side at a
         time, the winner keeps its surviving clones and health, and every
         win makes the next hits softer. The simulator now follows that.
       - A background recorder keeps the last 20 finished squadron
         battles (about 1.5 KB each, no player names). It works on the
         normal tick, whichever tab is open, and can be switched off.
       - Your build is tested against the enemies actually met, not
         against a copy of itself. Score = share of a line of four recorded
         enemies that one of your fighters takes down.
       - Best only proposes a different build when it is clearly better
         (Settings: "Change only if better by", 5 points, 8 while fewer
         than 8 enemy fighters are recorded). Otherwise it says your build
         is within the optimal range.
       - Upgrades are ranked by the simulated gain in score.
       - Fights shows the recorded battles and a model check: each battle
         is replayed with its recorded fighters and compared to what
         really happened.
     Enemy precision, evasion and skills are estimated from hit rates in
     the log. Nothing is ever applied to the game.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.5.0

     Battle tab: your PvP build for squadron fights, and a better one.
     It shows the current build (stat points, the four gear pieces with
     level, tier, active stat and active skill, and the resulting damage,
     health, precision and evasion, which match what the game shows), then
     a suggested build:
       - how to split the stat points (all of them can be re-assigned),
       - which stat each gear piece should feed,
       - which skill each piece should carry (chosen by simulating duels),
       - which upgrades to buy with the materials and badges you have, and
         what the next ones are worth.
     The suggestion is measured by simulating duels with the rules from the
     game's wiki, against an opponent with your current build (or the
     precision and evasion you enter in Settings). Nothing is changed for you.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.4.1

     API key handling. The script contains no key. Each player's own key is
     read from their own game account (UserStore.apikey) and stays in their
     browser; it is only ever sent to the game's API as the request header.
     The guesses that could pick up an unrelated token (any field called
     key / token / secret, and a scan of the browser's saved data) are gone.
     Settings now always has an API key section that says where the key came
     from, and lets a player paste their own.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.4.0

     Suggestions, at the bottom of Yield. The script now works out what to
     spend credits on to earn more, and when each purchase pays for itself.
       - Droid upgrades. The game's own price formula is used (a stat going
         from x to x + 0.1 costs 5000 * i * e^(0.15 * i) credits, i = x + 0.1).
         Efficiency and storage each add 1% of a survivor's ore per point;
         maneuverability adds 0.5% survival per point. Credits are spent
         step by step on whichever droid stat pays back fastest, until your
         credits, or the payback limit in Settings, run out. That is the best
         possible split, because the price of every step rises.
       - Buying the next droid, with the price read from the game.
       - Extra credits per hour, the cost and the payback for each, at the
         current market prices.
     The plan is only a suggestion. Nothing is bought for you.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.3.0

     1. The API count is now the game's own, read in the background. The
        game asks its server for it over its websocket (Player.getApiQuota,
        the Profile > Game API tab); the script sends that same question and
        reads the answer, so no page changes and no API call is spent. It
        runs at start, every 5 minutes and after each market call. The
        "sync" button repeats it, and if the background read is impossible it
        falls back to opening Profile for a moment. Until a read succeeds
        the count is marked "~" and only grows with the script's own calls.
     2. Only clear stats remain. The Data and Status tabs, the debug copy
        buttons and the /user button are gone. The tabs are now Yield,
        Actions, Gear, Activity and Settings. Problems appear as one short
        warning line on Yield.
     3. Resource bonus is complete: catalysts, Amplifier, Reputation, Pet,
        Subscription and the Income boost, which adds up to the +262.4% the
        game shows.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.2.0

     Interface rebuilt for readability. Stat tiles and compact tables replace
     the monospace text blocks, explanatory text is gone, and there is a
     light / dark toggle in the header (light is the default). The tabs are
     Yield, Actions (the measured gathering statistics), Activity, Inputs,
     Data and Status. No calculation changed.
     ============================================================ */

  /* ============================================================
     CHANGES IN 3.1.0  (measured from the live game, 2026-09-19)

     What the game was observed to do:
       - Gathering runs on the server, ONE ACTION EVERY 60 SECONDS.
       - Each action picks ONE resource (the node's rare one, or one of its
         four commons). Every droid then rolls to survive; survivors each
         receive "ore". Destroyed droids get nothing.
       - Ore per survivor is not random. For one droid and one resource it
         is a fixed number, and it scales with (1 + efficiency% + storage%).
         Two droids at eff 20.8 / sto 21.5 got 172,906; one at 18.4 / 21.3
         got 169,746, and 1.397 / 1.423 = 0.98173 matches to 5 digits.
       - The resource count rises by exactly the action's "amount"; the
         global tax (about 6%) is charged on top, not taken out of it.
       - The result of every action is in GatherStore.lastReward, and the
         node being gathered is in GatherStore.currentGatheringBody. Both
         update in the background on every page, not only on Gathering.

     What changed because of that:
       1. Every action is now logged (Fit tab). Survival rate, rare
          frequency and ore per survivor are MEASURED from the log and used
          for the projection once there are enough actions. The old guessed
          constants are only the starting point.
       2. The model no longer treats efficiency as attack speed. Attempts
          are 60/hour, and efficiency + storage scale the ore.
       3. Node type follows the node you are actually gathering.
       4. Catalyst bonuses are computed with the game's own formula, which
          reproduces its totals exactly (gathering yield 52.40, gathering
          XP 49.80, block 37.60):
            effect% = range/100 * statMax * rarityMultiplier * (halved ? .5 : 1)
       5. The Status tab lists the bonus sources it can read.

     CHANGES IN 3.0.1

     1. Mods scan now reads only the EQUIPPED ship slots (ShipStore.*_slot).
        Before, it walked the whole state and also summed the bonuses of
        every item sitting in the bag (InventoryStore.itemList), so 2
        equipped rare-drop mods + 11 in the bag = "rare +130%", which
        clamped the rare chance to 100% and zeroed the common output.
     2. Resource counts are read from CurrencyStore (flat numbers such as
        diamond, ruby, cobalt, dark_matter). The old reader looked for a key
        named inventory/resources/materials and found nothing useful, so
        Calibrate never got any snapshots.
     3. CurrencyStore resources are also recorded as counters, so the
        Activity tab shows per-hour resource gains.
     4. Mod totals are always overwritten from the equipped scan, even when
        it finds nothing, so an inflated value saved by 3.0.0 cannot linger.
     5. A warning shows when the rare chance reaches 100%.
     ============================================================ */

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

  var HOSTS = ['https://steamapi.stellarodyssey.app', 'https://api.stellarodyssey.app'];
  var PATHS = { user: '/api/public/user', market: '/api/public/market' };
  var DAILY_LIMIT = 50;

  var NODES = {
    rocky:   { commons: ['Copper', 'Gold', 'Silver', 'Platinum'],     rare: 'Dark Matter' },
    icy:     { commons: ['Water', 'Nitrogen', 'Sulfur', 'Carbon'],    rare: 'Silicon' },
    gas:     { commons: ['Ammonia', 'Hydrogen', 'Helium', 'Methane'], rare: 'Argon' },
    crystal: { commons: ['Diamond', 'Ruby', 'Emerald', 'Sapphire'],   rare: 'Cobalt' }
  };

  // These are only the STARTING POINT. Once enough gathering actions have been
  // logged, survival, rare chance and ore per survivor are measured instead.
  //
  //   attemptsPerHour  60      OBSERVED  one action per 60 s (also stated in the wiki)
  //   baseDodge        50      from the game bundle: dodge = 50 + man/2 + mods
  //   manToDodge       0.5     from the game bundle. Live check on 2026-09-19:
  //                            46 of 77 droid rolls survived (59.7%) against
  //                            60.5% predicted. Consistent.
  //   baseRare         20      GUESS. With the +20 from laser and probes this
  //                            gives 40%; 5 of the first 11 actions were rare.
  //   kCommon, kRare           ore per survivor for a droid with eff+sto = 0,
  //                            at the player's bonuses on 2026-09-19. Measured
  //                            over 46 live survivors: 121,508 and 2,117 (e.g.
  //                            172,906 and 3,012 at eff 20.8 + sto 21.5, divided
  //                            by 1.423). They change when bonuses change, which
  //                            is why the script measures them.
  var DEFAULT_MODEL = {
    baseDodge: 50,
    manToDodge: 0.5,
    attemptsPerHour: 60,
    baseRare: 20,
    kCommon: 121500,
    kRare: 2117
  };

  var MOD_DEFAULTS = { bDodge: 5, bRareChance: 10 };

  // Catalyst effect, taken from the game's own code and checked against the
  // totals it displays. Maximum per stat, and a multiplier per rarity.
  var CAT_MAX = {
    defense: 10, armor_penetration: 10, lifesteal: 3, stun: 10, block: 10, dot: 10,
    precision: 5, evasion: 5, battling_xp: 10, battling_credits: 10, gathering_xp: 10,
    gathering_yield: 10, exploring_xp: 10, cosmic_dust_bonus: 10, crafting_xp: 10,
    crafting_scrap: 10, catalyst_drop_chance: 5, fuel_efficiency: 5,
    voyager_jumps_bonus: 2, base_upkeep_reduction: 5
  };
  var RARITY_MULT = { normal: 1, common: 1, uncommon: 1.5, rare: 2, unique: 2.5, epic: 3, legendary: 4 };
  var SHIP_SLOTS = ['weapon_slot', 'shield_slot', 'engine_slot', 'sensors_slot', 'laser_slot', 'probes_slot'];

  var AR_MAX_STORE = 200;   // duels kept; see AR_MAX in section 12d

  var DEFAULT_INPUTS = {
    node: 'crystal', hours: 24,
    autoNode: true,       // follow the node currently being gathered
    useObserved: true,    // use measured values once enough actions are logged
    minActions: 20,       // actions needed before measured values are trusted
    autofill: true, activeOnly: true,
    storePoll: 10,        // seconds between free page-state reads
    recordMins: 10,       // minutes between history samples
    marketAuto: true,     // spend budget automatically on the market
    reserve: 10,          // calls held back for manual use
    keepCredits: 0,       // credits the upgrade plan must leave untouched
    spendLimit: 0,        // most the upgrade plan may spend (0 = everything above the reserve)
    keepBadges: 0,        // PvP badges the gear upgrade plan must leave untouched
    bestGap: 2,           // floor on the gain; the real bar is twice the error bar
    recBattles: true,     // keep a record of finished squadron battles
    maxPaybackDays: 30,   // upgrade steps that pay back slower than this are not suggested
    resetHour: 20,        // local hour the daily quota resets
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

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

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

  function findVueApp() {
    var roots = [];
    ['#app', '#q-app', '#__nuxt', '#root', 'body > div'].forEach(function (sel) {
      try { document.querySelectorAll(sel).forEach(function (n) { roots.push(n); }); } catch (e) {}
    });
    try { document.querySelectorAll('body div').forEach(function (n, i) { if (i < 60) roots.push(n); }); } catch (e) {}
    for (var i = 0; i < roots.length; i++) {
      var el = unwrap(roots[i]);
      try { if (el && el.__vue_app__) return el.__vue_app__; } catch (e) {}
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
      var out = {}, ids = Object.keys(sv);
      ids.forEach(function (id) { try { out[id] = sv[id]; } catch (e) {} });
      out.__storeIds = ids;
      return out;
    } catch (e) { return null; }
  }

  /* ============================================================
     5. INTERPRETING STATE  (works on store state or API payload)
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
  // For any other payload (the /user API) the bag is skipped by name.
  function scanBonuses(root) {
    var totals = { bRareChance: 0, bRareAmount: 0, bGatherYield: 0, bNodeQuality: 0, bDodge: 0 };
    var matched = [], unmatched = [], assumed = 0;
    var ship = root && root.ShipStore && typeof root.ShipStore === 'object' ? root.ShipStore : null;
    var scope = ship || root;
    walk(scope, function (k, v, path) {
      if (!BONUS_ARRAY_KEYS.test(k) || !Array.isArray(v)) return;
      if (!ship) {
        for (var p = 0; p < path.length; p++) {
          if (/^(itemList|inventory|InventoryStore)$/i.test(String(path[p]))) return;
        }
      }
      var owner = path.length ? path[path.length - 1] : 'root';
      v.forEach(function (entry) {
        var txt = textOf(entry).trim();
        if (!txt) return;
        var id = classify(txt);
        if (!id) { if (unmatched.length < 60) unmatched.push(owner + ': ' + txt); return; }
        var mag = magnitudeOf(entry);
        var guessed = false;
        if (mag === null && MOD_DEFAULTS[id] !== undefined) { mag = MOD_DEFAULTS[id]; guessed = true; assumed++; }
        if (mag === null) { if (unmatched.length < 60) unmatched.push(owner + ': ' + txt + ' (no number)'); return; }
        totals[id] += mag;
        matched.push(owner + ': ' + id.slice(1) + ' ' + (mag >= 0 ? '+' : '') + mag + (guessed ? ' [assumed]' : '') + '  <- "' + txt + '"');
      });
    }, ship ? 5 : 9);
    return { totals: totals, matched: matched, unmatched: unmatched, assumed: assumed, authoritative: !!ship };
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
        var max = CAT_MAX[c.stat], mult = RARITY_MULT[c.rarity], range = numOr(c.range);
        if (max === undefined || mult === undefined || range === null) return;
        out[c.stat] = (out[c.stat] || 0) + range / 100 * max * mult * (c.halved ? 0.5 : 1);
        count++;
      });
    });
    return { totals: out, count: count };
  }

  // Every part of the resource bonus the game adds up (checked against the
  // +262.4% it shows): catalysts, Amplifier (level x 2), Reputation (space
  // stations x 5), the slotted Dog pet (its level), Subscription (+10) and
  // the Income boost (+25 while it is running).
  function resourceSources(root) {
    var out = [];
    var cat = catalystTotals(root);
    if (cat) out.push({ name: 'Catalysts', pct: cat.totals.gathering_yield || 0 });
    try {
      var b = root.UserStore.squadron.buildings || [], amp = null;
      for (var i = 0; i < b.length; i++) if (b[i] && b[i].name === 'Amplifier') amp = b[i];
      if (amp) out.push({ name: 'Amplifier', pct: amp.level * 2 });
    } catch (e) {}
    try {
      var ss = numOr(root.UserStore.squadron.power.spaceStations);
      if (ss !== null) out.push({ name: 'Reputation', pct: ss * 5 });
    } catch (e) {}
    try {
      var P = root.PetsStore, dog = null;
      (P.pets || []).forEach(function (p) { if (p && p.name === 'Dog') dog = p; });
      if (dog) {
        var slotted = (P.petSlots || []).some(function (s) { return s && s.pet === dog._id; });
        if (slotted) out.push({ name: 'Dog pet', pct: dog.level });
      }
    } catch (e) {}
    try { if (root.PremiumStore && root.PremiumStore.active) out.push({ name: 'Subscription', pct: 10 }); } catch (e) {}
    try {
      (root.GlobalBoostsStore.currentBoosts || []).forEach(function (x) {
        var nm = x && x.boost && x.boost.name, t = numOr(x && x.timer);
        // timer is the moment the boost ends, in seconds since 1970
        if (nm === 'Income' && t !== null && t * 1000 > Date.now()) out.push({ name: 'Income boost', pct: 25 });
      });
    } catch (e) {}
    return out;
  }

  /* ============================================================
     5a. GATHERING ACTIONS

     Every 60 s the server runs one action and the result lands in
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

  function normRes(s) { return String(s || '').toLowerCase().replace(/_/g, ' ').trim(); }

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
    var n = normRes(name);
    if (n === normRes(node.rare)) return 'rare';
    for (var i = 0; i < node.commons.length; i++) if (n === normRes(node.commons[i])) return 'common';
    return null;
  }

  function logAction(gth) {
    var r = gth && gth.reward;
    if (!r || !Array.isArray(r.statistics) || !r.statistics.length) return;
    var key = normRes(r.name) + '|' + r.amount + '|' + gth.nextActionAt;
    if (key === S.lastActKey) return;
    S.lastActKey = key; store.set('lastActKey', key);

    // The reward can belong to the previous node for one action after a switch,
    // so it only counts if the resource is one this node can actually give.
    var nodeKey = gth.body && gth.body.nodeType ? String(gth.body.nodeType).toLowerCase() : null;
    if (!nodeKey || !resClass(nodeKey, r.name)) return;

    // Actions are 60 s apart and nextActionAt is the time of the following one.
    var t = gth.nextActionAt ? gth.nextActionAt - 60000 : Date.now();
    var last = S.acts[S.acts.length - 1];
    if (last && Math.abs(t - last.t) < 30000) return;   // the same action seen twice

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
    S.acts.push({ t: t, n: nodeKey, r: normRes(r.name), k: k, o: oreSum, x: taxSum });
    if (S.acts.length > 1500) S.acts = S.acts.slice(-1500);
    store.set('acts', S.acts);
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
      taxRate: ore ? tax / ore : null,
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
    return best.map(function (d, i) {
      return {
        idx: i + 1, name: typeof d.name === 'string' ? d.name : ('Droid ' + (i + 1)),
        eff: statOf(d, ['efficiency', 'eff']),
        sto: statOf(d, ['storage', 'cargo', 'capacity']),
        man: statOf(d, ['maneuverability', 'maneuver', 'agility']),
        active: droidIsActive(d)
      };
    });
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

  function looksLikeKey(v) {
    return typeof v === 'string' && v.length >= 16 && v.length <= 128 && /^[A-Za-z0-9_.\-]+$/.test(v);
  }

  // The key lives on the player's own account. Only that field, or a field
  // with an unmistakable name, is used. Nothing else in the state is guessed.
  function readApiKey(root) {
    try { var direct = root.UserStore.apikey; if (looksLikeKey(direct)) return direct; } catch (e) {}
    var found = null;
    walk(root, function (k, v) {
      if (found || !looksLikeKey(v)) return;
      if (/^(sodyssey_?api_?key|api_?key|apikey|public_?api_?key)$/i.test(k)) found = v;
    }, 8);
    return found;
  }

  /* ============================================================
     5b. COUNTERS AND RECORDING

     Daily / weekly / monthly figures cannot come from a snapshot.
     Anything numeric under a statistics-like object is recorded on a
     timer, so the history exists by the time a calculator wants it.
     ============================================================ */

  var COUNTER_PARENTS = /^(statistics|stats|counters|totals|progress|lifetime)$/i;

  var NAMED_COUNTERS = [
    { id: 'credits', re: /^credits?$/i },
    { id: 'quantumCores', re: /^(quantum_?cores?|qcores?)$/i },
    { id: 'stellarium', re: /^stellarium$/i },
    { id: 'cosmicDust', re: /^(cosmic_?dust)$/i },
    { id: 'level.gathering', re: /^gathering_?level$/i },
    { id: 'level.battling', re: /^battl(e|ing)_?level$/i },
    { id: 'level.exploring', re: /^explor(e|ing)_?level$/i },
    { id: 'level.crafting', re: /^craft(ing)?_?level$/i },
    { id: 'voyager.expeditions', re: /voyager.*(count|total|completed|expeditions)|expeditions?_?(count|completed|total|done)/i },
    { id: 'explore.systems', re: /(systems?_?(explored|discovered|scanned))|explored_?systems/i },
    { id: 'battle.kills', re: /(npc_?kills|kills_?total|battles?_?(won|completed))/i }
  ];

  function findNumberWithPath(obj, re) {
    var out = null;
    walk(obj, function (k, v, path) {
      if (out !== null) return;
      if (!re.test(k)) return;
      var n = numOr(v);
      if (n !== null && typeof v !== 'object') out = { path: path.concat(k).join('.'), value: n };
    }, 8);
    return out;
  }

  var NAMED_IDS = {};
  NAMED_COUNTERS.forEach(function (d) { NAMED_IDS[d.id] = 1; });

  // Where each named counter was found last time. Searching the whole state
  // for all eleven of them, on every sample, was most of the old cost.
  var cpaths = store.get('cpaths', {});

  function collectCounters(state) {
    var out = {}, n = 0, cDirty = false;
    walk(state, function (k, v, path) {
      if (n > 150) return;
      if (!COUNTER_PARENTS.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) return;
      var base = path.concat(k).join('.'), keys;
      try { keys = Object.keys(v); } catch (e) { return; }
      keys.forEach(function (kk) {
        if (n > 150) return;
        var val;
        try { val = v[kk]; } catch (e) { return; }   // a getter may throw
        if (typeof val === 'boolean') return;
        var num = numOr(val);
        if (num !== null && typeof val !== 'object') { out[base + '.' + kk] = num; n++; }
      });
    }, 8);

    // Resource totals live flat on CurrencyStore. Credits and cosmic dust
    // are handled by the named counters below, so they are skipped here.
    var cs = state && state.CurrencyStore;
    if (cs && typeof cs === 'object') {
      var ck;
      try { ck = Object.keys(cs); } catch (e) { ck = []; }
      ck.forEach(function (kk) {
        if (/^(credits?|cosmic_?dust)$/i.test(kk)) return;
        var val;
        try { val = cs[kk]; } catch (e) { return; }
        if (typeof val === 'number' && isFinite(val)) out['res.' + kk] = val;
      });
    }

    NAMED_COUNTERS.forEach(function (d) {
      var path = cpaths[d.id], v = path ? getByPath(state, path) : null;
      if (v === null) {                                  // not known, or it moved
        var hit = findNumberWithPath(state, d.re);
        if (!hit) return;
        path = hit.path; v = hit.value;
        if (cpaths[d.id] !== path) { cpaths[d.id] = path; cDirty = true; }
      }
      out[d.id] = v;
      // Drop the raw path so the same number is not listed twice.
      if (path !== d.id && out[path] !== undefined) delete out[path];
    });
    if (cDirty) store.set('cpaths', cpaths);
    return out;
  }

  function dayKey(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // Resources and the named counters are always worth keeping. Of the rest,
  // only the ones that have actually moved since recording began: on a real
  // account about ninety of the hundred-odd counters never change, and
  // keeping them made the history eight times larger than it needed to be.
  function counterKept(id) {
    return NAMED_IDS[id] === 1 || id.indexOf('res.') === 0 || S.movers[id] === 1;
  }

  function recordSample(state) {
    // The clock is checked BEFORE the counters are collected. Collecting them
    // every tick and then throwing them away was the single most expensive
    // thing the script did.
    var now = Date.now();
    var last = S.series[S.series.length - 1];
    var gap = Math.max(1, S.inputs.recordMins || 10) * 60000;
    if (last && now - last.t < gap) return;

    var c = collectCounters(state);
    if (!Object.keys(c).length) return;

    var mDirty = false, slim = {};
    Object.keys(c).forEach(function (k) {
      if (S.seen0[k] === undefined) { S.seen0[k] = c[k]; mDirty = true; }
      else if (S.movers[k] !== 1 && c[k] !== S.seen0[k]) { S.movers[k] = 1; mDirty = true; }
      if (counterKept(k)) slim[k] = c[k];
    });
    if (mDirty) { store.set('seen0', S.seen0); store.set('movers', S.movers); }

    S.series.push({ t: now, c: slim });
    if (S.series.length > 150) S.series = S.series.slice(-150);

    var day = dayKey(now);
    // Only the current day keeps a full baseline; older days keep just
    // their gains, so a year of history stays small.
    if (S.curDay && S.curDay !== day && S.daily[S.curDay]) delete S.daily[S.curDay].base;
    S.curDay = day;

    var d = S.daily[day];
    if (!d) { d = S.daily[day] = { firstT: now, lastT: now, base: c, gain: {} }; }
    d.lastT = now;
    if (d.base) {
      var g = {};
      Object.keys(c).forEach(function (k) {
        if (!(k in d.base)) return;
        var delta = c[k] - d.base[k];
        if (delta !== 0) g[k] = delta;
      });
      d.gain = g;
    }

    var days = Object.keys(S.daily).sort();
    while (days.length > 120) { delete S.daily[days.shift()]; }

    store.set('series', S.series);
    store.set('daily', S.daily);
    store.set('curDay', S.curDay);
  }

  // Whole calendar days, newest included. days=1 is today only, so it
  // cannot pick up yesterday's tail the way a rolling window does.
  function gainsOver(days) {
    var out = {}, min = dayKey(Date.now() - (days - 1) * 864e5);
    Object.keys(S.daily).forEach(function (k) {
      if (k < min) return;   // zero-padded YYYY-MM-DD sorts lexicographically
      var d = S.daily[k];
      if (!d) return;
      Object.keys(d.gain || {}).forEach(function (c) { out[c] = (out[c] || 0) + d.gain[c]; });
    });
    return out;
  }

  // Rate per hour from the raw samples, over the requested window.
  function rateOver(hours) {
    if (S.series.length < 2) return null;
    var now = S.series[S.series.length - 1];
    var target = now.t - hours * 3.6e6, base = S.series[0];
    for (var i = S.series.length - 1; i >= 0; i--) { if (S.series[i].t <= target) { base = S.series[i]; break; } }
    var elapsed = (now.t - base.t) / 3.6e6;
    if (elapsed <= 0) return null;
    var out = { hours: elapsed, per: {} };
    Object.keys(now.c).forEach(function (k) {
      if (!(k in base.c)) return;
      var d = now.c[k] - base.c[k];
      if (d !== 0) out.per[k] = d / elapsed;
    });
    return out;
  }

  function recordingSpan() {
    if (!S.series.length) return 0;
    return (S.series[S.series.length - 1].t - S.series[0].t) / 3.6e6;
  }

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
      var key = String(name).toLowerCase();
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
    var k = String(name).toLowerCase();
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
    S.marketCandidates = []; S.marketStoreKey = null;
    if (!state) return null;
    var best = null, bestN = 0, bestKey = null;
    walk(state, function (k, v) {
      if (!/market|order|exchange|trade|auction|listing|price/i.test(k)) return;
      if (!v || typeof v !== 'object') return;
      var books;
      try { books = buildBooks(v); } catch (e) { return; }
      var priced = Object.keys(books).filter(function (n) { return books[n].bid !== null || books[n].ask !== null; });
      if (!priced.length) return;
      if (S.marketCandidates.length < 12) S.marketCandidates.push(k + ': ' + priced.length + ' priced (' + priced.slice(0, 4).join(', ') + ')');
      if (priced.length > bestN) { bestN = priced.length; best = books; bestKey = k; }
    }, 7);
    if (bestN < 2) return null;
    S.marketStoreKey = bestKey;
    return best;
  }

  /* ============================================================
     7. MODEL
     ============================================================ */

  // One action per minute. Each droid survives with probability pSurv and a
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
      out.rare += succ * pRare * kR * f;
    });
    out.survival = droids.length ? survSum / droids.length : 0;
    return out;
  }

  /* ============================================================
     8. STATE + API BUDGET
     ============================================================ */

  var S = {
    key: store.get('key', ''),
    inputs: Object.assign({}, DEFAULT_INPUTS, store.get('inputs', {})),
    model: Object.assign({}, DEFAULT_MODEL, store.get('model', {})),
    budget: store.get('budget', { used: {}, nextReset: 0 }),
    marketCache: store.get('marketCache', null),   // {t, data}
    books: {}, marketSource: null, marketStamp: null,
    storeState: null, storeOk: false, storeIds: [],
    droids: null, bonusScan: null,
    apiUser: null, apiHost: store.get('apiHost', null),
    lastStoreRead: null, lastErr: null, busy: false, headerInfo: null,
    authFail: false, marketCandidates: [], marketStoreKey: null,
    keySource: store.get('keySource', 'manual'),
    quotaSyncedAt: store.get('quotaSyncedAt', 0), syncing: false,
    credits: null, droidPrice: store.get('droidPrice', null),
    acts: store.get('acts', []),
    seen0: store.get('seen0', {}),     // first value seen for each counter
    movers: store.get('movers', {}),   // counters that have changed at least once
    lastErrAt: 0,
    battles: (function () { var a = store.get('battles', []); return Array.isArray(a) ? a.filter(function (r) { return r && (r.v === 2 || r.v === 3) && r.o && r.e && typeof r.o.p === 'number' && typeof r.e.p === 'number'; }).sort(function (x, y) { return x.t - y.t; }).slice(-AR_MAX_STORE) : []; })(),
    lastActKey: store.get('lastActKey', null),
    gather: null, sources: [],
    series: store.get('series', []),
    daily: store.get('daily', {}),
    curDay: store.get('curDay', null)
  };

  var spendErr = null, spendEditing = false;   // Spend box: last message, and whether it has focus

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
  function saveModel() { store.set('model', S.model); }

  function nextResetTime() {
    var now = new Date();
    var r = new Date(now.getFullYear(), now.getMonth(), now.getDate(), S.inputs.resetHour, 0, 0, 0);
    if (r.getTime() <= now.getTime()) r.setDate(r.getDate() + 1);
    return r.getTime();
  }

  function rollBudget() {
    if (!S.budget.nextReset || Date.now() >= S.budget.nextReset) {
      S.budget.used = {};
      S.budget.nextReset = nextResetTime();
      store.set('budget', S.budget);
    }
  }

  function limitOf() { return S.budget.limit || DAILY_LIMIT; }
  function used(tag) { rollBudget(); return S.budget.used[tag] || 0; }
  function remaining(tag) { return Math.max(0, limitOf() - used(tag)); }
  function spend(tag) { rollBudget(); S.budget.used[tag] = (S.budget.used[tag] || 0) + 1; store.set('budget', S.budget); }

  function spendable(tag) { return remaining(tag) - Math.max(0, S.inputs.reserve); }

  // Spread whatever is left evenly over the time until the quota resets,
  // never faster than once every 15 minutes.
  function marketInterval() {
    var left = spendable('market');
    if (left <= 0) return null;
    var until = S.budget.nextReset - Date.now();
    return Math.max(15 * 60000, until / left);
  }

  /* ---- reading the count in the background ----
     The game asks its server for the count over its own websocket: a small
     MessagePack map, deflated. The script sends the same question and reads
     the same answer, so nothing on screen changes and no API call is spent. */

  function buildReq(cls, method) {
    function t(x) { var a = [0xa0 | x.length]; for (var i = 0; i < x.length; i++) a.push(x.charCodeAt(i)); return a; }
    return new Uint8Array([0x83].concat(t('classname'), t(cls), t('method'), t(method), t('data'), [0x80]));
  }

  function pumpStream(stream, bytes) {
    var w = stream.writable.getWriter();
    w.write(bytes); w.close();
    return new Response(stream.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function inflateBytes(u) { return pumpStream(new DecompressionStream('deflate'), u); }
  function deflateBytes(u) { return pumpStream(new CompressionStream('deflate'), u); }

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

  // Asks the game's server one of its no-argument questions and resolves with
  // the value of the reply.
  function socketCall(cls, method) {
    return new Promise(function (resolve, reject) {
      var ws = findGameSocket();
      if (!ws || typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') { reject(new Error('no socket')); return; }
      var done = false, timer = null;
      function finish(fn, v) {
        if (done) return;
        done = true; clearTimeout(timer);
        try { ws.removeEventListener('message', onMsg); } catch (e) {}
        fn(v);
      }
      function onMsg(ev) {
        if (done) return;
        Promise.resolve(ev.data instanceof Blob ? ev.data.arrayBuffer() : ev.data).then(function (buf) {
          // The reply is small. Larger messages are other traffic, so skip them.
          if (done || !(buf instanceof ArrayBuffer) || buf.byteLength > 2000) return null;
          return inflateBytes(new Uint8Array(buf)).then(function (u) {
            var m = mpDecode(u);
            if (m && m.classname === cls && m.method === method && m.value !== undefined && m.value !== null) finish(resolve, m.value);
          });
        }).catch(function () {});
      }
      ws.addEventListener('message', onMsg);
      timer = setTimeout(function () { finish(reject, new Error('timeout')); }, 6000);
      deflateBytes(buildReq(cls, method)).then(function (z) { ws.send(z); }).catch(function (e) { finish(reject, e); });
    });
  }

  function socketQuota() { return socketCall('Player', 'getApiQuota'); }

  // {limit, resetsAt, endpoints:[{endpoint, used}]}  ->  what applyQuota wants
  function quotaFromSocket(v) {
    var usedMap = {}, n = 0;
    (v.endpoints || []).forEach(function (e) {
      if (e && typeof e.endpoint === 'string' && typeof e.used === 'number') { usedMap[e.endpoint.toLowerCase()] = e.used; n++; }
    });
    if (!n) throw new Error('empty quota reply');
    var r = typeof v.resetsAt === 'number' ? (v.resetsAt < 1e12 ? v.resetsAt * 1000 : v.resetsAt) : null;
    return { used: usedMap, limit: typeof v.limit === 'number' ? v.limit : null, reset: r };
  }

  /* ---- fallback: reading the Profile page ----
     The Profile page, tab "Game API", shows the same numbers as text. Used
     only when the socket read above is not possible. */

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

  // True when the count comes from the game and no reset has passed since.
  function quotaExact() { return !!S.quotaSyncedAt && S.quotaSyncedAt > (S.budget.nextReset || 0) - 86400000; }

  function clickGameApiTab() {
    var tabs = document.querySelectorAll('main [role=tab], main .q-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (/^Game API/i.test((tabs[i].innerText || '').trim())) { tabs[i].click(); return true; }
    }
    return false;
  }

  // Fallback. Opens Profile > Game API, reads the counts, and goes back to the
  // page the player was on. Resolves true when the counts were read.
  function pageQuota() {
    var app = findVueApp(), router = null, cur = '/';
    try { router = app.config.globalProperties.$router; cur = router.currentRoute.value.fullPath || '/'; } catch (e) {}
    if (!router) return Promise.resolve(false);
    var onProfile = cur.indexOf('/profile') === 0;

    function later(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function poll(left, clicked) {
      if (readQuotaFromPage()) return Promise.resolve(true);
      if (left <= 0) return Promise.resolve(false);
      var did = clicked || clickGameApiTab();
      return later(300).then(function () { return poll(left - 1, did); });
    }

    return Promise.resolve(onProfile ? null : router.push('/profile')).catch(function () {})
      .then(function () { return later(500); })
      .then(function () { return poll(30, false); })
      .then(function (ok) {
        return Promise.resolve(onProfile ? null : router.push(cur)).catch(function () {}).then(function () { return ok; });
      });
  }

  // Read the real count. Background first (no page change); the Profile page
  // only when the person pressed sync and the background read failed.
  function syncQuota(manual) {
    if (S.syncing) return Promise.resolve();
    S.syncing = true;
    if (manual) render(); else renderQuota();
    return socketQuota().then(function (v) { applyQuota(quotaFromSocket(v)); return true; })
      .catch(function () { return manual ? pageQuota() : false; })
      .then(function (ok) {
        if (manual) setErr(ok ? null : 'Could not read the API count from the game.');
        S.syncing = false;
        // A quiet refresh must not rebuild a tab the person may be typing in.
        if (manual || tab === 'out' || tab === 'gear' || tab === 'battle' || tab === 'base') render(); else renderQuota();
      });
  }

  /* ============================================================
     9. NETWORK  (only ever called for the market, or as a fallback)
     ============================================================ */

  function parseRateHeaders(raw) {
    if (!raw) return null;
    var out = {};
    String(raw).split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^([^:]+):\s*(.*)$/);
      if (!m) return;
      var k = m[1].toLowerCase().trim();
      if (/ratelimit|rate-limit|quota|x-usage/.test(k)) out[k] = m[2].trim();
    });
    return Object.keys(out).length ? out : null;
  }

  function httpGet(url, key) {
    return new Promise(function (resolve, reject) {
      var headers = { 'Accept': 'application/json' };
      if (key) headers['sodyssey-api-key'] = key;
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
      fetch(url, { headers: headers, credentials: 'include', signal: ctl.signal })
        .then(function (r) { return r.text().then(function (x) { clearTimeout(t); resolve({ status: r.status, text: x, headers: null }); }); })
        .catch(function (e) { clearTimeout(t); reject(e); });
    });
  }

  // One call = one quota unit, so the known-good host is remembered and
  // tried alone. A blind fallback across both hosts would cost two.
  //
  // Each step uses then(onOk, onErr) rather than .then().catch(). With the
  // two-argument form, onErr only sees a rejection from THIS httpGet. With
  // .catch() it also caught the rejection of the recursive call inside onOk,
  // which re-entered the retry and fanned one refresh out into a dozen live
  // requests, each one spending quota.
  function apiGet(path, tag) {
    rollBudget();
    if (S.authFail) return Promise.reject(new Error('the API rejected this key (403). Fix it in Inputs, then retry.'));
    if (!S.key) return Promise.reject(new Error('no API key set. Open Inputs and paste your key.'));
    if (remaining(tag) <= 0) return Promise.reject(new Error('daily quota for /' + tag + ' is used up'));

    var order = S.apiHost ? [S.apiHost].concat(HOSTS.filter(function (h) { return h !== S.apiHost; })) : HOSTS.slice();
    var errs = [], i = 0;

    function step() {
      if (i >= order.length) return Promise.reject(new Error(errs.join(' | ')));
      if (remaining(tag) <= 0) return Promise.reject(new Error('quota exhausted'));
      var host = order[i++], short = host.replace(/^https:\/\//, '');

      return httpGet(host + path, S.key).then(function (r) {
        if (r.headers) S.headerInfo = r.headers;

        // 401/403 is the key being refused, not the host being wrong. The
        // other host answers identically, so stop rather than spend again.
        if (r.status === 401 || r.status === 403) {
          S.authFail = true;
          throw new Error('HTTP ' + r.status + ', the API refused the key. Stopped without retrying.');
        }
        if (r.status === 429) { spend(tag); throw new Error('rate limited by the server (429)'); }
        if (r.status !== 200) { spend(tag); errs.push(short + ' HTTP ' + r.status); return step(); }

        var data;
        try { data = JSON.parse(r.text); }
        catch (e) { spend(tag); errs.push(short + ' non-JSON body'); return step(); }

        spend(tag);
        S.apiHost = host; store.set('apiHost', S.apiHost);
        return data;
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

  // Runs one stage of a tick. A failure is recorded and the tick goes on:
  // before 3.7.3 a single throwing property stopped the script for good.
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
    S.storeState = st; S.storeOk = true; S.storeIds = st.__storeIds || [];
    S.lastStoreRead = Date.now();
    stage('reading the game state', function () { ingest(st); });
    stage('recording counters', function () { recordSample(st); });
    // The market scan is a search of the whole state, and the game's market
    // only fills in when its screen is opened, so once a minute is plenty.
    if (Date.now() - lastMarketScan >= 60000) {
      lastMarketScan = Date.now();
      stage('reading prices', function () {
        var mb = marketFromStore(st);
        if (!mb || !Object.keys(mb).length) return;
        var sig = bookSig(mb);
        S.books = mb; S.marketSource = 'page store';
        if (sig !== marketSig || !S.marketStamp) { marketSig = sig; S.marketStamp = Date.now(); }
      });
    }
    return true;
  }

  function ingest(root) {
    // Pick up the key from the game itself, unless one was typed in.
    if (!S.key || S.keySource === 'auto') {
      var k = readApiKey(root);
      if (k && k !== S.key) {
        S.key = k; S.keySource = 'auto'; S.authFail = false;
        store.set('key', S.key);
        scheduleMarket();
      }
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
    var src = resourceSources(root);
    if (src.length) S.sources = src;

    // Overwrite the totals whenever the equipped-gear scan was possible,
    // even if it matched nothing. Otherwise an old inflated value saved by
    // a previous version would never be corrected.
    var scan = scanBonuses(root);
    if (scan.matched.length || scan.authoritative) {
      S.bonusScan = scan;
      Object.keys(scan.totals).forEach(function (k) { S.inputs[k] = scan.totals[k]; });
    }

    saveInputs();
  }

  function refreshMarket(force) {
    if (S.busy) return Promise.resolve();
    rollBudget();
    if (!force && spendable('market') <= 0) { setErr('market budget spent (reserve held back)'); render(); return Promise.resolve(); }
    if (remaining('market') <= 0) { setErr('no market calls left today'); render(); return Promise.resolve(); }
    S.busy = true; setErr(null); render();
    return apiGet(PATHS.market, 'market').then(function (data) {
      S.books = buildBooks(data);
      S.marketSource = 'api (' + (S.apiHost || '').replace(/^https:\/\//, '') + ')';
      S.marketStamp = Date.now();
      S.marketCache = { t: Date.now(), data: data };
      store.set('marketCache', S.marketCache);
      lastQuotaTry = Date.now(); syncQuota(false);   // keep the count exact after each call
    }).catch(function (e) { setErr(e.message || String(e)); })
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

  function projection() {
    var droids = effectiveDroids();
    var emp = empirical();
    var sim = simulate(droids, S.model, ctxOf(), emp);
    var node = NODES[S.inputs.node] || NODES.crystal;
    var share = sim.common / node.commons.length;
    var rows = node.commons.map(function (n) { return { name: n, qty: share }; });
    rows.push({ name: node.rare, qty: sim.rare });
    return { sim: sim, node: node, rows: rows, emp: emp, exact: S.inputs.autofill && !!(S.droids && S.droids.length) };
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
      U: (1 - sim.rareChance) * sim.kCommon * px.vC + sim.rareChance * sim.kRare * px.vR,   // credits per surviving droid, per unit of (1 + eff + sto)
      avgMan: mean('man'), avgEff: mean('eff'), avgSto: mean('sto'), avgSurv: sim.survival,
      slope: S.model.manToDodge / 100
    };
  }

  // Spend credits one 0.1 step at a time, always on the droid stat with the
  // fastest payback. Prices only rise, so this order is the best split.
  function upgradePlan(cx) {
    var att = cx.att, U = cx.U;
    var cap = Math.max(1, S.inputs.maxPaybackDays) * 24;
    var avail = Math.max(0, (S.credits || 0) - Math.max(0, S.inputs.keepCredits)), lim = S.inputs.spendLimit > 0 ? S.inputs.spendLimit : 0;
    var budget = lim ? Math.min(avail, lim) : avail;
    var st = cx.ds.map(function (d) {
      return { d: d, t: [Math.round(d.eff * 10), Math.round(d.sto * 10), Math.round(d.man * 10)],
               t0: [Math.round(d.eff * 10), Math.round(d.sto * 10), Math.round(d.man * 10)], cost: 0, c: [] };
    });
    function surv(x) { return clamp(0, 1, cx.avgSurv + (x.t[2] / 10 - cx.avgMan) * cx.slope); }
    function income(x) { return att * surv(x) * U * (1 + (x.t[0] + x.t[1]) / 1000); }
    function gain(x, j) {
      if (j < 2) return att * surv(x) * U * 0.001;
      if (surv(x) >= 1) return 0;
      return att * cx.slope * 0.1 * U * (1 + (x.t[0] + x.t[1]) / 1000);
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

  // The next droid: its price comes from the game. A new droid is assumed to
  // start at 0% and to be levelled to the average of the current ones.
  function droidOption(cx) {
    var dp = S.droidPrice;
    if (!dp || !(dp.v > 0)) return null;
    function level(target) { var c = 0; for (var t = 0; t < Math.round(target * 10); t++) c += stepCost(t); return c; }
    var lv = level(cx.avgEff) + level(cx.avgSto) + level(cx.avgMan);
    var gain = cx.att * clamp(0, 1, cx.avgSurv) * cx.U * (1 + (cx.avgEff + cx.avgSto) / 100);
    var cost = dp.v + lv;
    return { n: (S.droids ? S.droids.length : 0) + 1, price: dp.v, level: lv, cost: cost, gain: gain, payback: gain > 0 ? cost / gain : null };
  }

  function refreshDroidPrice() {
    return socketCall('Gathering', 'getNextDroidPrice').then(function (v) {
      var n = numOr(v);
      if (n !== null && n > 0) {
        S.droidPrice = { v: n, t: Date.now(), n: S.droids ? S.droids.length : 0 };
        store.set('droidPrice', S.droidPrice);
      }
    }).catch(function () {});
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
     Squadron fights are relays, see 12e. The stat points and gear here are the
     parts of a build that can be changed.
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
      var vel = 0;
      try {
        var pets = root.PetsStore, v = null;
        (pets.pets || []).forEach(function (p) { if (p && p.name === 'Velari') v = p; });
        if (v && (pets.petSlots || []).some(function (s) { return s && s.pet === v._id; })) vel = (numOr(v.level) || 0) * 50;
      } catch (e) {}
      var mats = {};
      try {
        (root.MaterialsStore.materialsList || []).forEach(function (m) {
          if (m && typeof m.item === 'string') mats[m.item.toLowerCase()] = numOr(m.quantity) || 0;
        });
      } catch (e) {}
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

  function pvRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
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

  var AR_MAX = 200;   // a duel is about 290 bytes, so keeping a lot costs nothing

  function arOwner(name) { var m = /^(.*)'s Clone \d+$/.exec(String(name || '')); return m ? m[1] : null; }
  function arIndex(name) { var m = /^.*'s Clone (\d+)$/.exec(String(name || '')); return m ? +m[1] : 0; }
  function arHp(s) { var m = /(-?\d+)\s*\/\s*(\d+)/.exec(String(s || '')); return m ? { hp: +m[1], max: +m[2] } : null; }

  function arRound1(x) { return Math.round(x * 10) / 10; }

  // The value that comes up most often is the plain hit; the bigger ones
  // are crits. Values are whole numbers, so counting them is enough.
  function arDamage(vals) {
    if (!vals.length) return { base: 0, crit: 0, cm: 1.3 };
    var count = {}, best = 0, base = 0;
    vals.forEach(function (v) { var k = Math.round(v); count[k] = (count[k] || 0) + 1; if (count[k] > best) { best = count[k]; base = k; } });
    var hi = vals.filter(function (v) { return v > base * 1.02; });
    var sum = 0; hi.forEach(function (v) { sum += v; });
    return { base: base, crit: arRound1(hi.length / vals.length * 100), cm: hi.length ? arRound1(sum / hi.length / base * 100) / 100 : 1.3 };
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
          if (e.action === 'attacks') { A.hit++; var v = numOr(e.value); if (v !== null && v > 0) A.dmg.push(v); }
          else if (e.action === 'attack blocked') { A.hit++; get(dO || ao).blocked++; }
          else A.miss++;
          // two swings from the same clone in the same round is a dual shot
          var key = e.round + '|' + e.attacker;
          if (A.seen[key]) A.dual++; else A.seen[key] = 1;
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
      function fighter(s, other, dmg, p, e) {
        return { n: s.n, d: dmg.base, h: s.max, p: p, e: e,
          s: skills(s, other), c: [[dmg.crit, arRound1((dmg.cm - 1) * 100 - 30), arRound1(s.dual / Math.max(1, s.att) * 100)]],
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

  // Duels recorded before 3.10.0 kept no swing counts. Rather than throw
  // that history away, they are read as if they came from this many
  // swings: a short duel, so they carry more doubt than a long one, which
  // is the safe direction to be wrong in.
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
     12e. DUEL SIMULATOR

     The arena is one fighter against one fighter, so this is a one
     against one engine. (Up to 3.10.1 it was a general relay engine left
     over from squadron fights: a line of fighters a side, the next
     stepping in when one died, and a damage penalty for a fighter that
     had already won. None of that can happen in a duel, so every hit was
     paying for machinery that never ran. Removing it made the simulator
     1.6x faster and changed no outcome - 12,000 battles across three
     matchups agreed on winner, rounds and both health fractions exactly.)

     Rules, read from real battle logs:
       - Each side is one fighter with N clones. All of one side's clones
         act, then the other's; the defending side goes first each round.
       - A clone hits with precision / (precision + evasion), aims at a
         random living clone (or at the one Focus marked), and does its
         fighter's damage, times the crit factor on a crit. Dual shot is a
         second attack. Block cancels a hit. Stun makes the target skip
         its next attack. DoT does 50% at once and on the next two hits.
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
  function rlPhase(a, d, rnd) {
    var S = a.S, T = d.S, n = a.alive ? S.N : 0, i, s, shots, cl, t, k, pick, dmg, base;
    for (i = 0; i < n; i++) {
      if (d.alive <= 0) return;
      if (a.hp[i] <= 0) continue;
      if (a.st[i]) { a.st[i] = 0; continue; }
      cl = S.cl[i % S.cl.length];
      shots = rnd() < cl.dual ? 2 : 1;
      for (s = 0; s < shots && d.alive > 0; s++) {
        if (d.mark >= 0 && d.hp[d.mark] > 0) t = d.mark;
        else {
          pick = Math.floor(rnd() * d.alive); t = -1;
          for (k = 0; k < T.N; k++) if (d.hp[k] > 0) { if (pick === 0) { t = k; break; } pick--; }
        }
        if (rnd() >= S.prec / (S.prec + T.eva)) continue;
        if (T.sk.block > 0 && rnd() < T.sk.block) continue;
        base = S.dmg;
        dmg = base * (rnd() < cl.crit ? cl.cm : 1);
        if (d.ch[t] > 0) { d.ch[t]--; dmg += base * 0.5; }
        d.hp[t] -= dmg;
        if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; }
        else {
          if (S.sk.dot > 0 && rnd() < S.sk.dot) {
            d.ch[t] = 2; d.hp[t] -= base * 0.5;
            if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; }
          }
          if (d.hp[t] > 0) {
            if (S.sk.stun > 0 && !d.st[t] && rnd() < S.sk.stun) d.st[t] = 1;
            if (S.sk.focus > 0 && d.mark < 0 && rnd() < S.sk.focus) d.mark = t;
          }
        }
      }
    }
  }

  function rlLeft(f) {
    if (f.alive <= 0) return 0;
    var s = 0, i;
    for (i = 0; i < f.S.N; i++) if (f.hp[i] > 0) s += f.hp[i];
    return s / (f.S.N * f.S.hp);
  }

  // A against B. aFirst: A strikes first each round (A is defending).
  function rlDuel(SA, SB, aFirst, rnd) {
    var A = RL_A, B = RL_B, first, second, r;
    rlLoad(A, SA); rlLoad(B, SB);
    first = aFirst ? A : B; second = aFirst ? B : A;
    for (r = 1; r <= RL_MAX_ROUNDS && A.alive > 0 && B.alive > 0; r++) {
      rlPhase(first, second, rnd);
      if (second.alive <= 0) break;
      rlPhase(second, first, rnd);
    }
    var la = rlLeft(A), lb = rlLeft(B);
    return { win: B.alive <= 0 ? 1 : (A.alive <= 0 ? 0 : (la >= lb ? 1 : 0)),
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

     The yardstick is a gauntlet: one of your fighters meets a line of four
     enemies drawn from the recorded battles, one after the other, and keeps
     what is left of its clones between duels, as in a real squadron fight.
     The score is the share of that line it takes down (100 = all four).
     The same random numbers are used for every build compared, so the
     difference between two builds is much steadier than either score.

     The best build is looked for in two steps: the split of stat points and
     the active stat of each piece come from a quick formula (damage x health
     x hit ratio against the average recorded enemy), and the skills are then
     chosen by running the gauntlet. It is only offered when it beats the
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

  function pvPoolRef(pool) {
    var p = 0, e = 0, n = 0;
    pool.forEach(function (draws) { draws.forEach(function (s) { p += s.prec; e += s.eva; n++; }); });
    return { precision: p / (n || 1), evasion: e / (n || 1) };
  }

  function pvPlanKey(pv, keepBadges, recs) {
    return JSON.stringify([pv.pts, pv.pool, pv.gear, pv.craft, pv.vel, pv.N, pv.clones, pv.mats, pv.badges, keepBadges, recs.map(arKey)]);
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
        var rnd = pvRng(PV_SEED + k * 104729 + i * 7919);
        var r = rlDuel(me, draws[i % draws.length], i % 2 === 0, rnd);
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

  // Runs the plan in small pieces so the game page never stalls; done(plan)
  // is called at the end. Everything is drawn from the recorded enemies.
  // Searching is ranking, not measuring: it needs enough opponents to tell
  // builds apart, not all of them. The reported win rate, error bar and gain
  // are still taken over every opponent on record - only the search runs on
  // a sample. Without this the planner's cost grew with the duel count, and
  // at 200 duels a single slice took most of a second and froze the page.
  var PV_SEARCH_MAX = 40;
  var PV_SLICE_MS = 35;   // how long one slice may spend before yielding
  var PV_TAIL = 1;        // steps that must stay at the end of the list

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
    var pool = pvPool(recs), ref = pvPoolRef(pool);
    var plan = { pool: pool.length, ref: ref, floor: PV_FLOOR, thin: pool.length < PV_FLOOR };
    var live = pool;                       // a sample of the fights a build change could swing: what the search runs on
    var liveAll = pool;                    // all of them: what the few finalists are settled on
    var cand = null, comps = null, quick = null, short = null;
    var steps = [
      function () {
        plan.cur = pvScoreOf(pv, pool);
        plan.need = pvNeedFor(plan.cur.se, pool.length, 5);
        // A fight you always win, or always lose, says nothing about which
        // build is better: every build gets the same result. Tuning is done
        // on the ones that could go either way.
        var idx = [];
        plan.cur.per.forEach(function (w, i) { if (w > PV_DECIDED && w < 1 - PV_DECIDED) idx.push(i); });
        plan.contested = idx.length;
        plan.decided = pool.length - idx.length;
        liveAll = idx.map(function (i) { return pool[i]; });
        live = pvSample(liveAll, PV_SEARCH_MAX);
        plan.searched = live.length;
        if (plan.thin || idx.length < PV_CONTESTED) { plan.stop = 1; done(plan); }
      },
      function () { cand = pvBestAssign(pv, ref); },
      function () {   // every set of skills, quickly, as many per slice as fit the budget
        comps = pvCompositions(cand.gear.length);
        quick = [];
        var at = 0;
        function chunk() {
          var t0 = Date.now();
          while (at < comps.length) {
            var comp = comps[at++];
            var c = pvCopy(cand); comp.forEach(function (sk, i) { c.gear[i].skill = sk; });
            quick.push({ comp: comp, key: comp.slice().sort().join(), m: pvScoreOf(c, live, 120).score });
            if (Date.now() - t0 >= PV_SLICE_MS) break;
          }
          if (at < comps.length) runNext([chunk]);
        }
        runNext([chunk]);
      },
      function () {   // pick the best few, then score each of them on its own slice
        quick.sort(function (x, y) { return y.m - x.m; });
        var curKey = cand.gear.map(function (g) { return g.skill; }).sort().join();
        short = quick.slice(0, 5);
        if (!short.some(function (x) { return x.key === curKey; })) short.push(quick.filter(function (x) { return x.key === curKey; })[0] || quick[0]);
        runNext(short.map(function (x) {
          return function () {
            var c = pvCopy(cand); x.comp.forEach(function (s, i) { c.gear[i].skill = s; });
            // The finalists are close together, which is exactly when a small
            // sample misleads, and there are only six of them: settle it on
            // every contested opponent.
            x.m = pvScoreOf(c, liveAll, 600).score;
          };
        }));
      },
      function () {   // the winner, with the current skills kept when it is a tie
        var curKey = cand.gear.map(function (g) { return g.skill; }).sort().join();
        short.sort(function (x, y) { return y.m - x.m; });
        var cur = short.filter(function (x) { return x.key === curKey; })[0];
        var pick = cur && cur.m >= short[0].m - 0.8 ? cur : short[0];   // inside the noise: keep what is there
        var left = pick.comp.slice(), out = new Array(cand.gear.length);
        cand.gear.forEach(function (g, i) { var j = left.indexOf(g.skill); if (j >= 0) { out[i] = g.skill; left.splice(j, 1); } });
        for (var i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = left.shift();
        cand.gear.forEach(function (g, i) { g.skill = out[i]; });
      },
      function () {
        var s = pvScoreOf(cand, pool), g = pvGap(plan.cur, s);
        plan.free = { build: cand, totals: pvTotals(cand), score: s.score, win: s.win,
          gain: g.gain, se: g.se, sure: g.gain > 2 * g.se };
      },
      function () { plan.next = []; plan.base8 = pvScoreOf(pv, live, 800).score; },
      function () {   // what the materials and badges in hand buy right now
        var sp = pvSpend(pv, keepBadges);
        plan.buy = { steps: sp.steps };
        if (!sp.steps.length) return;
        var b2 = pvCopy(pv); b2.gear = sp.gear;
        runNext([function () {   // scoring it is a slice of its own, so neither runs long
          var s = pvScoreOf(b2, pool), g = pvGap(plan.cur, s);
          plan.buy.score = s.score; plan.buy.gain = g.gain; plan.buy.se = g.se; plan.buy.build = b2;
        }]);
      }
    ];
    pv.gear.forEach(function (g, k) {   // one slice per piece and kind
      ['level', 'tier'].forEach(function (kind) {
        steps.splice(steps.length - PV_TAIL, 0, function () {
          plan.next = plan.next.concat(pvUpgradeRows(pv, live, plan.base8, k, kind));
        });
      });
    });
    var i = 0;
    // A step can ask for more steps: they run next, in order, before
    // whatever was already queued behind it.
    function runNext(list) {
      if (list && list.length) Array.prototype.splice.apply(steps, [i, 0].concat(list));
    }
    (function next() {
      if (plan.stop) return;                       // a step decided there is nothing to work out
      if (i >= steps.length) { done(plan); return; }
      var f = steps[i++];
      try { f(); } catch (e) { done(null, e); return; }
      setTimeout(next, 10);
    })();
  }

  // Does the simulator see the real battles the way they went? Each recorded
  // battle is replayed with its recorded fighters.
  function pvReplay(rec, sims) {
    var A = arSide(rec.o), B = arSide(rec.e), w = 0, rounds = 0;
    for (var i = 0; i < sims; i++) {
      var r = rlDuel(A, B, rec.f === 1, pvRng(1000 + i * 7919));
      w += r.win === rec.w ? 1 : 0; rounds += r.rounds;
    }
    return { p: w / sims, rounds: rounds / sims };
  }

  /* ============================================================
     12g. BASE AND LABORATORY

     Everything here was read out of the game's own code and then checked
     against what the game displays. The pieces:

       boost            level * (1 + tier/100) * (1 + efficiency/100),
                        where the Quantum server and the Laboratory
                        enhancer count their level at half, and efficiency
                        is the base_module_efficiency_boost skill.
                        This is the "Boost:" number on each module card.
       module output    base rate * (1 + whole hundreds of boost), plus a
                        chance of one more equal to the leftover percent.
                        So the AVERAGE is base * (1 + boost/100), smooth,
                        while the number the game prints is the guaranteed
                        part alone.
       lab multiplier   every laboratory craft yields
                        2 + whole hundreds of the Laboratory enhancer's
                        boost. At boost 387 that is 5, which matches the
                        five per craft in the live queue.
       lab timer        max(5, base seconds - level/10), base 30 s for the
                        buildings and 45 s for the four forges. Checked
                        against four running jobs to the decimal.
       lab upgrade      1,000,000 * 1.15 * (triangle(to) - triangle(from))
                        CREDITS, not materials.
       module level     (level+1) of the module's material, doubling at
                        600, 1000, 1500, 1750 and 64x above 2000.
       module tier      tier N costs N stellarium, doubling from 100.
     ============================================================ */

  var BB_HALF = { 'Quantum server': 1, 'Laboratory enhancer': 1 };
  var BB_RATE = {
    'Material generator': 200, 'Metal scrap generator': 1500,
    'Resource miner': 20000, 'Fuel facility': 5, 'Quantum server': 4,
    'Stellarium miner': 1
  };
  var BB_ENHANCER = 'Laboratory enhancer';
  var BB_LAB_T = 30, BB_FORGE_T = 45, BB_MIN_T = 5;
  var BB_CREDIT_BASE = 1e6, BB_CREDIT_MULT = 1.15;

  function bbTri(n) { return n * (n + 1) / 2; }
  function bbEffLevel(m) { return BB_HALF[m.name] ? m.level / 2 : m.level; }
  function bbBoost(m, eff) { return bbEffLevel(m) * (1 + (m.tier || 0) / 100) * (1 + eff / 100); }
  function bbWhole(boost) { return Math.floor(boost / 100); }

  // Average output an hour. The leftover percent is a chance of one more
  // unit, so on average it is exactly linear in the boost.
  function bbAvgOut(m, eff) { return (BB_RATE[m.name] || 0) * (1 + bbBoost(m, eff) / 100); }

  function bbLabMult(enh, eff) { return enh ? 2 + bbWhole(bbBoost(enh, eff)) : 1; }

  function bbTimer(level, baseT) { return Math.max(BB_MIN_T, baseT - level / 10); }
  function bbLabRate(level, baseT, mult) { return 3600 / bbTimer(level, baseT) * mult; }

  function bbLabCost(from, to) { return BB_CREDIT_BASE * BB_CREDIT_MULT * (bbTri(to) - bbTri(from)); }

  // The game's own answer to "how many levels can I buy with this much".
  function bbLabAfford(level, credits) {
    if (!(credits > 0)) return 0;
    var q = 1 + 4 * (level * (level + 1) + 2 * credits / (BB_CREDIT_BASE * BB_CREDIT_MULT));
    return Math.max(0, Math.floor((-1 + Math.sqrt(q)) / 2) - level);
  }

  function bbTierCost(n) { return n * (n >= 100 ? Math.pow(2, Math.floor((n - 100) / 50) + 1) : 1); }
  function bbTierCum(from, to) { var s = 0; for (var i = from + 1; i <= to; i++) s += bbTierCost(i); return s; }

  // Cumulative material cost of a module's levels, with the game's bands.
  function bbLevelCum(L) {
    var t = bbTri, n = 1000, r = 1500, i = 1750, a = 2000;
    if (L <= 600) return t(L);
    if (L <= n) return t(600) + (t(L) - t(600)) * 2;
    if (L <= r) return t(600) + (t(n) - t(600)) * 2 + (t(L) - t(n)) * 4;
    if (L <= i) return t(600) + (t(n) - t(600)) * 2 + (t(r) - t(n)) * 4 + (t(L) - t(r)) * 8;
    if (L <= a) return t(600) + (t(n) - t(600)) * 2 + (t(r) - t(n)) * 4 + (t(i) - t(r)) * 8 + (t(L) - t(i)) * 16;
    return t(600) + (t(n) - t(600)) * 2 + (t(r) - t(n)) * 4 + (t(i) - t(r)) * 8 + (t(a) - t(i)) * 16 + (t(L) - t(a)) * 64;
  }

  function bbCap(s) { s = String(s || '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); }

  // Everything the tab needs, or null when the base is not readable.
  function readBase(root) {
    try {
      var bb = root.BaseBuildingStore && root.BaseBuildingStore.base;
      var lab = root.LaboratoryStore;
      if (!bb || !Array.isArray(bb.modules) || !lab) return null;
      var eff = 0;
      try { eff = numOr(root.UserStore.player.skills.base_module_efficiency_boost) || 0; } catch (e) {}
      var credits = 0;
      try { credits = numOr(root.CurrencyStore.credits) || 0; } catch (e) {}
      var mats = {};
      try {
        (root.MaterialsStore.materialsList || []).forEach(function (m) {
          if (m && m.item && typeof m.item.name === 'string') mats[m.item.name.toLowerCase()] = numOr(m.quantity) || 0;
        });
      } catch (e) {}

      var mods = bb.modules.map(function (m) {
        return { name: String(m.name), level: numOr(m.level) || 0, tier: numOr(m.tier) || 0,
          on: m.active !== false && m.unlocked !== false, uses: m.uses || [], sel: (m.selection || [])[0] || '' };
      });
      var enh = null;
      mods.forEach(function (m) { if (m.name === BB_ENHANCER) enh = m; });
      var mult = bbLabMult(enh, eff);

      function labRow(b, baseT) {
        var lv = numOr(b.level) || 0;
        return { name: String(b.building), level: lv, baseT: baseT, timer: bbTimer(lv, baseT),
          rate: bbLabRate(lv, baseT, mult), makes: (b.produce || [])[0] || '', id: b._id };
      }
      var running = {};
      (lab.labQueue || []).forEach(function (q) { if (q && q.building) running[q.building] = 1; });

      var labs = (lab.buildings || []).map(function (b) { return labRow(b, BB_LAB_T); })
        .concat((lab.base || []).map(function (b) { return labRow(b, BB_FORGE_T); }));

      return { name: bb.name, stellarium: numOr(bb.stellarium) || 0, drop: numOr(bb.stellariumHourly) || 0,
        nextDrop: numOr(bb.nextStellariumTick) || 0, eff: eff, credits: credits, mats: mats,
        modules: mods, enh: enh, mult: mult, labs: labs, running: running };
    } catch (e) { return null; }
  }

  // ---- what to do next -------------------------------------------------
  //
  // Ranking follows what you are actually running. A building sitting in
  // the laboratory queue counts; one you have never touched does not, or
  // every idle building at level zero would look like a bargain.
  // `pct` is the gain on that thing's own output, `score` is what the
  // order is built from: the gain summed over everything it touches.

  function bbCandidates(B) {
    var out = [], running = B.running || {};
    var live = B.labs.filter(function (L) { return running[L.id]; });
    var nLive = live.length || B.labs.filter(function (L) { return L.level > 0; }).length || 1;

    // 1. the Laboratory enhancer: one step lifts every craft in the lab
    if (B.enh) {
      var boost = bbBoost(B.enh, B.eff), need = (bbWhole(boost) + 1) * 100;
      var pct = 1 / (B.mult || 1);
      var note = 'every lab craft ' + B.mult + ' \u2192 ' + (B.mult + 1) + ', on ' + nLive + ' running job' + (nLive === 1 ? '' : 's');
      var t = B.enh.tier;
      while (t < B.enh.tier + 400 && bbBoost({ name: B.enh.name, level: B.enh.level, tier: t }, B.eff) < need) t++;
      out.push({ what: BB_ENHANCER, how: 'tier ' + B.enh.tier + ' \u2192 ' + t, cost: bbTierCum(B.enh.tier, t),
        unit: 'stellarium', have: B.stellarium, pct: pct, score: pct * nLive, note: note });
      var lv = B.enh.level;
      while (lv < B.enh.level + 2000 && bbBoost({ name: B.enh.name, level: lv, tier: B.enh.tier }, B.eff) < need) lv++;
      var mat = (B.enh.uses || [])[0] || '';
      out.push({ what: BB_ENHANCER, how: 'level ' + B.enh.level + ' \u2192 ' + lv, cost: bbLevelCum(lv) - bbLevelCum(B.enh.level),
        unit: mat, have: B.mats[mat] || 0, pct: pct, score: pct * nLive, note: note, alt: 1 });
    }

    // 2. laboratory buildings, as far as the credits in hand reach
    B.labs.forEach(function (L) {
      if (L.timer <= BB_MIN_T) return;                       // already at the floor
      if (live.length && !running[L.id]) return;             // not something you run
      var room = Math.round((L.baseT - BB_MIN_T) * 10) - L.level;
      var can = Math.min(bbLabAfford(L.level, B.credits), room);
      if (can < 1) return;
      var to = L.level + can, r2 = bbLabRate(to, L.baseT, B.mult);
      out.push({ what: L.name, how: 'level ' + L.level + ' \u2192 ' + to, cost: bbLabCost(L.level, to),
        unit: 'credits', have: B.credits, pct: r2 / L.rate - 1, score: r2 / L.rate - 1, credits: 1,
        note: L.timer.toFixed(1) + 's \u2192 ' + bbTimer(to, L.baseT).toFixed(1) + 's, ' + bbCap(L.makes) + ' ' +
          fmt(L.rate, 0) + ' \u2192 ' + fmt(r2, 0) + ' an hour' });
      // and what the whole way to the floor would take
      if (can < room) {
        var full = L.level + room, rf = bbLabRate(full, L.baseT, B.mult);
        out.push({ what: L.name, how: 'level ' + L.level + ' \u2192 ' + full + ' (the 5s floor)', cost: bbLabCost(L.level, full),
          unit: 'credits', have: B.credits, pct: rf / L.rate - 1, score: rf / L.rate - 1, credits: 1, far: 1,
          note: L.timer.toFixed(1) + 's \u2192 5.0s, ' + bbCap(L.makes) + ' ' + fmt(L.rate, 0) + ' \u2192 ' + fmt(rf, 0) + ' an hour' });
      }
    });

    // 3. the producing base modules, to their next whole hundred
    B.modules.forEach(function (m) {
      if (!m.on || m.name === BB_ENHANCER || !BB_RATE[m.name] || !(bbEffLevel(m) > 0)) return;
      var boost = bbBoost(m, B.eff), need = (bbWhole(boost) + 1) * 100, t = m.tier;
      while (t < m.tier + 400 && bbBoost({ name: m.name, level: m.level, tier: t }, B.eff) < need) t++;
      var now = bbAvgOut(m, B.eff), after = bbAvgOut({ name: m.name, level: m.level, tier: t }, B.eff);
      if (!(now > 0)) return;
      out.push({ what: m.name, how: 'tier ' + m.tier + ' \u2192 ' + t, cost: bbTierCum(m.tier, t),
        unit: 'stellarium', have: B.stellarium, pct: after / now - 1, score: after / now - 1,
        note: bbCap(m.sel || m.makes || 'output') + ' ' + fmt(now, 0) + ' \u2192 ' + fmt(after, 0) + ' an hour' });
    });

    out.forEach(function (c) { c.afford = c.cost <= c.have; });
    out.sort(function (a, b) {
      if (a.afford !== b.afford) return a.afford ? -1 : 1;
      return b.score - a.score;
    });
    // Credits are one purse: only the first credit-funded row can be bought today.
    var spent = false;
    out.forEach(function (c) {
      if (!c.credits) return;
      if (spent && c.afford) { c.afford = false; c.shared = 1; }
      if (!spent && c.afford) spent = true;
    });
    return out;
  }

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
    '#btn.ok .dot{background:var(--good)}#btn.bad .dot{background:var(--bad)}#btn.busy .dot{background:var(--warn)}',

    '#panel{position:fixed;top:52px;left:10px;width:440px;max-height:86vh;display:flex;flex-direction:column;',
    'background:var(--bg);border:1px solid var(--bd);border-radius:12px;box-shadow:var(--sh);overflow:hidden}',
    '#bar{background:var(--card);padding:9px 12px;cursor:grab;display:flex;justify-content:space-between;align-items:center;',
    'user-select:none;border-bottom:1px solid var(--bd)}',
    '#bar b{font-size:13px;font-weight:700;letter-spacing:.2px}',
    '#bar .ttl{display:flex;align-items:center;gap:6px;min-width:0}',
    '#bar .beta{font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--warn);',
    'border:1px solid var(--warn);border-radius:4px;padding:0 4px;line-height:14px;opacity:.85}',
    '#bar .ctl{display:flex;gap:4px}',
    '#bar .g{cursor:pointer;color:var(--mu);padding:2px 8px;border-radius:6px;font-size:12px}',
    '#bar .g:hover{background:var(--tile);color:var(--tx)}',
    '#quota{padding:5px 12px;font-size:11px;color:var(--mu);display:flex;justify-content:space-between;background:var(--card);border-bottom:1px solid var(--bd)}',
    '#quota .warn{color:var(--warn)}',
    '#tabs{display:flex;padding:0 6px;background:var(--card);border-bottom:1px solid var(--bd)}',
    '#tabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--mu);padding:8px 9px;cursor:pointer;font:inherit;font-size:12px}',
    '#tabs button:hover{color:var(--tx)}',
    '#tabs button.on{color:var(--ac);border-bottom-color:var(--ac);font-weight:600}',
    '#body{overflow:auto;padding:12px}',

    '.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
    '.seg{display:flex;gap:6px;margin:2px 0 10px}',
    '.seg button{flex:1;padding:6px 0;border:1px solid var(--bd);background:var(--card);border-radius:8px;color:var(--mu);font:inherit;font-size:12px;cursor:pointer}',
    '.seg button.on{background:var(--tile,var(--card));color:var(--ac);border-color:var(--ac);font-weight:600}',
    '.sg{background:var(--card);border:1px solid var(--bd);border-left:3px solid var(--mu);border-radius:9px;padding:8px 10px;margin-top:8px}',
    '.sg.ok{border-left-color:var(--good)}',
    '.sgh{display:flex;align-items:baseline;gap:7px;font-size:12px;font-weight:600}',
    '.sgh b{color:var(--ac);font-size:13px}.sgh i{font-style:normal;font-weight:400;color:var(--mu);margin-left:auto}',
    '.sgn{font-size:11px;color:var(--tx);margin-top:3px}',
    '.sgc{font-size:11px;color:var(--mu);margin-top:2px}',
    '.tile{background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:8px 10px;min-width:0}',
    '.tl{color:var(--mu);font-size:11px}',
    '.tv{font-size:18px;font-weight:650;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tv.est{color:var(--mu)}.tv.good{color:var(--good)}.tv.warn{color:var(--warn)}.tv.bad{color:var(--bad)}',
    '.ts{color:var(--mu);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

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
    '.line.warn{color:var(--warn)}.line.bad{color:var(--bad)}',
    '.empty{color:var(--mu);padding:18px 4px;text-align:center}',


    'h4{margin:16px 0 6px;font-size:11px;font-weight:600;color:var(--mu);letter-spacing:.3px}',
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

  var root = document.createElement('div');
  root.className = 'root ' + (THEME === 'dark' ? 'dark' : 'light');
  sr.appendChild(root);

  var btn = document.createElement('div');
  btn.id = 'btn'; btn.innerHTML = '<span class="dot"></span>Astrolabe';
  root.appendChild(btn);

  var panel = document.createElement('div');
  panel.id = 'panel'; panel.style.display = 'none';
  panel.innerHTML =
    '<div id="bar"><span class="ttl"><b>Astrolabe</b><span class="beta" title="Still being added to and tested">beta</span></span><span class="ctl"><span class="g" id="sync" title="Read the real API count from the game">sync</span>' +
    '<span class="g" id="theme" title="Light / dark">&#9680;</span>' +
    '<span class="g" id="close">hide</span></span></div>' +
    '<div id="quota"><span id="q1"></span><span id="q2"></span></div>' +
    '<div id="tabs">' +
    '<button data-tab="out" class="on">Yield</button>' +
    '<button data-tab="cal">Actions</button>' +
    '<button data-tab="gear">Gear</button>' +
    '<button data-tab="battle">Battle</button>' +
    '<button data-tab="base">Base</button>' +
    '<button data-tab="act">Activity</button>' +
    '<button data-tab="in">Settings</button>' +
    '</div><div id="body"></div>';
  root.appendChild(panel);

  function mount() { if (document.body && !document.body.contains(hostEl)) document.body.appendChild(hostEl); }
  mount();
  // Only the panel's own parents matter, so watching every change in the
  // whole game page (which it used to do) is not needed. The tick re-checks
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

  function draggable(el, handle, key, onClick) {
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
    if (panel.style.display === 'flex') { refreshFromStore(); render(); }
  });
  draggable(panel, panel.querySelector('#bar'), 'panelPos', null);
  panel.querySelector('#close').addEventListener('click', function (e) { e.stopPropagation(); panel.style.display = 'none'; });
  panel.querySelector('#theme').addEventListener('click', function (e) {
    e.stopPropagation();
    THEME = THEME === 'dark' ? 'light' : 'dark';
    root.className = 'root ' + THEME;
    store.set('theme', THEME);
  });

  panel.querySelector('#sync').addEventListener('click', function (e) { e.stopPropagation(); syncQuota(true); });

  var tab = 'out';
  panel.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      tab = b.getAttribute('data-tab');
      panel.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      render();
    });
  });

  /* ---- small building blocks ---- */

  function tile(label, value, sub, cls) {
    return '<div class="tile"><div class="tl">' + esc(label) + '</div><div class="tv' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</div>' +
      (sub ? '<div class="ts">' + esc(sub) + '</div>' : '') + '</div>';
  }

  // A cell is a string, or {t: text, c: class}.
  function tbl(head, rows, hlRow) {
    var h = '<div class="card"><table class="t"><thead><tr>' +
      head.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>';
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
        saveInputs(); saveModel();
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
        'Buy droid #' + dr.n, fmt(dr.cost), '+' + fmt(dr.gain), durFmt(dr.payback)]]);
      h += line(short > 0
        ? 'Droid #' + dr.n + ': ' + fmt(short) + ' short' + (crPerH > 0 ? ', about ' + durFmt(short / crPerH) + ' of income' : '') + '. Assumes a new droid starts at 0% and is upgraded to your average.'
        : 'Droid #' + dr.n + ' is affordable now. Assumes a new droid starts at 0% and is upgraded to your average.');
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
      rows.push([r.name, fmt(r.qty), fmt(b.bid), fmt(b.ask), cr === null ? null : fmt(cr)]);
    });

    var emp = p.emp, nHere = S.acts.filter(function (a) { return a.n === S.inputs.node; }).length;
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
      emp && emp.taxRate !== null ? ['Tax', pct(emp.taxRate, 2)] : null
    ]);

    // Only problems and the age of the prices are shown here.
    if (!S.storeOk) h += line('The game page is not readable yet.', 'warn');
    else if (S.gather && !S.gather.isGathering) h += line('Not gathering right now, nothing new is logged.', 'warn');
    if (S.authFail) h += line('API key refused, prices will not refresh.', 'bad');
    else if (!S.key && !S.marketSource) h += line('No API key found. Add it in Settings.', 'warn');
    else if (S.lastErr) h += line(S.lastErr, 'bad');
    else if (S.marketStamp) h += line('Prices ' + hhmm(Date.now() - S.marketStamp) + ' old');
    else h += line('No prices yet.', 'warn');
    if (p.sim.rareChance >= 1) h += line('Rare chance reads 100%, so common output is zero. Check the mods on Gear.', 'warn');
    if (partial) h += line('Not enough bid depth for ' + hours + 'h of output.', 'warn');
    if (missing.length && S.marketSource) h += line('No prices for: ' + missing.join(', '), 'warn');

    h += '<div class="row"><button class="act" id="b_market"' + (remaining('market') > 0 ? '' : ' disabled') + '>Refresh prices (1 call)</button></div>';
    h += renderSuggest(crPerH);
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
    var keyMsg = S.authFail ? 'The game refused this key.'
      : (!S.key ? 'No key found in your game account. Copy it from Profile > Game API and paste it here.'
        : (S.keySource === 'manual' ? 'Using the key you entered.' : 'Using the key from your game account.'));
    h += sect('API key') +
      '<label><input type="password" id="f_key" autocomplete="off" value="" placeholder="' +
      (!S.key ? 'paste your API key' : (S.keySource === 'manual' ? 'saved key in use, type to replace' : 'found automatically')) + '"></label>' +
      line(keyMsg, !S.key || S.authFail ? 'warn' : '');

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
      '<div class="row" style="margin-top:0"><button class="act" id="b_clearacts">Clear action log</button>' +
      '<button class="act" id="b_clearseries">Clear activity history</button></div>';
    return h;
  }

  /* ---- Actions (what the game actually did) ---- */

  function renderCal() {
    var node = NODES[S.inputs.node] || NODES.crystal, st = actionStats(S.inputs.node);
    var ds = effectiveDroids(), avgF = ds.length ? ds.reduce(function (a, d) { return a + 1 + (d.eff + d.sto) / 100; }, 0) / ds.length : 1;
    var formula = clamp(0, 1, (S.model.baseDodge + S.inputs.droidMan * S.model.manToDodge + S.inputs.bDodge) / 100);
    var h = '';

    if (!st) {
      h += '<div class="empty">No gathering actions logged on the ' + esc(S.inputs.node) + ' node yet.</div>';
    } else {
      var span = (st.last - st.first) / 3.6e6;
      h += '<div class="tiles">' +
        tile('Actions', String(st.n), span.toFixed(1) + 'h logged') +
        tile('Survival', pct(st.survival), 'formula ' + pct(formula)) +
        tile('Rare share', pct(st.pRare), st.rare + ' of ' + st.n) +
        tile('Common ore', st.kCommon !== null ? fmt(st.kCommon * avgF, 0) : '--', 'per survivor') +
        tile('Rare ore', st.kRare !== null ? fmt(st.kRare * avgF, 0) : '--', 'per survivor') +
        tile('Global tax', st.taxRate !== null ? pct(st.taxRate, 2) : '--', 'on top') + '</div>';

      var order = node.commons.concat([node.rare]);
      var rows = order.map(function (n) {
        var k = normRes(n), cnt = st.perRes[k] || 0;
        return [n, String(cnt), pct(cnt / st.n)];
      });
      h += tbl(['Resource', 'Actions', 'Share'], rows, rows.length - 1);
      if (st.n < S.inputs.minActions) h += line((S.inputs.minActions - st.n) + ' more actions before measured values replace the estimates.');
      else if (st.n < 60) h += line('Small sample. Rare share settles after about 60 actions.');
    }

    return h;
  }

  function rateFmt(x) {
    if (x === null || x === undefined || isNaN(x)) return '--';
    var a = Math.abs(x);
    if (a !== 0 && a < 10) return x.toFixed(a < 1 ? 3 : 2);
    return fmt(x, 0);
  }

  function labelFor(path) {
    var p = String(path);
    var named = NAMED_COUNTERS.some(function (d) { return d.id === p; });
    var base = /^res\./.test(p) ? p.slice(4) : (named ? p : p.split('.').pop());
    base = base.replace(/\./g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    return base.charAt(0).toUpperCase() + base.slice(1);
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

  // Watches for a finished squadron battle in the game's memory and keeps a
  // small record of it. Runs on the regular tick, whichever tab is open.
  var recSeen = null;

  // A duel is recorded whenever the game has one loaded: right after a
  // fight, or when one is opened in Battlefield > Battle Log > Arena.
  function recTick() {
    if (!S.storeOk || S.inputs.recBattles === false) return;
    var st = S.storeState, A = st.PvPArenaStore, d = A && A.currentDuel;
    if (!d || !d.logs || !d.logs.length) return;
    var fp = (d._id || '') + '|' + d.logs.length;
    if (fp === recSeen) return;
    recSeen = fp;
    var me = st.UserStore && st.UserStore.username;
    var rec = arBuild(d, me, readPvp(st), Date.now());
    if (!rec) return;
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
    if (!recs.length) return null;
    var key = pvPlanKey(pv, keep, recs);
    if (pvMemo.key === key) return pvMemo.plan;
    if (pvBusy !== key && pvFailed !== key) {
      pvBusy = key;
      setTimeout(function () {
        pvPlanRun(pv, recs, keep, function (plan, err) {
          pvBusy = null;
          if (err || !plan) { pvFailed = key; setErr('The battle plan failed: ' + (err && err.message)); }
          else pvMemo = { key: key, plan: plan };
          if (panel.style.display !== 'none' && tab === 'battle') render();
        });
      }, 40);
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
    return kvs([['You hit', pct(a, 0) + ' → ' + pct(a1, 0)], ['They hit', pct(b, 0) + ' → ' + pct(b1, 0)]]);
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

  function waitLine(plan) {
    return S.battles.length ? line(S.lastErr && pvFailed ? S.lastErr : 'Working out the numbers...') : '';
  }

  function renderCur(pv, plan) {
    var t0 = pvTotals(pv), h = '';
    h += '<div class="tiles">' + tile('Damage', grp(t0.damage), 'per clone hit') + tile('Health', grp(t0.hp), 'per clone') +
      tile('Win rate', plan ? pvPct(plan.cur.score) + '%' : '--',
        plan ? '\u00b1' + seTxt(plan.cur.se) + ', ' + plan.pool + ' duel' + (plan.pool === 1 ? '' : 's') : 'needs duels') + '</div>';
    h += sect('Stat points') + buildTables(pv, t0);
    if (plan) h += hitLines(t0, plan.ref);
    else h += waitLine(plan);
    h += line('Read from your game. The win rate is how often this build wins a simulated duel against the arena opponents on record, half of them attacking and half defending.');
    if (!S.battles.length) h += line('No duel recorded yet. Fight one in the arena, or open any duel in Battlefield > Battle Log > Arena, and it is filed away.', 'warn');
    else if (plan) h += confLine(plan);
    return h;
  }

  // An error bar reads better with a decimal while it is small.
  function seTxt(se) { return se >= 10 ? String(Math.round(se)) : String(Math.round(se * 10) / 10); }

  // How sure the numbers are, in plain words, and what would tighten them.
  function confLine(plan) {
    var n = plan.pool, se = plan.cur ? plan.cur.se : 50;
    var word = n < PV_FLOOR ? 'Not enough yet' : (se > 12 ? 'Rough' : (se > 7 ? 'Fair' : (se > 4 ? 'Good' : 'Strong')));
    var txt = word + ': ' + n + ' duel' + (n === 1 ? '' : 's') + ' on record, win rate good to about ' +
      String.fromCharCode(177) + seTxt(se) + ' points.';
    if (plan.need > 0) txt += ' About ' + plan.need + ' more would bring it to ' + String.fromCharCode(177) + '5.';
    return line(txt, n < PV_FLOOR ? 'warn' : '');
  }

  function renderBest(pv, plan) {
    if (!S.battles.length) return line('No duel recorded yet. The best build is worked out against the opponents you actually meet, so it needs duels first.', 'warn');
    if (!plan) return waitLine(plan);
    if (plan.thin) {
      return '<div class="tiles">' + tile('Duels', plan.pool + ' / ' + plan.floor, 'on record') +
        tile('Win rate', pvPct(plan.cur.score) + '%', '\u00b1' + seTxt(plan.cur.se)) +
        tile('Verdict', 'Too early', 'no advice yet', 'warn') + '</div>' +
        line('Nothing is suggested until there are ' + plan.floor + ' duels on record. With ' + plan.pool +
          ', any build would look better or worse by luck alone, and following that would be worse than leaving it be.') +
        confLine(plan);
    }
    if (plan.contested < PV_CONTESTED) {
      return '<div class="tiles">' + tile('Duels', String(plan.pool), 'on record') +
        tile('Win rate', pvPct(plan.cur.score) + '%', '\u00b1' + seTxt(plan.cur.se)) +
        tile('Verdict', 'Nothing to tune', plan.decided + ' already settled', 'good') + '</div>' +
        line('Every opponent on record is one you always beat or always lose to, so no change of build would alter a single result. This will have something to say once you meet someone closer to your own strength.') +
        confLine(plan);
    }
    var f = plan.free, t0 = pvTotals(pv), h = '';
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
      return h;
    }
    h += '<div class="tiles">' + tile('Damage', grp(f.totals.damage), 'now ' + grp(t0.damage)) + tile('Health', grp(f.totals.hp), 'now ' + grp(t0.hp)) +
      tile('Win rate', pvPct(f.score) + '%', pts1(f.gain) + ' ' + pm + seTxt(f.se), worth ? 'good' : '') + '</div>';
    h += sect('Suggested build') + buildTables(f.build, f.totals, pv, t0);
    h += hitLines(t0, plan.ref, f.totals);
    if (worth) h += line('Free changes only, nothing to buy. Green is different from your current build. Worth ' + pts1(f.gain) +
      ' points of win rate, give or take ' + seTxt(f.se) + ', measured against the same opponents with the same rolls.');
    else h += line('Worth ' + pts1(f.gain) + ' points give or take ' + seTxt(f.se) + ': inside the noise.', 'warn');
    h += confLine(plan);
    return h;
  }

  function renderUp(pv, plan) {
    var h = '', rows;
    if (plan && !plan.stop) rows = plan.next;
    else {
      rows = []; pv.gear.forEach(function (g, i) { rows = rows.concat(pvUpgradeRows(pv, null, 0, i)); });
      if (!plan && S.battles.length) h += waitLine(plan);
      if (plan && plan.thin) h += line('Costs only: with ' + plan.pool + ' duel' + (plan.pool === 1 ? '' : 's') +
        ' on record out of ' + plan.floor + ', there is not enough to say what an upgrade is worth.', 'warn');
      else if (plan) h += line('Costs only: every opponent on record is already settled either way, so no upgrade would change a result.', 'warn');
    }
    if (plan && !plan.stop && plan.buy.steps.length) {
      h += '<div class="tiles">' + tile('Win rate now', pvPct(plan.cur.score) + '%', '') + tile('After buying', pvPct(plan.buy.score) + '%', pts1(plan.buy.gain) + ' points', 'good') + tile('Steps', String(plan.buy.steps.length), 'upgrades') + '</div>';
      h += sect('Affordable now') + tbl(['Piece', 'Upgrade', 'Cost'], plan.buy.steps.map(function (x) {
        return [cap(x.name), cap(x.kind) + ' ' + x.from + ' → ' + x.to, grp(x.cost) + ' ' + x.res];
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
    var todo = S.battles.slice(-PV_CHECK_MAX).filter(function (r) { return !pvCheck[arKey(r)]; })[0];
    if (!todo) return;
    pvCheckBusy = true;
    setTimeout(function () {
      try { pvCheck[arKey(todo)] = pvReplay(todo, PV_CHECK_SIMS); } catch (e) { pvCheck[arKey(todo)] = { p: null, rounds: null }; }
      pvCheckBusy = false;
      if (panel.style.display !== 'none' && tab === 'battle' && bsub === 'fights') render();
    }, 30);
  }

  function renderFights() {
    var recs = S.battles, h = '', n = recs.length;
    var wins = recs.filter(function (r) { return r.w; }).length, stale = recs.filter(function (r) { return r.a; }).length;
    var plan = pvMemo.plan;
    h += '<div class="tiles">' +
      tile('Recorded', n + ' / ' + AR_MAX, n < PV_FLOOR ? (PV_FLOOR - n) + ' more before advice' : (n ? 'last ' + whenTxt(recs[n - 1].t).toLowerCase() : 'none yet'),
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

  /* ---- Base ---- */

  var bbsub = 'next';

  function bbWhen(sec) {
    var ms = sec * 1000 - Date.now();
    return ms > 0 ? hhmm(ms) : 'due';
  }

  function renderBase() {
    var B = S.storeOk ? readBase(S.storeState) : null;
    if (!B) return '<div class="empty">The base is not readable yet. Open the Base page in the game once after a reload.</div>';
    var h = '<div class="seg">' + [['next', 'Next'], ['mods', 'Base'], ['lab', 'Lab']].map(function (x) {
      return '<button data-bsub="' + x[0] + '"' + (bbsub === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>';
    }).join('') + '</div>';
    if (bbsub === 'mods') return h + renderBaseMods(B);
    if (bbsub === 'lab') return h + renderBaseLab(B);
    return h + renderBaseNext(B);
  }

  function renderBaseNext(B) {
    var h = '<div class="tiles">' +
      tile('Stellarium', fmt(B.stellarium, 0), B.nextDrop ? 'next in ' + bbWhen(B.nextDrop) : 'for tiers') +
      tile('Credits', fmt(B.credits), 'for lab levels') +
      tile('Lab craft', '×' + B.mult, 'every job') + '</div>';

    var list = bbCandidates(B), top = list.slice(0, 3);
    if (!top.length) return h + line('Nothing to suggest: every module and building is either at its ceiling or out of reach.');

    h += sect('Do this next');
    top.forEach(function (c, i) {
      h += '<div class="sg' + (c.afford ? ' ok' : '') + '">' +
        '<div class="sgh"><b>' + (i + 1) + '</b>' + esc(c.what) + '<i>' + esc(c.how) + '</i></div>' +
        '<div class="sgn">' + esc(c.note) + '</div>' +
        '<div class="sgc">' + esc(fmt(c.cost, 0) + ' ' + c.unit) + ' · ' +
        esc(c.afford ? 'you have ' + fmt(c.have, 0) : (c.shared ? 'credits already spent above' : 'you have ' + fmt(c.have, 0))) +
        '</div></div>';
    });

    var short = list.filter(function (c) { return !c.afford && c.far; }).sort(function (a, b) { return a.cost - b.cost; })[0];
    if (short) h += line('Worth saving for: ' + short.what + ' ' + short.how + ' for ' + fmt(short.cost, 0) + ' credits, ' + short.note + '.');
    h += line('Ranked by how much more you would produce, counting only the jobs you are actually running. Credits are one purse, so only the first credit row can be bought today.');
    return h;
  }

  function renderBaseMods(B) {
    var rows = B.modules.map(function (m) {
      var boost = bbBoost(m, B.eff), rate = BB_RATE[m.name] ? bbAvgOut(m, B.eff) : null;
      var cell = m.name === BB_ENHANCER ? { t: '\u00d7' + B.mult + ' craft', c: 'good' }
        : (rate === null ? null : { t: fmt(rate, 0), c: m.on ? '' : 'mu' });
      return [bbCap(m.name), m.level + (m.tier ? ' / ' + m.tier : ''), Math.round(boost) + '%', cell];
    });
    var h = tbl(['Module', 'Level / tier', 'Boost', 'Output / h'], rows);
    h += kvs([['Efficiency', '+' + B.eff + '%'], ['Lab craft', '×' + B.mult]]);
    h += line('Boost is level x (1 + tier/100) x (1 + efficiency/100); the Quantum server and the Laboratory enhancer count their level at half.');
    h += line('Output is the average. The game shows the guaranteed part only, so its number is a little lower whenever the boost is not a round hundred.');
    return h;
  }

  function renderBaseLab(B) {
    var rows = B.labs.map(function (L) {
      var run = B.running[L.id];
      return [{ t: bbCap(L.name), c: run ? '' : 'mu' }, String(L.level), L.timer.toFixed(1) + 's',
        bbCap(L.makes || ''), { t: fmt(L.rate, 0), c: run ? 'good' : 'mu' }];
    });
    var h = tbl(['Building', 'Level', 'Timer', 'Makes', 'Per hour'], rows);
    h += line('A craft takes its base time (30s, or 45s for the four forges) less a tenth of a second per level, and never goes under 5s. Every craft yields ' + B.mult + '.');
    h += line('Green is a job you have running. Levels cost credits: a million times 1.15, times the triangle of the level.');
    return h;
  }

  /* ---- Gear ---- */

  function renderGear() {
    var h = '';
    if (S.droids && S.droids.length) {
      var use = S.droids.filter(function (d) { return d.active; });
      var avg = function (k) { return use.length ? use.reduce(function (a, d) { return a + d[k]; }, 0) / use.length : 0; };
      var rows = S.droids.slice(0, 12).map(function (d, i) {
        var dodge = clamp(0, 100, S.model.baseDodge + d.man * S.model.manToDodge + S.inputs.bDodge);
        return [{ t: String(i + 1), c: d.active ? '' : 'mu' }, fmt(d.eff) + '%', fmt(d.sto) + '%', fmt(d.man) + '%', dodge.toFixed(1) + '%'];
      });
      rows.push(['Average', fmt(avg('eff')) + '%', fmt(avg('sto')) + '%', fmt(avg('man')) + '%',
        clamp(0, 100, S.model.baseDodge + avg('man') * S.model.manToDodge + S.inputs.bDodge).toFixed(1) + '%']);
      h += sect('Droids') + tbl(['#', 'Efficiency', 'Storage', 'Maneuver', 'Dodge'], rows, rows.length - 1);
    } else {
      h += '<div class="empty">No droids found.</div>';
    }

    if (S.sources.length) {
      var src = S.sources.map(function (x) { return [x.name, '+' + fmt(x.pct) + '%']; });
      src.push(['Total', '+' + fmt(sourcesTotal()) + '%']);
      h += sect('Resource bonus') + tbl(['Source', 'Bonus'], src, src.length - 1);
    }

    h += sect('Ship mods') + kvs([['Rare chance', '+' + fmt(S.inputs.bRareChance) + '%'], ['Dodge', '+' + fmt(S.inputs.bDodge) + '%']]);
    if (S.bonusScan && S.bonusScan.matched.length) {
      h += tbl(['Slot', 'Effect'], S.bonusScan.matched.slice(0, 12).map(function (x) {
        var i = x.indexOf(': '), j = x.indexOf('  <-');
        return [x.slice(0, i).replace('_slot', ''), (j > 0 ? x.slice(i + 2, j) : x.slice(i + 2)).replace('[assumed]', '').trim()];
      }));
    }
    return h;
  }

  /* ---- Activity ---- */

  function renderAct() {
    if (S.series.length < 2) {
      return '<div class="empty">Recording, ' + S.series.length + ' sample' + (S.series.length === 1 ? '' : 's') + '.<br>' +
        'Rates appear after two samples, ' + (S.inputs.recordMins || 10) + ' min apart.</div>';
    }
    var span = recordingSpan();
    var r1 = rateOver(1), r24 = rateOver(24);
    var g1 = gainsOver(1), g7 = gainsOver(7), g30 = gainsOver(30);
    var keys = {};
    [g1, g7, g30].forEach(function (g) { Object.keys(g).forEach(function (k) { keys[k] = 1; }); });
    if (r24) Object.keys(r24.per).forEach(function (k) { keys[k] = 1; });

    var order = Object.keys(keys).sort(function (a, b) {
      var pa = NAMED_COUNTERS.some(function (d) { return d.id === a; }) ? 0 : 1;
      var pb = NAMED_COUNTERS.some(function (d) { return d.id === b; }) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return Math.abs(g7[b] || 0) - Math.abs(g7[a] || 0);
    });

    var h = '';
    h += order.length
      ? tbl(['Counter', '/ h', 'Today', '7 days', '30 days'], order.slice(0, 30).map(function (k) {
        var ph = r24 && r24.per[k] !== undefined ? r24.per[k] : (r1 && r1.per[k] !== undefined ? r1.per[k] : null);
        function cell(v) { return v === undefined ? null : { t: fmt(v, 0), c: v < 0 ? 'bad' : '' }; }
        return [labelFor(k), ph === null ? null : { t: rateFmt(ph), c: ph < 0 ? 'bad' : '' }, cell(g1[k]), cell(g7[k]), cell(g30[k])];
      }))
      : '<div class="empty">Nothing has changed yet.</div>';
    h += line('Recording for ' + span.toFixed(1) + 'h' + (span < 24 ? '. The 7 and 30 day columns fill in over time.' : '.'));
    return h;
  }

  /* ---- chrome ---- */

  function renderQuota() {
    if (panel.style.display === 'none') return;
    var q1 = panel.querySelector('#q1'), q2 = panel.querySelector('#q2'), sy = panel.querySelector('#sync');
    if (!q1) return;
    var ex = quotaExact(), tilde = ex ? '' : '~';
    q1.textContent = 'Market ' + tilde + used('market') + '/' + limitOf() + '  ·  User ' + tilde + used('user') + '/' + limitOf();
    q2.textContent = (ex ? 'synced ' + hhmm(Date.now() - S.quotaSyncedAt) + ' ago' : 'not synced') +
      '  ·  resets ' + hhmm(S.budget.nextReset - Date.now());
    q1.className = remaining('market') <= S.inputs.reserve ? 'warn' : '';
    if (sy) sy.textContent = S.syncing ? 'syncing...' : 'sync';
  }

  // A broken tab must not take the tick down with it.
  function render() {
    try { render0(); } catch (e) { setErr('drawing the panel failed: ' + ((e && e.message) || e)); }
  }

  function render0() {
    if (panel.style.display === 'none') { btn.className = (S.busy || S.syncing) ? 'busy' : (S.lastErr ? 'bad' : (S.storeOk ? 'ok' : '')); return; }
    // Redrawing while someone types in the Spend box would throw the text away.
    if (spendEditing && tab === 'out' && panel.querySelector('#f_spend')) { renderQuota(); return; }
    var body = panel.querySelector('#body'), keep = body.scrollTop;
    if (tab === 'out') { body.innerHTML = renderOut(); }
    else if (tab === 'act') { body.innerHTML = renderAct(); }
    else if (tab === 'in') { body.innerHTML = renderIn(); wireFields(); }
    else if (tab === 'cal') { body.innerHTML = renderCal(); }
    else if (tab === 'battle') { body.innerHTML = renderBattle(); }
    else if (tab === 'base') { body.innerHTML = renderBase(); }
    else { body.innerHTML = renderGear(); }
    body.scrollTop = keep;
    wireButtons();
    renderQuota();
    btn.className = (S.busy || S.syncing) ? 'busy' : (S.lastErr ? 'bad' : (S.storeOk ? 'ok' : ''));
  }

  function wireButtons() {
    function on(id, fn, ev) {
      var el = panel.querySelector(id);
      if (el) el.addEventListener(ev || 'click', fn);
    }
    on('#f_key', function () {
      S.key = panel.querySelector('#f_key').value.trim();
      S.keySource = S.key ? 'manual' : 'auto';
      store.set('key', S.key); store.set('keySource', S.keySource);
      S.authFail = false; setErr(null);   // a new key deserves a new try
      scheduleMarket(); renderQuota();
    }, 'input');
    on('#b_market', function () { refreshMarket(true); });
    on('#b_clearacts', function () {
      if (!confirm('Clear the gathering action log? Measured values start again from zero.')) return;
      S.acts = []; S.lastActKey = null; store.set('acts', []); store.set('lastActKey', null); render();
    });
    panel.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = b.getAttribute('data-sub'), q = b.getAttribute('data-bsub');
        if (s) { bsub = s; bshow = false; } else if (q) bbsub = q;
        render();
      });
    });
    on('#b_showbest', function () { bshow = true; render(); });
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
      S.battles = []; store.set('battles', []); pvMemo = { key: null, plan: null }; pvCheck = {}; pvFailed = null; recSeen = null; render();
    });
    on('#b_clearseries', function () {
      if (!confirm('Clear the recorded activity history?')) return;
      S.series = []; S.daily = {}; S.curDay = null;
      store.set('series', []); store.set('daily', {}); store.set('curDay', null);
      render();
    });
  }

  /* ============================================================
     14. SCHEDULING
     ============================================================ */

  var marketTimer = null, nextMarketAt = 0, pollTimer = null, lastQuotaTry = 0, lastPriceTry = 0;

  function scheduleMarket() {
    if (marketTimer) clearTimeout(marketTimer);
    marketTimer = null;
    // A refused key would fail identically on every tick, so do not schedule.
    if (S.authFail || !S.key) { nextMarketAt = 0; return; }
    if (!S.inputs.marketAuto) { nextMarketAt = 0; return; }
    var iv = marketInterval();
    if (!iv) { nextMarketAt = 0; return; }
    var since = S.marketStamp ? Date.now() - S.marketStamp : Infinity;
    var wait = Math.max(5000, iv - since);
    nextMarketAt = Date.now() + wait;
    marketTimer = setTimeout(function () { refreshMarket(false); }, wait);
  }

  function startStorePoll() {
    if (pollTimer) clearInterval(pollTimer);
    var secs = Math.max(3, S.inputs.storePoll || 10);
    pollTimer = setInterval(function () { stage('the update', tick); }, secs * 1000);
  }

  function tick() {
    mount();
    // A one-off failure should not leave the dot red for the rest of the day.
    if (S.lastErr && S.lastErrAt && Date.now() - S.lastErrAt > 600000) setErr(null);
    refreshFromStore();
    stage('recording the battle', recTick);
    // Ask the game for the real API count every 5 minutes, in the background.
    if (S.storeOk && Date.now() - lastQuotaTry > 5 * 60000) { lastQuotaTry = Date.now(); syncQuota(false); }
    // The next droid's price, when it is unknown, stale, or a droid was added.
    if (S.storeOk && S.droids && Date.now() - lastPriceTry > 5 * 60000 &&
        (!S.droidPrice || Date.now() - S.droidPrice.t > 30 * 60000 || S.droidPrice.n !== S.droids.length)) {
      lastPriceTry = Date.now(); refreshDroidPrice();
    }
    // Whenever the Game API tab happens to be open, take the real count.
    if (!S.syncing && /^#\/profile/.test(location.hash)) readQuotaFromPage();
    if (panel.style.display !== 'none' && (tab === 'out' || tab === 'gear' || tab === 'battle' || tab === 'base')) render();
    else renderQuota();
  }

  /* ============================================================
     15. BOOT
     ============================================================ */

  rollBudget();
  loadCachedMarket();

  // The Vue app may not have mounted yet; retry for a while, then give up
  // quietly and fall back to manual inputs.
  var tries = 0;
  (function tryStore() {
    var ok = stage('the first read', refreshFromStore);
    if (ok) { stage('recording the battle', recTick); startStorePoll(); scheduleMarket(); render(); return; }
    if (++tries > 40) { startStorePoll(); scheduleMarket(); render(); return; }
    setTimeout(tryStore, 1000);
  })();

  render();
})();
