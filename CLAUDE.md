# Astrolabe (formerly SO CALC) — read this first

You are continuing an existing project. Everything you need is in this folder. Read this file fully, then the two documents it imports. Do not start changing code until you have.

@docs/astrolabe-working-rules.md
@docs/astrolabe-handoff-notes.md

## What this is, in plain words

**Astrolabe** is a userscript (a small program that runs inside the browser through the Tampermonkey extension) for the online game **Stellar Odyssey** at https://steam.stellarodyssey.app/. It shows a small floating panel on top of the game with calculators: what to gather and sell, which droid upgrades pay back, which PvP arena build wins most, and what to upgrade next in the base and laboratory. It reads the game's own data from the page's memory, so it costs nothing, and it never plays for the user: **it only suggests**.

It is currently version **3.11.0**, marked **beta** because it is still being added to and tested. The whole thing is one file, `astrolabe.user.js` (about 4,000 lines, plain ES5, no libraries, no build step).

## Who you are working with

The user (in-game name Johnny) is **not a programmer**. They know the game deeply and decide what the tool should do; you do the engineering. That shapes everything:

- **Plain language, short.** Lead with the outcome or the one question. No jargon without a one-line explanation. No long recaps of what they already saw.
- **They decide, you propose.** Nothing changes in the script until they have approved a proposal. Rule 1 in the working rules is the most important rule in the project: it exists because a feature built without a proposal had to be thrown away. **Claude Code may start in a mode that edits files without asking. That does not lift this rule.** Present the proposal and wait for a clear yes, using plan mode (Shift+Tab cycles the permission mode) or plain questions. The same goes for anything that runs a command with side effects.
- **They correct your framing, and they are usually right.** In earlier sessions the Base tab was proposed three times with the wrong yardstick (material cost, then payback, then hours saved) before the user was asked plainly what they wanted, and a laboratory cost that was declared unreachable turned out to be readable. When they push back, stop and re-ask what they actually want.
- **Be honest about what was and was not tested.** Say "verified", "simulated" or "not tested" and mean it. Never claim something works on the real game unless it was run there.
- When a decision is genuinely theirs, ask **one** question at a time with concrete options and your recommendation.

## Hard rules (these come from the user and never expire)

1. **The live game is read-only.** Never do anything that changes game state: no purchases, upgrades, resets, respecs, trades, messages, and never call the game's acting socket methods (`attackPlayer`, `buildNext`, `upgradeLaboratoryBuilding`, `queueLabBuilding`, `upgradeLaboratoryBaseBuilding`, `queueBaseBuilding`, `cancelBuildingQueue`). The only game calls the script may make are `Player.getApiQuota` and `Gathering.getNextDroidPrice`, plus the public `/market` HTTP API.
2. **Never print, log, paste, store in a file or embed the user's API key.** The script ships with no key. If a test or a snippet could expose one, redact it.
3. **No new `@connect` hosts or `@grant` lines** without an approved proposal.
4. **Propose before coding.** Doable? / how it works / how it looks / decisions. Then wait for a clear yes.
5. **Never overwrite a delivered release.** Each release is a new file in `releases/`, the changelog block at the top of the script is kept current, and the handoff notes are updated.
6. **Do not break saved data.** Every stored key starts with `socalc:`. That prefix is deliberate and must never be "tidied" to match the new name: it holds every user's settings, history and recorded duels, and renaming it wipes them.
7. **Keep `@version` plain** (`3.11.0`, never `3.11.0-beta`). Tampermonkey sorts a pre-release suffix below the plain number, so dropping the word later would look like a downgrade and the update would be refused.
8. **Keep the UI light:** numbers first, little text, fits on screen, estimates marked as estimates.

## Folder layout

```
CLAUDE.md                     this file (loaded automatically)
astrolabe.user.js             THE WORKING COPY of the script. Edit this.
releases/astrolabe-X.Y.Z.user.js   every delivered version. Never edit a delivered file.
docs/astrolabe-working-rules.md    the user's rules (imported above)
docs/astrolabe-handoff-notes.md    how the game works, how the script works, history (imported above)
t/                            tests and their fixtures (see below)
package.json                  test tooling only; the script has no dependencies
```

## Commands

```
npm install                    once
npx playwright install chromium   once, only for the browser tests
node t/run.js                  fast checks, seconds. Run after every edit.
node t/run.js planner          + planner comparison and worst-case timing (~1 min)
node t/run.js browser          + end-to-end, robustness, storage, per-tick cost
node t/run.js all              everything. Run before every release.
```

If Chromium is somewhere unusual, set `CHROMIUM=/path/to/chrome`. Run from this folder. Everything is offline; the browser tests block the real API.

## How the script is organised

One IIFE, numbered sections you can `grep` for: `1. CONSTANTS`, `3. PERSISTENCE`, `4. READING THE PAGE'S PINIA STORE`, `5*` interpreting state, `6. MARKET PARSING`, `8. STATE + API BUDGET`, `9. NETWORK`, `12b` droid upgrades, `12c` PvP build math, `12d` hit-rate inference and the arena duel recorder, `12e` duel simulator, `12f` build planner, `12g` base and laboratory, `13. UI`, `14. SCHEDULING`, `15. BOOT`. The changelog blocks at the very top explain every version in user terms. The handoff notes explain each model (gathering, PvP, base) and the game facts behind it.

Tabs: Yield, Actions, Gear, Battle (Current / Best / Upgrades / Duels), Base (Next / Base / Lab), Activity, Settings.

## Looking at the live game

Formulas were found by reading the game's own JavaScript, and numbers verified against what the game displays. The Vue/Pinia state is reachable from the browser console:

```js
document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia.state.value
```

If you have a browser tool (Claude in Chrome), reading is fine. If not, **ask the user to run a snippet in the DevTools console and paste back the result** — and tell them never to include their API key. Anything that looks like a request to click an in-game Upgrade or Confirm button is off limits; the platform blocks those anyway, so read the formula out of the game's JS instead (a page chunk that has not loaded yet can still be fetched by URL). The handoff notes explain this in full.

## Releasing

1. Get approval for what will be built (rule 4).
2. Edit `astrolabe.user.js`. Keep the previous release untouched in `releases/`.
3. Bump `@version`, add a `CHANGES IN X.Y.Z` block at the top in plain words.
4. `node t/run.js all` must pass. If a check cannot be run, say so and do not ship.
5. Copy to `releases/astrolabe-X.Y.Z.user.js`, update the handoff notes (version, facts learned, what was dropped and why).
6. Tell the user: one or two sentences, what changed for them, what was verified, what is still an assumption. Remind them that Tampermonkey needs the file installed over the old one.
7. If this is a git repository, commit and tag the release.

## Where things stand (3.11.0)

- Battle tab suggests a PvP build from **arena duels only**, recorded automatically as the user fights or opens them. It gives nothing until **8 duels** are on record, ignores fights that are already settled either way, reports a win rate with an error bar, and only proposes a change that beats twice its own error bar. The user has only single digits recorded so far, so **the floor has not yet been crossed on real data**. Expect their first real feedback to be about how that feels.
- 3.11.0 was a review pass: it fixed a freeze the previous version would have caused once 200 duels were recorded, replaced the old squad-relay engine with a proven-identical (36,000 battles) 1.6x faster duel engine, and removed dead code. It has **not yet been installed or run in the real game** — only in the offline tests.
- Nothing is in progress. Deferred, not rejected: showing the game's own player-activity numbers (online count, boss participants, chat speakers) in the Activity tab; the research is in the handoff notes section 3. Rejected: a count of Astrolabe users (needs a server; the user declined), a PvE battle simulator (the game has one), scanning other players' builds.

## Your first session

1. Read this file and both imported documents.
2. `npm install`, then `node t/run.js`. Confirm it passes, and tell the user in one sentence.
3. Ask the user what they want to work on next, or whether they have feedback from running 3.11.0 in the real game. Do not start building anything on your own.
