// One command for the whole test suite, the same on Windows, macOS and Linux.
//
//   node t/run.js            fast checks only (a few seconds; run after every edit)
//   node t/run.js planner    + planner comparison and worst-case timing (about a minute)
//   node t/run.js browser    + the Playwright suites (needs `npx playwright install chromium`)
//   node t/run.js all        everything: run this before a release
//
// Run from the project root. Steps run one at a time on purpose: running a
// node suite while a browser suite is live gives spurious failures.
//
// Nothing here touches the real game or its API.

const { spawnSync } = require('child_process');

const FAST = [
  { name: 'syntax check',                 cmd: ['--check', 'astrolabe.user.js'] },
  { name: 'duel recorder (arena_unit)',   cmd: ['t/arena_unit.js'] },
  { name: 'uncertainty (acc_unit)',       cmd: ['t/acc_unit.js'] },
  { name: 'base + lab (base_unit)',       cmd: ['t/base_unit.js'] },
  { name: 'engine == 3.10.1 (sim_equiv)', cmd: ['t/sim_equiv.js'] },
];

const PLANNER = [
  { name: 'capped search picks the same build (cap_check)', cmd: ['t/cap_check.js'] },
  { name: 'worst-case planner timing (steps2_stress)', cmd: ['t/steps2_stress.js'],
    // the freeze this guards against: one slice that holds the page for most of a second
    check: (out) => {
      const m = /longest slice (\d+)ms/.exec(out);
      if (!m) return 'no timing line in the output';
      return +m[1] > 250 ? 'longest slice ' + m[1] + ' ms, over the 250 ms limit' : null;
    } },
];

const ROBUST_CASES = ['empty', 'nulls', 'wrongTypes', 'cyclic', 'throwers', 'brokenBase', 'brokenArena', 'partialBattle'];
const BROWSER = [
  { name: 'state walks per tick (walkcount)', cmd: ['t/walkcount.js'] },
  { name: 'history size after 30 h (storage)', cmd: ['t/storage.js'] },
  { name: 'droid price path (price)', cmd: ['t/price.js'] },
  { name: 'end to end, 9 recorded duels (e2e3)', cmd: ['t/e2e3.js'], env: { PRE: '9', RW: '70' },
    check: (out) => /ERRORS:\s*\n((?:console\.error: Failed to load resource: net::ERR_FAILED\s*\n?)*)\s*$/.test(out.slice(out.lastIndexOf('ERRORS:')))
      ? null : 'console errors other than the expected blocked requests' },
].concat(ROBUST_CASES.map((c) => ({ name: 'robustness: ' + c, cmd: ['t/robust.js'], env: { CASE: c } })));

const which = process.argv[2] || 'fast';
const plan = FAST.slice();
if (which === 'planner' || which === 'all') plan.push(...PLANNER);
if (which === 'browser' || which === 'all') plan.push(...BROWSER);

let failed = 0;
for (const step of plan) {
  process.stdout.write(step.name.padEnd(52) + ' ');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, step.cmd, {
    encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, step.env || {}),
  });
  const out = (r.stdout || '') + (r.stderr || '');
  let why = r.status === 0 ? null : 'exit ' + r.status + (r.error ? ' (' + r.error.message + ')' : '');
  if (!why && step.check) why = step.check(out);
  const secs = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  if (why) {
    failed++;
    console.log('FAIL  ' + secs + '\n    ' + why);
    console.log(out.split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-6).map((l) => '    | ' + l).join('\n'));
  } else console.log('ok    ' + secs);
}
console.log('\n' + (failed ? failed + ' STEP(S) FAILED' : 'all ' + plan.length + ' steps passed'));
process.exit(failed ? 1 : 0);
