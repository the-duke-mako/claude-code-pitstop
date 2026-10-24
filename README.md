# PitStop for Claude Code

PitStop is a mod for the Claude Code desktop app that cuts how much of your usage goes on **re-reading long chats**.

A long chat is expensive in two ways. Every message re-reads the whole thing, and if you come back after more than an hour the cached copy has expired, so the whole chat is written again. This mod keeps a running checkpoint of each chat and, when re-reading would be wasteful, opens a **fresh chat from the checkpoint** instead. The new chat opens with the brief already typed in, and you press **Enter** to send it.

## How a move works now (one press)

Since Claude desktop app 2.1.304 (October 2026) a mod can no longer open a chat **and send to it** by itself. Opening a chat goes through the app's `start_session` tool, and the app now accepts that call only when a model request asked for it or when you typed the words yourself. A mod's call is neither. This is a deliberate safety rule, not a bug.

So PitStop now opens the new chat through the app's own link, `claude://code/new?q=…`. The app opens a new Code chat with the brief in the prompt box, **unsent**. Your Enter makes it your own message, which is all the app asks for. The brief is also copied to your clipboard and saved to `data/<session>.brief.md` as a backup. If it is longer than the link allows (about 14k characters), it goes by clipboard only: press ⌘N, paste, send.

<details>
<summary>What was tried before settling on this (app 2.1.304, October 2026)</summary>

| Try | Result |
| --- | --- |
| Call `start_session` from the mod | Refused: "auto mode classifier gave no verdict" |
| Call it through the mod's own `$.mcp.call` | Refused, same reason |
| Allow rule for `start_session` in `settings.json` | Not enough: the rule is not consulted for a call nobody asked for |
| Hold the message, show **Answer in a fresh chat**, pass the press as `consent` | Refused by the classifier in Auto mode |
| The same press outside Auto mode | The app asked to allow it, then the tool refused: "Start sessions only on the user's own words to you here" |
| Ask a model turn to make the call | Works, but that turn has to re-read the old chat first, so it saves nothing |
| Propose the session as a card (`initiation: "own_initiative"`) | Allowed, but three clicks per move |
| Brief to the clipboard, you click New and paste | Worked (the interim version) |
| **`claude://code/new?q=…` link** | **Works: one press.** Adding `&folder=` made the app ask "Trust this workspace?" every time, so the link leaves it out and the new chat opens in the last-used folder |

</details>

If you find a way to open a chat with fewer presses, please say so in [Discussions](https://github.com/the-duke-mako/claude-code-pitstop/discussions) (or an [issue](https://github.com/the-duke-mako/claude-code-pitstop/issues)).

## What it does

- **Checkpoints.** When a task wraps up in a chat of 200k tokens or more, the chat writes a handover note while its cache is still warm. After every reply, Haiku adds a one-line note to a running log.
- **Fresh chat after a break.** Come back to a chat of 100k+ after more than 60 minutes and the mod answers that turn itself (no request is sent to the model), opening a fresh chat with a brief: the latest checkpoint (if the chat reached 200k; otherwise just the running notes), the notes since, and your message. You press Enter there. The big chat is never re-read.
- **Fresh chat when a chat gets big.** Past 200k tokens you get a notice. Once the current task is finished, your next message opens a fresh chat the same way. Press **Dismiss** on the notice to keep the chat.
- **Sidebar grouping.** The brief ends with a short ask: the new chat files itself next to the old one in the sidebar. If the old chat is already in a group, the new chat joins it; otherwise both go into a group named after the project (the part of the chat title before " · "). A chat can't be nested under another after the fact, so a shared group is the nearest thing.
- **Handover written ahead.** When a new-topic or Opus notice appears, the chat writes its handover right away while its cache is warm (at most twice per chat), so **Start fresh chat** doesn't wait.
- **New-topic notice.** Haiku checks each message. If it is real work on a different project, the strip offers **Start fresh chat**.
- **Sonnet to Opus.** If a chat runs on Sonnet and Haiku is sure the job is design, a big build, client writing or planning, the mod switches that chat to Opus in place (**Undo** on the notice turns it off for that chat). Above 130k it offers a fresh chat on Opus instead, because a switch would re-read everything.
- **A strip above the prompt** showing model, chat size, last checkpoint and a rough savings counter.
- **Self-check** after an app update, so a changed API shows up as a warning instead of silently doing nothing.

Commands: `/pitstop` (status), `/pitstop-checkpoint` (write one now), `/pitstop-copy [message]` (put the same brief a move builds on your clipboard, any time), `/pitstop-test away N | size N | full N | early N | off` (try other thresholds for one chat).

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

## Setup

**macOS only.** The move uses `/usr/bin/open` for the app link and `printenv` to find the old chat's id.

Earlier versions asked you to add an allow rule for `mcp__ccd_session__start_session`. That rule is **no longer needed**: the mod doesn't call that tool any more, so you can remove it.

**Optional:** when the new chat moves the *old* chat into the sidebar group, the app asks you to approve it once per move. To skip that card, add this allow rule to `~/.claude/settings.json` yourself (the mod won't):

```json
{ "permissions": { "allow": ["mcp__ccd_sidebar__move_sessions"] } }
```

The trade-off: Claude can then move any chat between sidebar groups without asking. That is low risk, but it's your call.

## Honest status

This is a personal tool shared as-is, not a polished product.

- Built on the **Claude desktop app, build 2.1.299**; the one-press move and sidebar grouping were tested on **2.1.308**. It relies on the `claude-code` mod API, which changes between releases. The self-check warns when something stops working after an update.
- It assumes you start chats on **Sonnet** and escalate to **Opus**. The model id (`claude-opus-5-5`) and thresholds (`60 min`, `100k`, `130k`, `200k`) are constants at the top of `hooks/register.tsx`.
- The thresholds come from one person's usage, so treat them as a starting point.
- The savings percentage needs a few million calibration units before it shows `%`; until then it shows tokens.
- The new chat opens in the **last-used folder**, not necessarily the old chat's folder, because naming the folder in the link triggers a trust prompt every time.
- The "fresh chat once a big chat's task finishes" move is newer and has had less real-world testing than the away-from-chat move.
- Per-chat checkpoints, notes and a trace log are written under the mod's `data/` folder. They contain your chat content, so don't commit or share that folder (it is git-ignored here).
- A message like "thanks" sent after a finished task in a 200k+ chat also opens a fresh chat. Press Dismiss on the past-200k notice to opt a chat out.

## Credit

The control strip is in the spirit of [Effort Cycle](https://github.com/Anerco/claude-code-effort-cycle) (MIT) by Anerco.

## Licence

MIT. See `LICENSE`.
