# ASTROLABE — handoff notes (script v3.11.0, last updated 2026-09-20)

*Formerly SO CALC. Renamed in 3.10.1; see "The name" below before touching anything called `socalc`.*

These notes, `astrolabe-working-rules.md` and the latest script are everything a new session needs. In the project folder they live at `docs/` and `astrolabe.user.js`; `CLAUDE.md` at the top of the folder is the entry point and imports both documents.

**Read `so-calc-working-rules.md` first.** The rule that matters most: propose before coding (is it doable, how it works, how it looks, what needs deciding), then wait for a clear yes.

---

## 1. The script

Tampermonkey userscript for https://steam.stellarodyssey.app/. ES5, one IIFE, shadow-DOM overlay panel. Grants GM_xmlhttpRequest / GM_setValue / GM_getValue; `@connect` steamapi.stellarodyssey.app and api.stellarodyssey.app. State via `store.get/set` (GM storage, `socalc:` localStorage fallback).

Tabs: **Yield** (rates, prices, droid suggestions), **Actions** (measured gathering stats), **Gear** (droids, bonuses), **Battle** (PvP build from arena duels, 4 sub-tabs), **Base** (base + laboratory, 3 sub-tabs), **Activity** (counter history), **Settings**.

Section map inside the file: 12b droid upgrades, 12c PvP build math (`pv*`), 12d hit-rate inference (`rcFit`) and the arena duel recorder (`ar*`), 12e duel simulator (`rlDuel`, `rlPhase`, `rlMe`), 12f battle planner (`pvPlanRun`), 12g base and lab (`bb*`, `readBase`), 13 UI.

## 2. Decisions already settled — do not re-propose

- **No PvE / mob battling simulator.** The game has a good one.
- **The Base tab is about time and throughput, not material cost.** The base is timer-gated; the user will get materials if needed. Ranking by "what costs less" was rejected twice.
- **The build suggestion runs on ARENA duels only (3.9.0).** Squad battles are no longer recorded or used: "if you are good in arena, you will be good in squad". Do not reinstate the squadron recorder.
- **Team "Squads" win-chance simulation: dropped.** It was proposed, then superseded — the user wanted the meta/base direction instead.
- **Market prices for base outputs (silicon, scrap, cores): available but not wanted "for now".**
- **Splitting the poll tick (a 3.7.4 proposal): declined.** At 1 ms a tick it is not worth chasing.
- **Scanning other players' builds: dropped by the user.**
- **A count of Astrolabe users ("x players online" among users of this tool): dropped 2026-09-20.** It cannot be done without a server — a userscript cannot see other copies of itself, and nothing in the game marks a player as running a third-party tool. The only ways to create that mark are writing to the game (an action, forbidden) or hosting a service; the user declined to run one ("I wouldn't want any login required"). Do not re-propose. Costed at the time: a Cloudflare Worker plus one SQLite-backed Durable Object would fit the free plan (KV will not — 1,000 writes/day, and every presence ping is a write).
- **Showing the game's own player-activity numbers: proposed and deferred, not rejected.** The user asked for it, then chose "nothing for now"; they did pick the Activity tab as the home for it. The research is in section 3 below, so it need not be redone. Ask before building.
- UI must stay light: clear stats, little text, no debug tabs, must fit on screen.
- Never print, log or embed the API key. The script contains no key; it reads the user's own from the game, and the Settings box never displays a saved key.
- Inspection of the live game is READ-ONLY. Reading pages and fetching the game's JS is fine. Never click anything that changes state. **The platform's transaction guard blocks in-game Upgrade buttons regardless of intent** — read the formulas out of the JS instead.
- Deliver each version as a new `astrolabe-X.Y.Z.user.js`, never overwrite, keep the changelog block at the top current.
- **The name (3.10.1).** The tool is ASTROLABE; it was SO CALC up to 3.10.0. `@name` is "Astrolabe for Stellar Odyssey (beta)" and the panel shows a `beta` pill beside the title, because it is still being added to and tested. Two things must not be changed on a whim: `@namespace` stays `stellarodyssey-calc`, and **every storage key keeps the `socalc:` prefix** — settings, history and recorded duels all live under it, so "tidying" it to match the new name would wipe every user's data. There is a comment in the store helper saying so. Keep `@version` plain (`3.10.1`, never `3.10.1-beta`): Tampermonkey sorts a pre-release suffix below the plain number, so dropping the word later would read as a downgrade and the update would be refused. Renaming also makes Tampermonkey file it as a new script, so the user must delete the old SO CALC entry after installing or both panels run at once.

## 3. How the game exposes data

Vue 3 + Quasar + Pinia. Root: `document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia.state.value`. Router at `globalProperties.$router`. `$pinia._s` is a Map of store objects; `GameStore.game` is the raw WebSocket.

Socket protocol: MessagePack map, zlib-deflated (`CompressionStream('deflate')`). Request `{classname, method, data:{}}`; reply carries `classname`, `method`, `value`. The script has its own small decoder.

**Read-only socket calls in use:** `Player.getApiQuota`, `Gathering.getNextDroidPrice`. Also read-only but unused: `Laboratory.nextBuilding`, `Laboratory.getNextLaboratoryBase`. **Never call** `buildNext`, `upgradeLaboratoryBuilding`, `queueLabBuilding`, `upgradeLaboratoryBaseBuilding`, `queueBaseBuilding`, `cancelBuildingQueue` — those act.

Public API: 50 calls/day per endpoint, resets 00:00 UTC. Only `/market` is used. Real count from `Player.getApiQuota`, fallback the Profile → Game API page text.

**Player-activity numbers (all read-only, all already in memory, no API cost):**

- `GameStore.playersOnline` — the game's own figure, 586 when sampled. The user says it counts players who still have actions left, so it includes idle accounts and is an upper bound, not "people at their keyboards". `GameStore` also has `ping` (your latency, 121 ms), `patchVersion` ("1.2.2"), and `maintenance` + `maintenanceMessage`, which would make a free warning banner.
- `GalaxyBossStore` — the best hard measure of real activity. `participantCount` was 298 for event `gb_1789927200`, against `currentEvent.initialParticipantCount` 282 at spawn. Event ids encode `spawn_at`, which lands exactly on the hour, so a fresh sample arrives hourly; the fight itself runs about 25 minutes. `lastEvent.top_leaderboard` is 100 named entries (`user_id, username, squadron_name, total_damage, reward_weight, rank, in_system`) — a free, already-public list of active players. `roundsDetail` is 100 rounds but its `damageByPlayers` is a total, a number, not a per-player list, so no distinct-player count can be derived from it.
- `ChatStore` — six rooms buffering 200 messages each (1,200 total, about 104 hours). Messages carry `username` and `timestamp`, so distinct speakers per window is free: 6 in 5 min, 10 in 15 min, 19 in 1 h, 52 in 6 h, 71 in 24 h when sampled. Biased towards talkative players. `ChatStore.userList` exists but stays empty until the game's own member panel fills it.
- Dead ends: squadron members carry `active` but it means "active member", always true. Arena opponents (`_id, username, levels, premium, pvp_arena, clones`) carry no activity field. `MarketStore` holds only UI state.

The honest framing agreed with the user: `playersOnline` is the ceiling, boss participants are a hard floor, chat speakers are the live pulse, and the real figure sits between the first two. Do not present any of them as a single confident "active players" number.

Game code: the formulas live in the main bundle (`index-*.js`) plus per-page chunks. **A page chunk only downloads when its page or dialog opens, but you can fetch it by URL from the same asset directory** — that is how the laboratory credit cost was found after the click was refused. Useful chunks: `LaboratoryPage-*.js`, `useLaboratory-*.js`, `MainLayout-*.js`.

## 4. Gathering model (Yield / Actions / Gear)

- 60 actions/hour. Ore per surviving droid = K × (1 + efficiency% + storage%). Survival ≈ 50 + maneuverability/2 + mods.
- Resource bonus totalled +262.4%: catalysts, Amplifier building, station reputation (5 each), pet, subscription, income boost. Boost `timer` is an epoch-seconds expiry.
- Droid stat upgrade x → x+0.1 costs 5000·i·e^(0.15i), i = x+0.1. Next droid price from the server.
- Suggestions rank droid upgrades by payback, respecting "credits to keep", "max payback days" and the **Spend box** (`S.inputs.spendLimit`, 0 = everything). The box parses 500M / 1.5B / 250k / digits (`parseAmount`), applies on Enter or blur, and the tab does not redraw while it has focus (`spendEditing`) or the 10 s refresh would erase typing.

## 5. PvP model (Battle tab)

**Verified against the game's own numbers.** Four stats (power, precision, evasion, hull), four gear pieces (helmet, armor, fists, legs), each feeding one stat and carrying one skill (dot, focus, stun, block).

- Gear value = 100 × level × (1 + tier/100 + craftingLevel/100). A slotted Velari pet adds petLevel × 50 to all four stats.
- Per-clone damage = power total × clones. Per-clone maxhp = hull total × clones × 7. Hit chance = precision / (precision + enemy evasion).
- Skills 5% per piece, Focus 2.5%. Level cost 20(L+1)(L+2) of the piece's material; tier cost 10(T+1)(T+2) badges. Both confirmed in the game's code (`upgradeStatLevelCumulativeCost` / `upgradeStatTierCumulativeCost`). Clone crit base 30 confirmed (`clonesBaseCriticalDamage`).
- Stat pool = sum of pvpstats + available. `remainingPvPStatResets: -1` = unlimited.

**Historical: a squadron fight is a relay, not duels.** (Kept because it is a true fact about the game; the script's simulator no longer implements it, see 3.11.0.) One fighter per side at a time, all clones act in order, the defending side strikes first each round, the winner keeps surviving clones and their health, 300-round cap. Line-up order is the squadron's configured `groupOrder`, **not** sorted by precision (checked against two groups; the other tool sorts by precision and is wrong for battlefield fights).

Estimated, not verified: enemy precision/evasion/skills (inferred from hit rates, ≥12 rolls or the battle median is used; skills are raw percentages, one enemy showed ~33% block), the kill multiplier after each win (1, 0.8, 0.75 measured, 0.7 extrapolated), and skill effects (block cancels a hit, stun skips the next action, focus marks a clone, DoT is 0.5× base plus two ticks).

**Known gap (squadron relay only):** against the one real squad fight checked the relay ran ~15% fast (47 rounds vs 55). Since 3.9.0 scoring no longer uses the relay, so this no longer affects advice. On duels the model check has been matching closely (14 real vs 15 simulated rounds on the harness).

### Battle tab behaviour (3.10.0, arena)
Four sub-tabs: Current, Best, Upgrades, Duels. **Score is a win rate**: how often the build wins a simulated duel against the opponents on record, half attacking and half defending, 1200 sims on common random numbers. A margin term (health left standing, always under one point) is added internally so the search still discriminates once a build beats everything on record; `pvPct()` strips it for display.

**How sure it is (3.10.0).** Four pieces, all in section 12d/12f:

- `PV_FLOOR = 8` duels before anything is suggested at all. Below it the Best and Upgrades tabs say so and offer nothing (`plan.thin` → `plan.stop`); the Duels tab counts down. Rationale given to the user: with fewer, whichever build came out ahead did so by luck, and following it is worse than leaving the build alone.
- **Settled fights are set aside.** An opponent whose simulated win rate is within `PV_DECIDED = 0.02` of 0 or 1 gives every build the same result, so it carries no information about which build is better. The search runs on the contested sub-pool (`live`); `plan.contested` / `plan.decided` are reported. Fewer than `PV_CONTESTED = 3` contested → also `plan.stop`, with a "nothing to tune" message. This is the user's "it should ignore easy fight".
- **Each opponent is five opponents.** `arDraws(f)` turns one recorded fighter into five equally likely versions, spreading precision and evasion by `AR_SPREAD = [-1.15,-0.5,0,0.5,1.15]` standard errors of the binomial hit counts stored in `q`. `pvScoreOf` cycles through the draws, so total sims are unchanged. Turning a hit rate back into a stat is a convex map, so the five are rescaled to put their mean back on the plain estimate — keep that recentring, without it win rates read a few points low.
- **A change must beat its own noise.** `pvScoreOf` returns `per` (win rate per opponent) and `se` (standard error of the mean over opponents). `pvGap(a,b)` pairs the two builds opponent by opponent, which cancels most of the shared noise. A change is offered only when `gain > max(2 × se, bestGap)`. `bestGap` (default now **2**, was 5) is only a floor; the statistical bar usually dominates. `pvNeedFor(se, n, 5)` gives the "N more duels would bring it to ±5" line.

Display: `confLine(plan)` (Not enough yet / Rough / Fair / Good / Strong) appears on Current, Best and Upgrades; `seTxt()` prints one decimal below 10.

Because the arena is one against one, the relay ordering and the kill multiplier are no longer on the scoring path at all, and **as of 3.11.0 they are not in the script either**: `rlBattle` and its relay machinery were replaced by `rlDuel`, a one-against-one engine with reused clone buffers. If squad fights ever come back, the reference implementation is `releases/astrolabe-3.10.1.user.js`, which `t/sim_equiv.js` also uses as the oracle.

**Performance rules (3.11.0) — these exist because 3.10.0 shipped a real freeze.** Raising the duel cap from 40 to 200 made one planner slice take 992 ms with every fight contested, because the cost scaled with the pool while the work was still cut into fixed-size pieces. The fix, and the rules to keep:

- `PV_SEARCH_MAX = 40`: the search for a better build runs on an even sample of the contested opponents (`pvSample`). The reported win rate, error bar and gain are still measured over **all** of them.
- The six skill-set **finalists are scored on the full contested pool** (`liveAll`), not the sample. They are close together, which is exactly when a small sample misleads: with finalists on the sample only, 1 of 5 test pools chose a different skill and lost 2.5 points; with this, 5 of 5 chose the identical build (`t/cap_check.js`).
- `PV_SLICE_MS = 35`: the skill-set pass sizes its slices by the clock, not by a count.
- `PV_MAX_BATTLES = 2000` and `PV_MIN_EACH = 10` bound one `pvScoreOf` call. The buy-preview scoring is its own slice.
- The Duels-tab model check replays only the 40 most recent duels, 40 replays each (`PV_CHECK_MAX`, `PV_CHECK_SIMS`).
- Measured, 200 duels all contested: 9.9 s and a 992 ms freeze → 2.0 s and ~100 ms. The remaining ~100 ms slice is the headline win rate over the whole pool, deliberately kept exact.
- `arDraws(f, pRef, eRef)` takes our reference precision/evasion as arguments. It used to write `pRef`/`eRef` onto the stored record, which then got saved to disk.

**Rule of thumb this taught:** whenever a cap, limit or default that controls how much data there is gets raised, re-measure everything whose cost scales with it, at the new maximum, in the worst case (all fights contested), before shipping.

### Arena (the data source)
`PvPArenaStore` only exists once the Arena tab has been opened in game. Fields: elo, bestElo, duels, wins, losses, rank, attacksLeft/maxAttacks (10 a day), resetAt, opponents (10, within `band` = ±150 ELO, each with username, battling level, clone count and their own elo/record), `currentDuel`, `currentDuelCards` (cosmetic only - ship skin, social card, NOT stats).

A duel: `_id, created, attacker, defender, attackerName, defenderName, attackerElo, defenderElo, eloDelta, winner, logs`. The log uses the same action vocabulary as squadron battles (round, attacks, misses hit on, attack blocked, applies DoT, DoT triggers, focused, stuns, is stunned, dies, won) **and carries `hpLeft` as "[hp/maxhp]" on landed hits**, which squadron logs left empty.

So from the log alone: both sides' clone counts, max HP per clone, and damage per hit are exact. Inferred: precision and evasion (`rcFit` on hit rates), skill shares, and the crit profile (mode of the damage values is the plain hit, the rest are crits). The crit estimate absorbs DoT-boosted hits, so it runs a little high - a known approximation.

`recTick` records whatever duel is loaded, so fighting one files it, and so does opening any duel in Battlefield > Battle Log > Arena (the filter has an Arena toggle). **200 kept** (`AR_MAX`, was 40), about 290 bytes each, no names. Records are **v:3**: each fighter carries `q: [hits, swings, theirHits, theirSwings]`, which is what the error bar is built from. v:2 records (3.9.0) are still loaded — `arAssume()` reads them as if they came from `AR_ASSUME = 24` swings, so they carry more doubt than new ones rather than less. Do not silently drop a user's history again; they had 7 duels and the floor is 8. `a:1` marks a duel fought on a different build of yours - the opponent is still exact but the precision/evasion read off it is less reliable, because our own precision and evasion at that time are unknown.

Arena socket methods: `PvPArena.getArenaData`, `getOpponents`, `getDuel({duelId})` are READ-ONLY; **`attackPlayer` acts - never call it**. `getDuel` would allow automatic backfill, but the duel-list call was not resolved, so 3.9.0 relies on the user opening duels instead.

**Measured noise:** one duel gives precision and evasion to about ±400 and ±350 on a 20-duel synthetic test; the mean over 20 was within 7% of truth. That is the argument for accumulating duels, and why the floor sits at 8. `t/acc_unit.js` checks that the five-draw spread brackets the true precision about 80% of the time (vs 22% for the single best guess), that the error bar shrinks with more opponents, that an identical build never reads as an improvement, and that a free win is excluded from the contested set.

### Results on the user's real data
Current build is **within the optimal range**. Best free change ≈ +1.2 points; 500 random builds topped out near +1.5. Block on all four pieces was best against every opponent type tested. One gear level ≈ +3 points; tiers ≈ 0. Buying everything affordable with 5000 materials ≈ +43 points.

**Meta analysis (simulated against constructed opponent fields):** skills Block×4 always; gear split two power / two hull; stat points barely matter (±0.3 per 100 moved). Against high-evasion opponents, moving ~350 points into precision and evasion is worth 5–6 points, but that is not the enemy type this player meets.

## 6. Base and Laboratory model (Base tab)

State: `BaseBuildingStore.base` (stellarium, stellariumHourly, nextStellariumTick, modules[11] with name/level/tier/active/unlocked/uses/selection) and `LaboratoryStore` (`buildings[10]`, `base[4]` forges, `labQueue`). Efficiency = `UserStore.player.skills.base_module_efficiency_boost`, currently 100 which is the skill cap.

All of the following came out of the game's code and was then checked against what the game displays:

- **boost** = effLevel × (1 + tier/100) × (1 + efficiency/100), where effLevel is level/2 for the Quantum server and the Laboratory enhancer. This is the "Boost:" number on the card. Verified on all 8 modules that show one.
- **module output** = base × (1 + floor(boost/100)) guaranteed, plus a (boost mod 100)% chance of one more — so the **average is base × (1 + boost/100), perfectly linear**, and the game prints the guaranteed part only. Base rates: Material generator 200/h, Metal scrap 1500/h, Resource miner 20000/h, Fuel facility 5/h, Quantum server 4/h, Stellarium miner 1/drop. All six verified.
- **lab multiplier** = 2 + floor(enhancerBoost/100); 5 at boost 387, matching 5 per craft on all four running jobs. *Soft spot:* the exact rounding at the step was inferred from one observation; the next step is at boost 400 under either rule.
- **lab timer** = max(5, baseSeconds − level/10); base 30 s for the 10 buildings, 45 s for the 4 forges (`buildingMinQueueTime: 5`). Verified to the decimal at levels 0, 107, 168 and 250.
- **lab upgrade cost is CREDITS**: 1e6 × 1.15 × (triangle(to) − triangle(from)), `buildingUpgradeBaseCost: 1e6`. Max affordable via the quadratic inverse. (Beware magnitudes: 168→250 is 19.8 **billion**, ~30 h of this player's income, not trillion.)
- **module level cost** = (level+1) of each material in `uses`, banded ×1 to 600, ×2 to 1000, ×4 to 1500, ×8 to 1750, ×16 to 2000, ×64 above.
- **module tier cost** = tier N costs N stellarium, ×2 from tier 100 and doubling every 50. Confirmed by the user reading 1, 3, 6, 10 and by the dialog offering Max Tier 4 at 14 stellarium.
- **upkeep** ≈ 69.23K/h × (1 + boost/100) per module — it scales exactly like average output, so credits-per-unit never improves with upgrades. The 69.23K base drifts up slowly; cause unknown. Not shown in the tab.
- A tier's **percentage** gain rises with level and caps at 1%; its absolute gain is base rate × level × efficiency ÷ 10,000 per hour. Early tiers are far better value than late ones because tier N costs N.

**Tab ranking:** candidates scored by total fractional output gain, counting only lab buildings present in `labQueue` (otherwise every idle level-0 building looks like a bargain). Credits are treated as one purse, so only the first credit-funded row is offered. Top answer on the user's data: Laboratory enhancer 4 tiers for 10 stellarium (they hold 14) → every lab craft 5 → 6.

## 7. Performance and safety rules (learned the hard way in 3.7.3)

The live Pinia state is **55,537 objects** and one full `walk()` costs **~48 ms**. Before 3.7.3 a tick did 17 full walks = **749 ms every 10 s**. After: **0.95 ms**.

- **Never put a `walk()` of the whole state on the tick.** Read known addresses and keep a walk only as a fallback: `UserStore.player.droids`, `GatherStore.gathering_level`, `CurrencyStore.credits`, `UserStore.player.statistics`. `getByPath(root, 'a.b.c')` does a guarded read.
- Named counters remember where they were found (`cpaths`, persisted) — that alone was 11 of the 17 walks.
- `walk()` truncates at 60,000 nodes and the account is at 55,537, so anything still walking can silently lose data on a bigger account.
- **Guard every property read.** One throwing getter used to escape `refreshFromStore()` before `startStorePoll()` ran, so the script never polled while the panel still looked fine. Each stage now runs inside `stage()`; `render()` catches its own errors.
- Activity history keeps only counters that have moved (`seen0`, `movers`) plus resources and named ones: 839 KB → 112 KB on a realistic mock. Caps 150 samples, 120 days.
- Long computations run in `setTimeout` slices of ≤110 ms (`runNext`).

## 8. Testing

Everything below runs offline. **Nothing here touches the real game or its API**; the browser tests route `https://*.stellarodyssey.app/**` to an abort. The script is injected into a mock page (`#q-app` with a fake `__vue_app__` holding Pinia state) with a fake clock via `page.clock`.

Setup, once: `npm install` then `npx playwright install chromium`. If Chromium lives somewhere unusual, set `CHROMIUM=/path/to/chrome`. Run everything from the project root; `npm test` runs the fast node suites, `npm run test:browser` runs the Playwright ones.

Suites (all under `t/`, fixtures `t/root.json` and `t/real_rec.json`):

- `arena_unit.js` — the duel recorder against a synthetic duel of known truth: exact fields recovered exactly, inferred ones within tolerance.
- `acc_unit.js` — the 3.10.0 uncertainty machinery: five-draw spread brackets the truth, error bar shrinks with more duels, an identical build never reads as an improvement, settled fights are excluded, mangled records do not throw.
- `sim_equiv.js` — **the duel engine against the 3.10.1 relay engine**, 36,000 battles in six matchups, must be identical on winner, rounds and both health fractions.
- `cap_check.js` — planner with the search sample capped vs uncapped over five pools; must pick the same build or one inside the error bar. Slow (about a minute).
- `base_unit.js` — 21 base/lab numbers against what the game itself displays. Reads the SHIPPING script (see the trap below).
- `steps2.js`, `steps2_stress.js`, `slice_probe.js` — planner timing. `steps2_stress.js` is the worst case (every fight contested, 200 duels) and is the one that catches a freeze; `slice_probe.js` says where the time goes.
- `walkcount.js` (full state walks per 10 s tick, should be 1), `storage.js` (history size after 30 h, ~112 KB), `price.js` (droid-price socket path), `bench_sim.js` (engine speed), `audit_probe.js` (mutation, key cost, backlog).
- `e2e3.js` — full end to end; env `SCRIPT`, `PRE` (number of pre-recorded duels; the fixture mixes v:2 and v:3 so migration is exercised), `RW`, `FAST`, `NOLIVE`, `SCEN`, `GARBAGE`, `NOGROUPS`. Writes screenshots to `shots/`. `robust.js` — eight broken-state cases; run with `CASE=<name>` one at a time, the whole suite is slow.

Run node suites one at a time and not while a browser suite is live: contention gives spurious failures.

Traps that cost real time:

- **Tests must read the shipping script, never a loose fragment.** `base_unit.js` used to load a hand-extracted copy (`q/base.js`); it kept passing after a function it tested had been deleted from the real script, so "pass" meant nothing about what ships. Fixed in 3.11.0. If you add a unit test, slice the section out of `astrolabe.user.js` at run time (see how `acc_unit.js` does it), and slice on whole comment-block boundaries or eval will hit a syntax error.
- **The fake clock starves real async work.** Socket replies go through DecompressionStream, which needs REAL time, while `clock.runFor()` jumps the fake clock. Jump 10 s with only a few ms of real time and `socketCall`'s 6 s timeout fires first, so the droid price silently never lands. Give ~70 ms real per 10 s fake (`RW=70`). 3.7.3 "regressed" purely as an artefact of this.
- **A "pass" from a test you have not read the inputs of is not evidence.** When a number looks right, check it is reading the thing you think it is.

Expected live values for regression: PvP totals damage 25,072 and hp 179,088; base boosts 400/100/144/384/387; lab timers 5.0/13.2/34.3/45.0 s; lab craft ×5.

## 9. Other tools

`https://anfneub.github.io/StellarOdysseySim/` (by anfneub) is strong on PvE mob battling, the universe/node browser and a rune route planner — areas this script does not cover. Its PvP simulator is weaker: no block/stun/DoT, a damage formula that does not reproduce the game's own numbers, and a line-up sorted by precision which is wrong for battlefield fights. Nothing from it changed this script.

## 10. Version history

3.0.1–3.4.1 gathering, market, activity. 3.5.0 first Battle tab (mirror opponent — flawed). 3.7.0 Battle rebuilt: sub-tabs, recorder, relay simulator, threshold rule. 3.7.1 Spend box on Yield. 3.7.2 recorder fixes (squad-loaded guard, winner from log, real battle time). 3.7.3 performance and crash fixes (749 ms → 1 ms per tick, guarded reads, smaller history). 3.8.0 Base tab. 3.9.0 Battle tab moved onto arena duels; squadron recording removed, score became a win rate. 3.10.0 accuracy: a floor of 8 duels before any advice, settled fights ignored, each opponent carried as five plausible versions, win rate reported with an error bar, and a change offered only when it beats twice that bar. 3.10.1 renamed to Astrolabe, marked beta. 3.11.0 review pass: fixed the planner freeze that 3.10.0 introduced (992 ms → ~100 ms at 200 duels), replaced the relay engine with a proven-identical duel engine (1.6x), stopped planning from writing scratch fields onto saved duels, removed dead code, trimmed the model check.
