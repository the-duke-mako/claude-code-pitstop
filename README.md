# PitStop for Claude Code

PitStop is a mod for the Claude Code desktop app that cuts how much of your usage goes on **re-reading long chats**.

A long chat is expensive in two ways. Every message re-reads the whole thing, and if you come back after more than an hour the cached copy has expired, so the whole chat is written again. This mod keeps a running checkpoint of each chat and, when re-reading would be wasteful, opens a **fresh chat from the checkpoint** instead.

## What it does

- **Checkpoints.** When a task wraps up in a chat of 200k tokens or more, the chat writes a handover note while its cache is still warm. After every reply, Haiku adds a one-line note to a running log.
- **Fresh chat after a break.** Come back to a chat of 100k+ after more than 60 minutes and the mod answers that turn itself (no request is sent to the model), opening a fresh chat from the latest checkpoint (if the chat reached 200k; otherwise just the running notes) plus the notes since, with your message. The big chat is never re-read.
- **Fresh chat when a chat gets big.** Past 200k tokens you get a notice. Once the current task is finished, your next message opens a fresh chat the same way. Press **Dismiss** on the notice to keep the chat.
- **New-topic notice.** Haiku checks each message. If it is real work on a different project, the strip offers **Start fresh chat**.
- **Sonnet to Opus.** If a chat runs on Sonnet and Haiku is sure the job is design, a big build, client writing or planning, the mod switches that chat to Opus in place (**Undo** on the notice turns it off for that chat). Above 130k it offers a fresh chat on Opus instead, because a switch would re-read everything.
- **A strip above the prompt** showing model, chat size, last checkpoint and a rough savings counter.
- **Self-check** after an app update, so a changed API shows up as a warning instead of silently doing nothing.

Commands: `/pitstop` (status), `/pitstop-checkpoint` (write one now), `/pitstop-test away N | size N | full N | early N | off` (try other thresholds for one chat).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pitstop --marketplace the-duke-mako/claude-code-pitstop
```

or from a shell:

```
claude plugin install pitstop --marketplace the-duke-mako/claude-code-pitstop
```

To run it from a clone while you tinker, list the folder in `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`) or start a session with `claude --plugin-dir <folder>`.

## One setup step you must do yourself

Opening a fresh chat from a mod needs the `start_session` tool, and the mod answers that turn without a model request. Auto mode's safety check gives no verdict for a call no model produced, so it blocks it. The fix is an allow rule that **you** add to `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__ccd_session__start_session"] } }
```

Know the trade-off before you add it: this rule also lets Claude open new chats without auto mode's check. The mod will not add the rule for you.

## Honest status

This is a personal tool shared as-is, not a polished product.

- Built and used on the **Claude desktop app, build 2.1.299**. It relies on the `claude-code` mod API, which changes between releases. The self-check warns when something stops working after an update.
- It assumes you start chats on **Sonnet** and escalate to **Opus**. The model id (`claude-opus-5-5`) and thresholds (`60 min`, `100k`, `130k`, `200k`) are constants at the top of `hooks/register.tsx`.
- The thresholds come from one person's usage, so treat them as a starting point.
- The savings percentage needs a few million calibration units before it shows `%`; until then it shows tokens.
- The "fresh chat once a big chat's task finishes" move is newer and has had less real-world testing than the away-from-chat move.
- Per-chat checkpoints, notes and a trace log are written under the mod's `data/` folder. They contain your chat content, so don't commit or share that folder (it is git-ignored here).
- A message like "thanks" sent after a finished task in a 200k+ chat also opens a fresh chat. Press Dismiss on the past-200k notice to opt a chat out.

## Credit

The control strip is in the spirit of [Effort Cycle](https://github.com/Anerco/claude-code-effort-cycle) (MIT) by Anerco.

## Licence

MIT. See `LICENSE`.
