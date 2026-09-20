# Starting Astrolabe in Claude Code (for you, not for Claude)

This folder is the whole project: the script, every release, the tests, and the notes that let a fresh Claude pick up exactly where we left off. You do not need to read the code.

## 1. Install Claude Code (once)

You need a Claude Pro, Max, Team or Enterprise account (or a Console account with credits). Then open a terminal and run the line for your system:

- **Windows PowerShell:** `irm https://claude.ai/install.ps1 | iex`
- **macOS, Linux, WSL:** `curl -fsSL https://claude.ai/install.sh | bash`
- Also available through Homebrew (`brew install --cask claude-code`) and WinGet (`winget install Anthropic.ClaudeCode`).

Check it worked with `claude --version`. On Windows, installing [Git for Windows](https://git-scm.com/downloads/win) as well is recommended. If the terminal is new to you, the official quickstart is at https://code.claude.com/docs/en/quickstart.

## 2. Put the project somewhere and open it

Unzip this folder somewhere you will keep it (for example `Documents\astrolabe`). Then in the terminal:

```
cd path\to\astrolabe
npm install          (only if you want to run the tests; needs Node.js from nodejs.org)
claude
```

The first time, `claude` asks you to sign in through your browser.

## 3. Your first message

Paste this, exactly:

> Read CLAUDE.md and both documents in docs/. Then run the fast tests and tell me in plain words what this project is, what version it is at, and what is still open. Do not change anything yet. Ask me what I want to work on next.

`CLAUDE.md` is loaded automatically, so Claude already knows the rules, but this makes it prove it and check that everything still passes on your machine.

## 4. Two things to do so it keeps following your rules

- **Keep it in plan mode when you want a proposal.** Claude Code may start in a mode where it edits files without asking. Your rule is "propose first, code after I say yes". Press **Shift+Tab** to cycle the mode until it says plan mode, or just tell it: "Propose first, do not edit anything until I say go." It has been told this in `CLAUDE.md`, but the mode is yours to control.
- **Never paste your API key** into the conversation, and if it ever asks for it, say no. The script does not need it in the chat.

## 5. Installing a new version in the game

Same as before: install the new `.user.js` from `releases/` in Tampermonkey. **3.11.0 has not been run in the real game yet** (only in tests), so tell Claude what you see. If you still have the old "SO CALC" entry, delete it, otherwise two panels run at once (the rename in 3.10.1 made Tampermonkey treat Astrolabe as a new script). Your settings, history and recorded duels carry over on their own.

## What to test in the game first

1. Open Astrolabe, go to **Battle > Duels**. It should count down to 8 recorded duels.
2. Fight or open some arena duels (Battlefield > Battle Log > Arena). They are recorded on their own.
3. Once you pass 8, look at **Battle > Best** and tell Claude whether the verdict and the ± feel right.
4. Keep the game open a while and tell Claude if the page ever stutters. It should not; that is what 3.11.0 fixed.

## Where things are

- `CLAUDE.md` is what Claude reads first. `docs/` holds the rules and the full handoff notes.
- `astrolabe.user.js` is the working script. `releases/` has every delivered version.
- `node t/run.js` runs the tests. `node t/run.js all` is the full pre-release check.
