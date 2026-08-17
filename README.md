<div align="center">

<img src="https://cdn.jsdelivr.net/gh/L2ncE/pi-recap@main/img/logo.svg" alt="pi-recap" width="280"/>

**A session recap for [pi](https://pi.dev) — one line, always in the know.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/L2ncE/pi-recap/actions/workflows/ci.yml/badge.svg)](https://github.com/L2ncE/pi-recap/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)

</div>

## What Is This

pi-recap shows a single status line above the status bar that answers
*"where was I?"* — the session goal, the current state, and the one next
action. It updates automatically as you work, and stays put when nothing
actually changed.

Inspired by Claude Code's `/recap`, rebuilt natively for pi. The recap is a
pure UI widget: it never enters the model context.

![pi-recap in action](https://cdn.jsdelivr.net/gh/L2ncE/pi-recap@main/img/img.png)

## Install

```bash
pi install npm:@lanlance/pi-recap
```

or via git:

```bash
pi install git:https://github.com/L2ncE/pi-recap
```

or drop `extensions/recap.ts` into `~/.pi/agent/extensions/` and run
`/reload`.

## Usage

Nothing to do — after 3 turns the recap appears on its own.

```
※ recap: Memoized Fibonacci script with CLI args; README next
```

* `/recap` — regenerate the recap right now
* the recap follows the language of your session
* it survives `/resume` — the last recap comes back with the session

## Configuration

All optional. Add a `recap` block to `~/.pi/agent/settings.json`
(or `.pi/settings.json` for per-project overrides):

```json
{
  "recap": {
    "model": "deepseek-v4-flash",
    "maxWords": 25,
    "placement": "above",
    "prompts": {
      "recap": "Output only one phrase, at most 25 words."
    }
  }
}
```

| key          | default                 | description                                        |
|--------------|-------------------------|----------------------------------------------------|
| `model`      | current session model   | `provider/model` used for generation               |
| `maxWords`   | `25`                    | word budget; prompt and truncation follow it       |
| `minTurns`   | `3`                     | user messages required before auto-generation starts |
| `cooldownTurns` | `3`                  | regenerate only every N `agent_end` turns; `1` = every turn |
| `similarityThreshold` | `0.7`        | fresh recap with ≥ this word overlap keeps the displayed one |
| `placement`  | `"below"`               | `"below"` = between editor and status bar, `"above"` = above the editor |
| `prompts.recap` | built-in             | custom system prompt, replaces the built-in one    |

If the configured model is missing or unauthenticated, pi-recap falls
back to your session model. A bare model id (e.g. `deepseek-v4-flash`)
is resolved against your current session model's provider.

**Other status-bar extensions?** pi gives extensions only two layout areas
(above/below the editor). If another extension claims the same area — e.g.
pi-powerline-footer — set `placement: "above"`, and to render the recap
above that extension's status line, put pi-recap first in the `packages`
array of `settings.json`. Disable its last-prompt echo with
`"showLastPrompt": false`.

## How It Works

```
agent_end ─► goal (first prompt) + last 3 rounds
              │
              ├─ ≥ minTurns turns?  (else skip)
              ├─ cooldown cooldownTurns (else skip)
              ├─ latest-round key changed? (else skip)
              ├─ generate (≤256 tokens, minimal reasoning)
              ├─ similar to shown? (≥ similarityThreshold overlap → keep shown)
              └─ render widget + persist
```

Small by design: the input is the session goal plus the last 3 rounds,
truncated — about 1-2k tokens per call, fractions of a cent.

## Credits

- Inspired by [Claude Code](https://docs.anthropic.com/en/docs/claude-code)'s `/recap` command
- Special Thanks: [LinuxDO](https://linux.do/)

## License

Apache License 2.0 — [L2ncE](https://github.com/L2ncE)
