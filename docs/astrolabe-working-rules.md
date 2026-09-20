# Astrolabe - working rules

These rules apply to every session on this project. A new Claude reads this file first, then `astrolabe-handoff-notes.md`.
They are the user's rules. Follow them even when a task looks small or obvious.

## 1. Propose first, code after approval

Nothing in the script changes until the user has approved a proposal in chat. This covers new features, changes to existing ones, bug fixes and refactors.

A proposal has four parts, in this order:

1. **Doable?** Yes, partly, or no. Say what the game lets us read, what would be estimated, and what cannot be known.
2. **How it works.** Plain words: what it calculates, what it uses as input, what it shows and what it does not.
3. **How it looks.** A sketch of the tab or section, using the user's real numbers where they are known. A text table or a static image is fine. No script edits to produce it.
4. **Decisions.** Every assumption or choice that would otherwise be made silently, each with a recommendation and the reason. Examples: what the default opponent is, what counts as "affordable", which numbers are estimates.

Then stop and wait.

- Approval means a clear yes ("approved", "go", "do it"). Questions, comments or "sounds good, but..." are not approval. Answer them and revise the proposal.
- Approval covers what was proposed. If the plan changes while building, stop and get approval for the change.
- Extra ideas found on the way go into the final message as suggestions. They are not built.
- The user may grant a narrow exception, for example "just fix typos without asking". It applies to that kind of change only, for that session only.
- If a request is ambiguous, ask one specific question with the options and a recommendation, rather than guessing.

## 2. The live game is read-only

- Inspecting https://steam.stellarodyssey.app/ through the browser tab is reading only. No clicks that change anything, no purchases, upgrades, resets, respecs, trades or messages.
- Opening a page to read it is fine. Sending a game request that changes state is not, even to test.
- The script itself only reads game state and calls the two allowed read-only calls: `Player.getApiQuota` and `Gathering.getNextDroidPrice`, plus the public /market API. Adding any other game call needs an approved proposal that names the call and says why it is safe.
- The script suggests. It never applies a suggestion for the user.
- Separately from this rule, the platform blocks any click on an in-game Upgrade or Confirm button, whatever the intent. Do not look for a way round it. When a number is only visible behind such a button, read the formula out of the game's JS (see the handoff notes) or ask the user to read the number off the panel.

## 3. Secrets and privacy

- Never print, log, paste into chat or embed the user's API key. Redact it in test output.
- The script ships with no key. A new user pastes their own in Settings, or the script reads it from their game account.
- Do not send the user's data anywhere except the two game API hosts already in `@connect`.
- Do not add new `@connect` hosts or `@grant` lines without an approved proposal.

## 4. Changes: small, scoped, reversible

- One concern per version. Do not mix a new feature with a rewrite of something unrelated.
- No drive-by refactors, renames or restyling. If something nearby looks wrong, report it.
- Work on a copy. Keep a backup of the previous version before editing.
- Never overwrite a delivered file. Each release is a new file named `astrolabe-X.Y.Z.user.js`.
- Versioning: patch (3.5.1) for fixes, minor (3.6.0) for a new feature or tab, major only for a breaking change to saved settings or layout.
- Every release adds an entry to the changelog block at the top of the script, in plain words, saying what changed for the user.
- Saved settings must keep working across versions. New settings get defaults. Removed ones are ignored, not crashed on.

## 5. Code habits

- Style matches the file: ES5, one IIFE, no build step, no external libraries, no new dependencies.
- Read the surrounding code before adding to it. Reuse existing helpers (`tile`, `tbl`, `kvs`, `line`, `sect`, `field`, `store`) instead of writing new ones.
- Read defensively. Game data can be missing or change shape. Wrap reads in try/catch, fall back to "not readable yet" and never throw into the game page.
- Never block the page. Heavy work runs after the tab has drawn (for example `setTimeout`), and results are cached until their inputs change.
- Respect quotas. Do not add calls that spend the 50/day public API budget. Socket calls need a reason and a sensible interval.
- Keep the UI light: numbers first, little text, no debug or raw-data views. Anything that is an estimate must be visibly marked or stated as one.
- Comments explain why, not what. Game formulas get a one-line note on where they come from.
- No dead code, no leftover console logging, no test hooks in the delivered script.

## 6. Verify before delivering

Do the checks that fit the change, and say which ones were done.

1. Syntax check (`node --check`).
2. Unit checks for any new math, against numbers the game itself shows. Example: computed totals must match the totals on the game page.
3. Run the real script end to end in a mock page (Playwright, aborted network to the real API). No console errors other than the expected blocked requests.
4. Look at screenshots in light and dark mode, and at phone-narrow width if the layout changed.
5. Regression pass: the other tabs still render, settings still load, nothing that worked before broke.
6. Edge cases: missing data, zero values, an empty list, a large number.
7. Where data can be read from the live game, compare against it.

Report honestly:

- **Verified** means it was checked against real game data or an exact formula.
- **Simulated / estimated** means it follows an assumed rule. Say which.
- **Not tested** means say so. Never claim "tested on the real page" unless the script was actually run there.
- If a check fails, fix it or say plainly that it is still failing. Do not deliver around it.

## 7. Bugs

1. Reproduce it, or say that it could not be reproduced.
2. Find the root cause. Do not patch symptoms.
3. Describe cause and fix to the user. Wait for the OK (rule 1).
4. Fix, add a check that would have caught it, run the regression pass.
5. Changelog line: what was wrong, in user terms.

## 8. Communication

- Short and plain. Lead with the outcome or the question. No recap of what the user already saw.
- When delivering: one or two sentences, the file, what changed for the user, what was and was not verified, and any assumption they should know about.
- State assumptions and uncertainty when they matter. Do not bury them and do not overstate.
- Ask at most one question at a time, and only when blocked or when a decision is truly the user's.
- Do not describe internal file paths or tooling to the user unless they ask.

## 9. Keeping the handoff current

At every release, update `astrolabe-handoff-notes.md`: version, new game facts learned, formulas, what was built, what was dropped and why, and open questions. A new Claude should be able to continue from these two files plus the latest script, with nothing else.

## 10. Definition of done

A change is done only when all of these are true:

- The user approved the proposal, and what was built matches it.
- New version file created, previous one untouched, changelog updated.
- Verification (rule 6) run, with results reported honestly.
- No secrets in the script or the chat.
- Handoff notes updated.
- The delivery message states what changed, what is verified, what is estimated, and any decision that is still open.

## 11. Lessons from this project

- The Battle tab (3.5.0) was built without a proposal and had to be rebuilt in 3.7.0. That is the origin of rule 1.
- The user once interrupted a request that bundled two ideas (building a plan, and scanning other players). Keep proposals to one idea each, and list bundled extras separately so the user can pick.
- Output filters in the tool environment can block certain characters and long tokens. Sanitize test output, and never print the key.
- 3.7.3 found that the script had been doing 17 full searches of the game's memory on every tick, 749 ms every 10 s, while a comment in the same function claimed "under a millisecond". Measure the cost of anything that runs on the tick against the LIVE state before believing a comment, and never let a convenience helper that scans everything end up in a loop.
- When a version comparison shows a difference, find the mechanism before calling it a regression OR a harness artefact. In 3.7.3 the missing droid price looked like a real bug for three runs; the actual cause was the fake clock, proved by a standalone test of just that path.
- 3.8.0: when a cost looks server-side, check the lazily-loaded page chunk before giving up. `LaboratoryPage-*.js` never loads until its dialog opens, but fetching it by URL from the asset directory is an ordinary read and it held the formula. Also: arithmetic slips are expensive - 1e6 x 1.15 x 17,179 was reported as 19.8 trillion when it is 19.8 billion, which turned a 30-hour goal into a fictional 3.5-year one. Check magnitudes before drawing a conclusion from them.
- Ask what the user actually wants before designing the metric. The Base tab was proposed three times with the wrong yardstick (material cost, then payback, then hours saved) before asking plainly; the answer was throughput, and one question would have saved all three.
- 3.10.0 raised the stored-duel cap from 40 to 200 and nobody re-measured the planner, which then froze the game page for up to a second at the new maximum. Any time a limit that controls how much data exists is raised, re-measure everything that scales with it, at the new maximum and in the worst case.
- 3.11.0: when you replace an expensive computation with a cheaper one (a sample, an approximation, a rewrite), do not just time it. Compare the OUTPUT: same builds picked, same numbers, over several different inputs. The first version of the capped search looked fine on 4 of 5 pools and quietly lost 2.5 points on the fifth; the cause (the close-call finalists were being settled on the sample) only showed up because the outputs were compared.
- 3.11.0: a unit test that reads a loose copy of the code instead of the shipping file can keep passing after the real code changes. Tests read the shipping script.
- A tool that fails is not a test that passes. When the shell was unavailable mid-release, the right move was to say plainly that nothing was verified and not to ship; the release went out only after every check had run.
