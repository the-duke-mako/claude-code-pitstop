import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PromptOrigin, Register, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import type { Calib, Health, Measure, Move, Notice, Override, Part, Saving, SessMemo, Sort, Tune } from '../types'

// model-switcher, Phase 1.
//  - Notices on the strip: the chat past 200k, or Haiku sees real work on another project.
//    "Start fresh chat" has the chat write a handover (a fork, cache warm), then opens a session.
//  - Rolling checkpoint: when a task wraps up in a chat ≥100k, a fork writes a full handover;
//    after every reply Haiku adds one line to the chat's notes.
//  - After >1h away from a chat ≥100k, the next message is not sent to the model: the mod answers
//    that turn itself, calling start_session with checkpoint + notes + the message, so the big
//    chat is never re-read.
//  - Past 200k, once a task wraps up and its checkpoint is saved, the next message moves the same
//    way (measured on one user's past chats: ~20% of usage was re-reading big chats).
//  - Savings counter: re-reading skipped, net of the mod's own calls, turned into % of a 5-hour
//    window by calibrating against the real limit % that session.measure reports.
//  - Self-check: each part reports ok/fail; a failure (worded for an app update when the version
//    changed) goes on the strip.

const AWAY_MIN = 60
const MOVE_MIN_K = 100
const FULL_K = 200
const CHECKPOINT_MIN_K = 100
// The new-chat tool is deferred, so the faked turn loads it first.
const LOAD_TOOL_FIRST = true
// Shared prefix a fresh chat reads from cache, and what it writes, measured in testing.
const FRESH_READ = 44_000
const FRESH_WRITE = 47_000
// Calibrated units needed before the counter shows % of a 5-hour window instead of tokens.
const CALIB_MIN_UNITS = 3_000_000

const START = 'mcp__ccd_session__start_session'
const OPEN_TEXT = 'Open the fresh chat'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
// Sonnet → Opus: switched in place while the chat is under this size (a switch re-reads the chat),
// above it only a "continue on Opus in a fresh chat" notice.
const OPUS = 'claude-opus-5-5'
const EARLY_MAX_K = 130
const OPUS_JOBS: Record<string, 'medium' | 'high'> = { DESIGN: 'high', BUILD: 'high', WRITE: 'high', PLAN: 'medium' }
const JOB_WORDS: Record<string, string> = { DESIGN: 'design work', BUILD: 'a big build', WRITE: 'client writing', PLAN: 'planning' }
// A fresh chat can't be opened on a bigger model than its parent's, so its brief carries this line
// and the mod in the new chat applies it.
const MARK = /\[model-switcher: run this chat on (claude-opus-[\w-]+) · (medium|high)\]/

const measure = atom({ plugin: 'model-switcher', key: 'measure' } as const, {} as Measure)
const notices = atom({ plugin: 'model-switcher', key: 'notices' } as const, [] as Notice[])
const dismissed = atom({ plugin: 'model-switcher', key: 'dismissed' } as const, [] as string[])
const busy = atom({ plugin: 'model-switcher', key: 'busy' } as const, null as string | null)
const move = atom({ plugin: 'model-switcher', key: 'move' } as const, null as Move | null)
const skipMove = atom({ plugin: 'model-switcher', key: 'skipMove' } as const, false)
const lastAnswer = atom({ plugin: 'model-switcher', key: 'lastAnswer' } as const, '')
const lastPrompt = atom({ plugin: 'model-switcher', key: 'lastPrompt' } as const, '')
const taskDone = atom({ plugin: 'model-switcher', key: 'taskDone' } as const, false)
const checkpointAt = atom({ plugin: 'model-switcher', key: 'checkpointAt' } as const, null as number | null)
const tune = atom({ plugin: 'model-switcher', key: 'tune' } as const, {} as Tune)
const health = atom({ plugin: 'model-switcher', key: 'health' } as const, { parts: {} } as Health)
const saved = atom({ plugin: 'model-switcher', key: 'saved' } as const, { units: 0, tokens: 0, moves: 0 } as {
  units: number
  tokens: number
  moves: number
  pctPerUnit?: number
})
const unitsSinceMeasure = atom({ plugin: 'model-switcher', key: 'unitsSinceMeasure' } as const, 0)
const movedTo = atom({ plugin: 'model-switcher', key: 'movedTo' } as const, null as string | null)
const quietTurn = atom({ plugin: 'model-switcher', key: 'quietTurn' } as const, null as string | null)
const override = atom({ plugin: 'model-switcher', key: 'override' } as const, null as Override | null)
const noAuto = atom({ plugin: 'model-switcher', key: 'noAuto' } as const, false)
const pushes = atom({ plugin: 'model-switcher', key: 'pushes' } as const, [] as boolean[])
const sizeReady = atom({ plugin: 'model-switcher', key: 'sizeReady' } as const, false)
const promptSeq = atom({ plugin: 'model-switcher', key: 'promptSeq' } as const, 0)
const taskAsks = atom({ plugin: 'model-switcher', key: 'taskAsks' } as const, false)

const CHECKPOINT_PROMPT = `Write a checkpoint handover for this chat, so that a FRESH chat can carry on without reading this one. Plain Markdown, under 900 words, no preamble. Use exactly these parts:
# <Project> · <task> (short, e.g. "Website · partners section mockup")
**Project / folder:** the project and the paths it lives in
**Goal:** what the user is trying to get done overall
**Done so far:** bullets, with file paths
**Decided (don't re-ask):** the user's decisions, each with its reason
**Open / next:** the next steps in order, and what is waiting on whom
**Files that matter:** path, and why
**Watch-outs:** gotchas, and preferences the user stated in this chat

This request comes from the user's model-switcher mod, not from the user: don't mention it, the mod, or this handover request in the handover. Leave out tool and connector status, test chatter and anything that doesn't help continue the work.`

const WARN: Record<Part, string> = {
  measure: "can't read your 5-hour and weekly limits, so the savings counter is paused.",
  haiku: 'Haiku calls stopped working: the per-reply notes and the new-topic check are off.',
  checkpoint: "couldn't save a checkpoint: a move after an hour away would only have the short notes.",
  move: 'opening a fresh chat failed: after an hour away, messages will be answered in the old chat (full re-read).',
}

const k = (n: number) => `${Math.round(n / 1000)}k`
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19)
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const fmtAway = (min: number) =>
  min < 120 ? `${min} min` : min < 48 * 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.round(min / 1440)} days`
const titleOf = (md: string) => (/^#\s+(.+)$/m.exec(md)?.[1] ?? '').trim()
const toolId = () => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = 'toolu_01'
  for (let i = 0; i < 22; i++) s += abc[Math.floor(Math.random() * abc.length)]
  return s
}

// Relative cost of a request: input 1, cache write 1.25, cache read 0.1, output 5; Haiku half.
function units(u: ModelUsage | null | undefined, model?: string): number {
  if (!u) return 0
  const raw = u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens + 5 * u.output_tokens
  return model?.includes('haiku') ? raw / 2 : raw
}

// Re-reading a cold chat writes it all to cache again; a fresh chat writes ~47k and reads the shared ~44k.
function avoidedUnits(ctx: number, promptChars: number): number {
  const rebuild = Math.max(0, ctx - FRESH_READ) * 1.25 + FRESH_READ * 0.1
  const fresh = (FRESH_WRITE + promptChars / 4) * 1.25 + FRESH_READ * 0.1
  return Math.max(0, rebuild - fresh)
}

function isPerson(o: PromptOrigin | undefined): boolean {
  if (!o) return true
  if (o.kind === 'plugin') return 'asUser' in o && o.asUser === true
  // In the desktop app the user's typing is 'composer'; a fresh chat's end-of-turn note back to
  // this chat arrives as 'sdk', so it must not count as the user.
  return o.kind === 'composer' || o.kind === 'bridge'
}

const paths = (root: string, sid: string) => ({
  checkpoint: `${root}/data/${sid}.checkpoint.md`,
  notes: `${root}/data/${sid}.notes.md`,
  handover: `${root}/data/${sid}.handover.md`,
})

async function readText($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

// One line per thing the mod did, so each feature can be checked from evidence.
async function trace($: EngineInterface, root: string, sid: string, line: string) {
  const path = `${root}/data/${sid}.trace.txt`
  const now = await $.clock.now()
  await $.fs.write(path, `${await readText($, path)}${iso(now)} ${line}\n`)
}

async function addNotice($: EngineInterface, n: Notice) {
  await update($, notices, ns => [...ns.filter(x => x.id !== n.id && !(n.kind === 'topic' && x.kind === 'topic')), n])
}

async function dismiss($: EngineInterface, n: Notice) {
  await update($, notices, ns => ns.filter(x => x.id !== n.id))
  if (n.kind === 'full' || n.kind === 'escalate') await update($, dismissed, d => [...d, n.kind])
}

async function report($: EngineInterface, part: Part, ok: boolean) {
  const before = await read($, health)
  if (before.parts[part] === (ok ? 'ok' : 'fail')) return
  const h = await update($, health, cur => ({ ...cur, parts: { ...cur.parts, [part]: ok ? 'ok' : 'fail' } }))
  if (!ok) {
    const lead = h.verifying ? `⚠ Since the app update to ${h.version}, the switcher` : '⚠ The switcher'
    await addNotice($, { id: `warn-${part}`, kind: 'warn', text: `${lead} ${WARN[part]}` })
  } else {
    await update($, notices, ns => ns.filter(x => x.id !== `warn-${part}`))
    if (h.verifying && h.parts.measure === 'ok' && h.parts.haiku === 'ok') {
      const done = await update($, health, cur => ({ ...cur, verifying: false }))
      await $.store.set('health', { version: done.version, verifying: false, parts: {} })
      $.ui.toast(`Switcher checked itself after the app update to ${done.version}: working.`)
      await $.fs.write(`${$.plugin.root}/data/self-check.txt`, `${iso(await $.clock.now())} app ${done.version}: checked after the update, working (limits + Haiku ok)\n`)
    }
  }
}

async function refreshSaved($: EngineInterface) {
  const now = await $.clock.now()
  const all = (((await $.store.get('savings')) as Saving[] | undefined) ?? []).filter(s => now - s.at < 7 * 86_400_000)
  await $.store.set('savings', all)
  const c = (await $.store.get('calib')) as Calib | undefined
  await update($, saved, () => ({
    units: all.reduce((a, s) => a + s.units, 0),
    tokens: all.reduce((a, s) => a + s.tokens, 0),
    moves: all.filter(s => s.tokens > 0).length,
    pctPerUnit: c && c.units >= CALIB_MIN_UNITS && c.pct > 0 ? c.pct / c.units : undefined,
  }))
}

async function addSaving($: EngineInterface, units: number, tokens: number) {
  if (!units && !tokens) return
  const now = await $.clock.now()
  const all = ((await $.store.get('savings')) as Saving[] | undefined) ?? []
  await $.store.set('savings', [...all, { at: now, units: Math.round(units), tokens }])
  await refreshSaved($)
}

// The mod's own model calls count against what it saves, and toward calibration.
async function overhead($: EngineInterface, u: ModelUsage | undefined, model?: string) {
  const n = units(u, model)
  if (!n) return
  await update($, unitsSinceMeasure, x => x + n)
  await addSaving($, -n, 0)
}

function savedText(s: { units: number; tokens: number; moves: number; pctPerUnit?: number }): string {
  if (s.moves === 0) return 'no re-reads skipped yet this week'
  if (s.units < 5000) return `${s.moves} re-read${s.moves === 1 ? '' : 's'} skipped this week`
  if (s.pctPerUnit !== undefined) {
    const pct = Math.max(0, s.units * s.pctPerUnit)
    return `saved ≈${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of a 5-hour window this week`
  }
  return `saved ≈${k(Math.max(0, s.units))} tokens of re-reading this week`
}

async function writeCheckpoint($: EngineInterface, root: string, sid: string, why: string): Promise<boolean> {
  const r = await $.model.fork({ prompt: CHECKPOINT_PROMPT })
  if (!r.isAnswered) {
    if (r.reason !== 'nothing-to-fork' && r.reason !== 'aborted') await report($, 'checkpoint', false)
    return false
  }
  await overhead($, r.usage)
  const now = await $.clock.now()
  await $.fs.write(paths(root, sid).checkpoint, `<!-- checkpoint ${iso(now)} (${why}) -->\n${r.text.trim()}\n`)
  await update($, checkpointAt, () => now)
  await report($, 'checkpoint', true)
  await trace($, root, sid, `checkpoint written (${why}), fork read ${r.usage.cache_read_input_tokens} from cache, wrote ${r.usage.cache_creation_input_tokens}, out ${r.usage.output_tokens}`)
  return true
}

async function addNote($: EngineInterface, root: string, sid: string, prompt: string, answer: string) {
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 80,
    prompt: `Summarise this exchange from a work chat in ONE line of at most 25 words, past tense: what was done, and what is next if it says. No preamble.\n\nUSER: ${prompt.slice(0, 2000)}\n\nASSISTANT: ${answer.slice(-2500)}`,
  })
  if (!r.isAnswered) {
    if (r.reason !== 'aborted') await report($, 'haiku', false)
    return
  }
  await report($, 'haiku', true)
  await overhead($, r.usage, 'haiku')
  const path = paths(root, sid).notes
  const now = await $.clock.now()
  const line = r.text.trim().split('\n')[0] ?? ''
  await $.fs.write(path, `${await readText($, path)}- ${iso(now)} · ${line}\n`)
  await trace($, root, sid, `note: ${line}`)
}

const SORT_PROMPT = `You sort one message in a Claude Code work chat . Reply with exactly three lines:
TOPIC: SAME | SIDE | NEW: <Project> · <task>
JOB: <TINY|EDIT|DESIGN|BUILD|PLAN|WRITE> <SURE|UNSURE>
PUSHBACK: YES | NO

TOPIC: SAME continues the current work (follow-ups, fixes, approvals, "go", questions about it); SIDE is a quick side question or a tiny one-off; NEW is real work on a DIFFERENT project or an unrelated task, with a short name such as "Website · footer spacing". With no earlier work, answer SAME.
JOB, for what the message asks for:
TINY: rename or move, a typo, a log entry, a quick lookup, a status check or a general-knowledge question (not one that needs digging through code)
EDIT: normal edits (CSS, copy tweaks, a small bug), proofreading or checking copy, going through a document
DESIGN: visual design, creative work, layouts, images, brand
BUILD: a big build, a new page, app or feature, hard debugging, or a security, code or performance audit; a short question about whether an app or site is safe, broken or correct ("is X weak to SQL injection", "why does X crash") is BUILD, because answering it means reading the code
PLAN: research, strategy, decisions, "should we"
WRITE: writing or reworking client-facing copy from scratch (pitch, proposal, page copy, an important email)
SURE means clearly that job; UNSURE means it could be another.
PUSHBACK: YES only if the message says the last answer was wrong, didn't work, or missed what was asked.`

async function sortMessage($: EngineInterface, text: string, answer: string, notes: string): Promise<Sort | null> {
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 60,
    timeoutMs: 6000,
    prompt: `${SORT_PROMPT}

Recent work in this chat:
${notes || '(none yet)'}

Last reply (end of it):
${answer ? answer.slice(-1500) : '(none yet)'}

Message:
${text.slice(0, 1500)}`,
  })
  if (!r.isAnswered) {
    if (r.reason !== 'aborted') await report($, 'haiku', false)
    return null
  }
  await report($, 'haiku', true)
  await overhead($, r.usage, 'haiku')
  const t = r.text
  const job = /JOB:\s*(TINY|EDIT|DESIGN|BUILD|PLAN|WRITE)\s*(SURE|UNSURE)?/i.exec(t)
  return {
    topic: /TOPIC:\s*NEW:\s*(.+)$/im.exec(t)?.[1]?.trim().slice(0, 60),
    job: job?.[1]?.toUpperCase(),
    sure: (job?.[2] ?? '').toUpperCase() === 'SURE',
    pushback: /PUSHBACK:\s*YES/i.test(t),
    raw: t.trim().replace(/\n/g, ' | ').slice(0, 160),
  }
}

// Turns the sort into notices and switches. `ctx` is the chat's size, `onSonnet` whether the
// app runs this chat on Sonnet with no switch of ours in place.
async function actOnSort($: EngineInterface, root: string, sid: string, srt: Sort, text: string, hadAnswer: boolean) {
  await trace($, root, sid, `sort: ${srt.raw}`)
  const ps = await update($, pushes, p => [...p.slice(-5), srt.pushback])
  const misses = ps.filter(Boolean).length
  if (srt.topic && hadAnswer) {
    await addNotice($, {
      id: `topic-${await $.clock.now()}`,
      kind: 'topic',
      text: `This looks like new work: ${srt.topic}. A fresh chat keeps this one focused and costs less per message.`,
      newWork: text,
    })
  }
  const m = await read($, measure)
  const ov = await read($, override)
  const onSonnet = !ov && (m.appModel === undefined || m.appModel.includes('sonnet'))
  if (!onSonnet) return
  const effort = srt.job !== undefined && srt.sure ? OPUS_JOBS[srt.job] : undefined
  const why = effort && srt.job ? JOB_WORDS[srt.job] ?? 'bigger work' : misses >= 2 ? 'two misses in a row' : undefined
  if (!why) return
  const ctx = m.ctxTokens ?? 0
  if (ctx < ((await read($, tune)).earlyK ?? EARLY_MAX_K) * 1000) {
    // Undo turned the in-place switch off for this chat; the later notice still applies.
    if (await read($, noAuto)) return
    await update($, override, () => ({ model: OPUS, effort: effort ?? 'high', why, announced: false }))
    await trace($, root, sid, `auto-switch armed: Opus · ${effort ?? 'high'} for ${why} (chat ${k(ctx)})`)
    return
  }
  if ((await read($, dismissed)).includes('escalate') || (await read($, notices)).some(n => n.kind === 'escalate')) return
  await trace($, root, sid, `notice: continue on Opus (${why}, chat ${k(ctx)})`)
  await addNotice($, {
    id: 'escalate',
    kind: 'escalate',
    toOpus: true,
    text: `This has turned into ${why} on Sonnet. Switching here would re-read all ${k(ctx)}; a fresh chat on Opus starts small.`,
  })
}

// Runs the sorter over a list of past messages (one per line) and writes what it picked.
async function sortCheck($: EngineInterface, root: string) {
  const lines = (await readText($, `${root}/data/sort-sample.txt`)).split('\n').filter(l => l.trim())
  const out: string[] = []
  await $.fs.write(`${root}/data/sort-check.txt`, `started, ${lines.length} messages\n`)
  for (const l of lines) {
    const msg = l.replace(/^\d+\.\s*/, '')
    const srt = await sortMessage($, msg, '', '')
    out.push(`${l.slice(0, 4).trim()} ${srt ? `${srt.job ?? '?'} ${srt.sure ? 'SURE' : 'UNSURE'}${srt.pushback ? ' PUSHBACK' : ''}` : 'no answer'} | ${msg.slice(0, 110)}`)
    await $.fs.write(`${root}/data/sort-check.txt`, `${out.join('\n')}\n`)
  }
  await $.fs.write(`${root}/data/sort-check.txt`, `${out.join('\n')}\n`)
  $.ui.toast(`Sorter check done: ${out.length} messages sorted.`)
}

// After a reply: the Haiku note, a checkpoint when a task wrapped up in a big chat (or the chat
// just got big with none yet), and the "past 200k" notice.
async function afterReply($: EngineInterface, root: string, sid: string, prompt: string, answer: string, wasTaskDone: boolean, replies: number, seq: number | null) {
  const m = await read($, measure)
  const t = await read($, tune)
  const ctx = m.ctxTokens ?? 0
  const fullK = t.fullK ?? FULL_K
  const big = ctx >= fullK * 1000 && !(await read($, dismissed)).includes('full')
  if (big && !(await read($, notices)).some(n => n.kind === 'full')) {
    await trace($, root, sid, `notice: past ${fullK}k (${k(ctx)})`)
    await addNotice($, {
      id: 'full',
      kind: 'full',
      text: `This chat is past ${fullK}k (now ${k(ctx)}). Past this size each message re-reads a lot, costs more and tends to drift. When a task here is finished, your next message opens a fresh chat from its checkpoint (Dismiss keeps this chat).`,
    })
  }
  if (replies >= 3 && !m.measureSeen) await report($, 'measure', false)
  await addNote($, root, sid, prompt, answer)
  if (ctx >= (t.moveMinK ?? CHECKPOINT_MIN_K) * 1000 && (wasTaskDone || (await read($, checkpointAt)) === null)) {
    const ok = await writeCheckpoint($, root, sid, wasTaskDone ? 'task finished' : 'first in a big chat')
    // Only if the user hasn't typed again while the checkpoint was being written: then it is current.
    if (ok && wasTaskDone && big && seq !== null && (await read($, promptSeq)) === seq) {
      await update($, sizeReady, () => true)
      await trace($, root, sid, `size move ready: task finished at ${k(ctx)}, the next message opens a fresh chat`)
    }
  }
}

// A "Project · task" name when there is no checkpoint title to take it from.
async function nameChat($: EngineInterface, notes: string, text: string): Promise<string> {
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 20,
    prompt: `Name this work chat as "Project · task", at most 6 words (e.g. "Website · footer spacing"). Reply with the name only.\n\nNotes so far:\n${notes.slice(-1500)}\n\nNew message:\n${text.slice(0, 600)}`,
  })
  if (!r.isAnswered) return ''
  await overhead($, r.usage, 'haiku')
  return (r.text.trim().split('\n')[0] ?? '').replace(/^["“]|["”]$/g, '').slice(0, 58)
}

// Decides whether the message just typed goes to a fresh chat, and builds that chat's brief.
async function checkAway($: EngineInterface, root: string, sid: string, text: string): Promise<Move | null> {
  const t = await read($, tune)
  const m = await read($, measure)
  const memo = (await $.store.get(`sess:${sid}`)) as SessMemo | undefined
  const lastAt = m.lastRealAt ?? memo?.lastRealAt
  const ctx = m.ctxTokens ?? memo?.ctxTokens
  if (!lastAt || !ctx) return null
  const awayMin = Math.round(((await $.clock.now()) - lastAt) / 60_000)
  const away = awayMin >= (t.awayMin ?? AWAY_MIN) && ctx >= (t.moveMinK ?? MOVE_MIN_K) * 1000
  const size =
    !away && !text.startsWith('/') && (await read($, sizeReady)) && ctx >= (t.fullK ?? FULL_K) * 1000 && !(await read($, dismissed)).includes('full')
  if (!away && !size) return null
  const p = paths(root, sid)
  const cp = (await readText($, p.checkpoint)).trim()
  const cpTime = /<!-- checkpoint (\S+)/.exec(cp)?.[1] ?? ''
  const notes = (await readText($, p.notes))
    .split('\n')
    .filter(l => l.startsWith('- ') && l.slice(2, 21) > cpTime)
    .slice(-40)
    .join('\n')
  if (!cp && !notes) return null
  const gap = fmtAway(awayMin)
  const title = titleOf(cp) || (await nameChat($, notes, text))
  const ov = await read($, override)
  const mark = ov ? `[model-switcher: run this chat on ${OPUS} · ${ov.effort}]\n\n` : ''
  const why = away
    ? `That chat had grown to ${k(ctx)} tokens and the user came back after ${gap}, so answering there would have meant re-reading all of it.`
    : `That chat had grown to ${k(ctx)} tokens and had just finished a task, so every further message there would have re-read all of it.`
  return {
    phase: 'pending',
    why: away ? 'away' : 'size',
    title: (title || 'Continued chat').slice(0, 58),
    ctxTokens: ctx,
    awayMin: away ? awayMin : 0,
    prompt: `${mark}This chat continues work from an earlier chat (session ${sid}). ${why} The model-switcher mod opened this fresh chat instead. Don't read the old chat's transcript unless the user asks or something essential is missing.

## Latest checkpoint
${cp || "(none was written: rely on the notes below, and ask the user if context is missing)"}

## Notes since the checkpoint
${notes || '(none)'}

## The user's new message (answer this)
${text}`,
    background: `Moved here by the model-switcher mod (Phase 1) from a ${k(ctx)}-token chat ${away ? `after the user was away ${gap}` : 'after it finished a task past 200k'}, to avoid re-reading it. The checkpoint was written by that chat while it was still cached; the notes are one-line Haiku summaries of each reply since.`,
  }
}

// "Start fresh chat" on a notice: the chat writes its handover while still cached, then the mod
// sends a prompt as the user, and turn.step answers that turn by opening the session.
async function startFresh($: EngineInterface, root: string, sid: string, n: Notice) {
  const ask = n.newWork
    ? `${CHECKPOINT_PROMPT}\n\nThe user is moving to a NEW chat for this request: "${n.newWork.slice(0, 1500)}". Write the handover for THAT request: keep only what from this chat helps with it (files, decisions, preferences). If nothing does, say so in one line.`
    : `${CHECKPOINT_PROMPT}\n\nThe user is moving to a fresh chat${n.toOpus ? ' on a stronger model, because this work outgrew the current one' : ' because this one is large'}. End with a **Start with:** line saying what the fresh chat should do first.`
  const r = await $.model.fork({ prompt: ask })
  if (!r.isAnswered) {
    await update($, busy, () => null)
    await report($, 'checkpoint', false)
    $.ui.toast("Couldn't write the handover, so no fresh chat was opened.")
    return
  }
  await overhead($, r.usage)
  const handover = r.text.trim()
  await $.fs.write(paths(root, sid).handover, `${handover}\n`)
  const title = (titleOf(handover) || (n.newWork ? n.newWork.slice(0, 40) : 'Continued chat')).slice(0, 58)
  const m = await read($, measure)
  const ov = await read($, override)
  const mark = n.toOpus || ov ? `[model-switcher: run this chat on ${OPUS} · ${ov?.effort ?? 'high'}]\n\n` : ''
  await update($, move, (): Move => ({
    phase: 'pending',
    why: 'button',
    noticeId: n.id,
    title,
    ctxTokens: m.ctxTokens ?? 0,
    awayMin: 0,
    prompt: `${mark}This chat continues from an earlier chat (session ${sid}) that the user chose to leave${n.toOpus ? ' to carry on with Opus' : n.newWork ? ' for a new piece of work' : ' because it had grown large'}. The model-switcher mod had that chat write the handover below while it was still loaded. Don't read the old chat's transcript unless the user asks.

## Handover
${handover}

${n.newWork ? `## The user's request for this chat\n${n.newWork}` : '## Start\nPick up from "Start with" in the handover: say in two lines where things stand, then ask what to do first.'}`,
    background: `Opened by the model-switcher mod (Phase 1) when the user pressed "Start fresh chat" on a ${n.kind === 'topic' ? 'new-topic' : 'chat-size'} notice. The handover was written by the old chat itself.`,
  }))
  await update($, busy, () => 'press Enter to open the fresh chat')
  // The app opens chats only on the user's own typed words, so the button fills the prompt box and
  // their Enter starts the turn the mod answers itself.
  const filled = await $.prompt.fill({ text: OPEN_TEXT })
  await trace($, root, sid, `button: handover written (${handover.length} chars), prompt box filled: ${JSON.stringify(filled).slice(0, 120)}`)
  $.ui.toast(`Handover ready. Press Enter on “${OPEN_TEXT}” to open the fresh chat.`)
}

// Undo on the "switched to Opus" notice: back to the app's model, and no more auto-switching here.
async function undoSwitch($: EngineInterface, root: string, sid: string, n: Notice) {
  await update($, override, () => null)
  await update($, noAuto, () => true)
  await update($, notices, ns => ns.filter(x => x.id !== n.id))
  await trace($, root, sid, 'auto-switch undone: back to the app model, auto off for this chat')
  $.ui.toast('Back to Sonnet for this chat. The mod won’t switch it again.')
}

// The button answers at once: the strip says what is happening, and further presses do nothing.
async function pressFresh($: EngineInterface, root: string, sid: string, n: Notice) {
  if (await read($, busy)) {
    $.ui.toast('Already on it: writing the handover.')
    return
  }
  await update($, busy, () => 'writing the handover (about 20 seconds)…')
  $.ui.toast('Writing the handover for the fresh chat (about 20 seconds)…')
  $.clock.after(0, () => {
    void startFresh($, root, sid, n)
  })
}

async function* fakeStep($: EngineInterface, e: TurnStepInput): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const m = await read($, move)
  const plan = LOAD_TOOL_FIRST ? ['load', 'start', 'say'] : ['start', 'say']
  const what = plan[Math.min(e.index, plan.length - 1)]
  if (m && !m.result && (what === 'load' || what === 'start')) {
    const name = what === 'load' ? 'ToolSearch' : START
    const input =
      what === 'load'
        ? { query: `select:${START}`, max_results: 1 }
        : { initiation: 'user_asked', title: m.title, context: 'fresh', prompt: m.prompt, background: m.background }
    const lead =
      e.index > 0
        ? ''
        : m.why === 'away'
          ? `You were away ${fmtAway(m.awayMin)}, so I'm opening a fresh chat instead of re-reading this one…`
          : m.why === 'size'
            ? `This chat is ${k(m.ctxTokens)} and the last task is finished, so I'm opening a fresh chat from its checkpoint…`
            : 'Opening a fresh chat from the handover…'
    let at = 0
    if (lead) {
      yield { kind: 'text', index: 0, text: lead }
      at = 1
    }
    yield { kind: 'tool', index: at, id: toolId(), name }
    yield { kind: 'input', index: at, json: JSON.stringify(input) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: lead, toolUses: [{ name, input }], stopReason: 'tool_use', usage: null }
  }
  const s = await read($, saved)
  const res = m?.result
  let text: string
  if (!m || !res?.ok) {
    const why = res ? ` (${res.detail.slice(0, 160)})` : ''
    text =
      m?.why === 'button'
        ? `I couldn't open a fresh chat${why}. The handover is saved; you can carry on here.`
        : `I couldn't open a fresh chat${why}. Nothing is lost: send your message again and it will be answered in this chat.`
  } else if (m.why === 'away') {
    const cost = avoidedUnits(m.ctxTokens, m.prompt.length)
    const size = s.pctPerUnit !== undefined ? `≈${(cost * s.pctPerUnit).toFixed(1)}% of your 5-hour limit` : `≈${k(cost)} tokens of re-reading`
    const costNote = cost >= 5000 ? ` (${size})` : ''
    text = `You were away ${fmtAway(m.awayMin)}. This chat is ${k(m.ctxTokens)}, and its stored copy expires after an hour, so answering here would have meant re-reading all of it${costNote}. I opened a fresh chat with the latest checkpoint and your message instead: look for “${m.title}” in the sidebar. This chat is left as it was.`
  } else if (m.why === 'size') {
    text = `This chat is ${k(m.ctxTokens)} and the last task was finished, so every further message here would re-read all of it. I opened a fresh chat with the checkpoint and your message instead: look for “${m.title}” in the sidebar. To carry on here instead, type your message here again.`
  } else {
    text = `Opened a fresh chat with the handover: “${m.title}” in the sidebar. This chat is left as it was.`
  }
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}

export const register: Register = on => {
  let sid = 'unknown'
  let root = ''
  let replies = 0

  on('session.start', async ($, e, next) => {
    sid = await $.session.id()
    root = $.plugin.root
    for (const [name, description, argumentHint] of [
      ['switcher', 'Model switcher: status, thresholds, checkpoint and notes files, savings.', ''],
      ['switcher-checkpoint', 'Model switcher: write a checkpoint of this chat now.', ''],
      ['switcher-test', 'Model switcher: test thresholds for this chat only (away minutes, move size k, full size k).', '<away N | size N | full N | off>'],
      ['switcher-sort-check', 'Model switcher: run the job sorter over data/sort-sample.txt and write data/sort-check.txt.', ''],
    ] as const) {
      await $.command.register({ name, description, argumentHint })
    }
    const version = (await $.session.version()).version
    const stored = (await $.store.get('health')) as Health | undefined
    const verifying = stored === undefined ? false : stored.version !== version || stored.verifying === true
    await update($, health, () => ({ version, verifying, parts: {} }))
    await $.store.set('health', { version, verifying, parts: {} })
    await refreshSaved($)
    await trace($, root, sid, `loaded, app ${version}${verifying ? ' (checking itself after an update)' : ''}`)
    return next(e)
  })

  on('command.run', { command: 'switcher' }, async $ => {
    const m = await read($, measure)
    const t = await read($, tune)
    const h = await read($, health)
    const s = await read($, saved)
    const cp = await read($, checkpointAt)
    const p = paths(root, sid)
    const parts = Object.entries(h.parts).map(([n, v]) => `${n} ${v}`).join(', ') || 'nothing checked yet'
    return {
      text: [
        `Model switcher (Phase 1) · app ${h.version ?? '?'}${h.verifying ? ' · checking itself after an update' : ''}`,
        `This chat: ${m.ctxTokens ? k(m.ctxTokens) : 'size not known yet'}${m.fiveHour !== undefined ? ` · 5-hour limit ${m.fiveHour}% used` : ''}${m.weekly !== undefined ? ` · weekly ${m.weekly}%` : ''}`,
        `Moves to a fresh chat after ${t.awayMin ?? AWAY_MIN} min away, when the chat is ${t.moveMinK ?? MOVE_MIN_K}k or more. Past ${t.fullK ?? FULL_K}k: a notice, and a move at the next message once a task is finished${(await read($, sizeReady)) ? ' (ready now)' : ''}. Sonnet→Opus in place under ${t.earlyK ?? EARLY_MAX_K}k, a fresh-chat notice above.${Object.keys(t).length ? ' (test values for this chat)' : ''}`,
        `Checkpoint: ${cp ? `${hhmm(cp)}, ${p.checkpoint}` : 'none yet'}`,
        `Notes: ${p.notes}`,
        `Savings: ${savedText(s)} (${s.moves} move${s.moves === 1 ? '' : 's'}, net of the mod's own calls)`,
        `Self-check: ${parts}`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'switcher-checkpoint' }, async $ => {
    $.clock.after(0, () => {
      void writeCheckpoint($, root, sid, 'asked for')
    })
    return { text: 'Writing a checkpoint in the background; the strip shows its time when it is saved.' }
  })

  on('command.run', { command: 'switcher-sort-check' }, async $ => {
    $.clock.after(0, () => {
      void sortCheck($, root)
    })
    return { text: 'Sorting the sample messages with Haiku in the background; a pop-up says when it is done.' }
  })

  on('command.run', { command: 'switcher-test' }, async ($, e) => {
    const [what, raw] = e.args.trim().split(/\s+/)
    const n = Number(raw)
    if (what === 'off' || !what) {
      await update($, tune, () => ({}))
      return { text: 'Switcher: back to the real thresholds (60 min away, 100k, 200k, switch to Opus in place under 130k).' }
    }
    if (!Number.isFinite(n) || (what !== 'away' && what !== 'size' && what !== 'full' && what !== 'early')) {
      return { text: 'Use: /switcher-test away <minutes> | size <k> | full <k> | early <k> | off' }
    }
    const t = await update($, tune, cur =>
      what === 'away' ? { ...cur, awayMin: n } : what === 'size' ? { ...cur, moveMinK: n } : what === 'early' ? { ...cur, earlyK: n } : { ...cur, fullK: n },
    )
    if (what === 'full') await update($, dismissed, d => d.filter(x => x !== 'full'))
    return { text: `Switcher test values for this chat: ${JSON.stringify(t)}` }
  })

  on('prompt.submit', async ($, e, next) => {
    const mk = MARK.exec(e.text)
    if (mk?.[1] && e.turnId === undefined && !(await read($, override))) {
      const effort = mk[2] === 'medium' ? 'medium' : 'high'
      await update($, override, () => ({ model: mk[1] ?? OPUS, effort, why: 'carried over from the chat before', announced: false }))
      await trace($, root, sid, `opening brief asks for ${mk[1]} · ${effort}: applied`)
    }
    const gone = await read($, movedTo)
    if (gone !== null && e.turnId === undefined && !isPerson(e.origin) && e.origin?.kind !== 'plugin') {
      await update($, quietTurn, () => 'pending')
      await trace($, root, sid, `wake-up after the move (origin ${e.origin?.kind}): answering it in one line, no re-read`)
      return next(e)
    }
    if (isPerson(e.origin) && e.turnId === undefined && gone !== null) await update($, movedTo, () => null)
    if (e.turnId !== undefined || !isPerson(e.origin)) return next(e)
    await update($, promptSeq, x => x + 1)
    const pending = await read($, move)
    if (pending?.phase === 'pending' && pending.why === 'button') {
      if (e.text.trim() === OPEN_TEXT) {
        await trace($, root, sid, "button: the user's Enter on the filled text, opening the chat")
        return next(e)
      }
      await update($, move, () => null)
      await update($, busy, () => null)
    }
    if (await read($, skipMove)) {
      await update($, skipMove, () => false)
    } else {
      const m = await checkAway($, root, sid, e.text)
      if (m) {
        await update($, sizeReady, () => false)
        await update($, move, () => m)
        await trace($, root, sid, `move armed: ${m.why === 'size' ? 'task finished past the size limit' : `away ${m.awayMin} min`}, chat ${k(m.ctxTokens)}, origin ${JSON.stringify(e.origin)}`)
        return next(e)
      }
    }
    // A message that stays here starts new work in this chat, so the last checkpoint is no longer current.
    if (await read($, sizeReady)) {
      await update($, sizeReady, () => false)
      await trace($, root, sid, 'size move skipped: this message stays in this chat')
    }
    await update($, lastPrompt, () => e.text)
    const answer = await read($, lastAnswer)
    const text = e.text
    if (!text.startsWith('/') && text.trim().length >= 3) {
      const notes = (await readText($, paths(root, sid).notes)).trim().split('\n').slice(-6).join('\n')
      const m = await read($, measure)
      const early =
        (m.ctxTokens ?? 0) < ((await read($, tune)).earlyK ?? EARLY_MAX_K) * 1000 &&
        !(await read($, override)) &&
        !(await read($, noAuto)) &&
        (m.appModel === undefined || m.appModel.includes('sonnet'))
      if (early) {
        // Waits (≤6 s) so a switch to Opus applies to this very reply.
        const srt = await sortMessage($, text, answer, notes)
        if (srt) await actOnSort($, root, sid, srt, text, answer !== '')
      } else {
        $.clock.after(0, () => {
          void sortMessage($, text, answer, notes).then(srt => (srt ? actOnSort($, root, sid, srt, text, answer !== '') : undefined))
        })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: WRAP_UP }, async ($, e, next) => {
    await update($, taskDone, () => true)
    // A wrap-up that asks the user something leaves the task open: their answer belongs in this chat.
    const ask = (e as { ask?: unknown }).ask
    await update($, taskAsks, () => typeof ask === 'string' && ask.trim() !== '')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: START }, async ($, e, next) => {
    const m = await read($, move)
    if (!m || m.phase === 'pending' || m.result) return next(e)
    const r = await next(e)
    const ok = r.deny === undefined && r.isError !== true
    const detail = r.deny ?? JSON.stringify(r.result ?? '').slice(0, 400)
    await update($, move, x => x && { ...x, result: { ok, detail } })
    await report($, 'move', ok)
    await trace($, root, sid, `start_session ${ok ? 'ok' : 'FAILED'}: ${detail.slice(0, 300)}`)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const q = await read($, quietTurn)
      if (q === 'pending' || q === e.turnId) {
        if (q === 'pending') await update($, quietTurn, () => e.turnId)
        const text = `“${(await read($, movedTo)) ?? 'The fresh chat'}” has replied; carry on there. (Typing here again continues this chat.)`
        yield { kind: 'text', index: 0, text }
        yield { kind: 'stop', stopReason: 'end_turn', usage: null }
        return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
      }
      const m = await read($, move)
      if (m && (m.phase === 'pending' || m.phase === e.turnId)) {
        if (m.phase === 'pending') await update($, move, x => x && { ...x, phase: e.turnId })
        await trace($, root, sid, `move: answering step ${e.index} myself (no request sent)`)
        return yield* fakeStep($, e)
      }
    }
    let asked = e
    if (!e.agentId) {
      const ov = await read($, override)
      if (ov && e.model.includes('sonnet')) {
        asked = { ...e, model: ov.model, effort: ov.effort }
        if (!ov.announced) {
          await update($, override, x => x && { ...x, announced: true })
          const ctx = (await read($, measure)).ctxTokens ?? 0
          await trace($, root, sid, `auto-switch applied: ${ov.model} · ${ov.effort} (${ov.why})`)
          await addNotice($, {
            id: 'switched',
            kind: 'switched',
            text: `Switched this chat to Opus · ${ov.effort}: ${ov.why}.${ctx ? ` Cheap now, the chat is ${k(ctx)}.` : ''} (The app's model label still says Sonnet.)`,
          })
        }
      }
    }
    const r = yield* next(asked)
    if (!e.agentId && r.usage) {
      const ctx = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      const now = await $.clock.now()
      const used = r.usage.model
      await update($, measure, cur => ({ ...cur, ctxTokens: ctx, lastRealAt: now, model: used, appModel: e.model, effort: asked.effort === undefined ? undefined : String(asked.effort) }))
      await $.store.set(`sess:${sid}`, { lastRealAt: now, ctxTokens: ctx } satisfies SessMemo)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    if ((await read($, quietTurn)) === e.turnId) {
      await update($, quietTurn, () => null)
      return next(e)
    }
    const m = await read($, move)
    if (m && m.phase === e.turnId) {
      await trace($, root, sid, `move turn ended (${e.reason}), result ${JSON.stringify(m.result ?? null).slice(0, 200)}`)
      await update($, move, () => null)
      await update($, busy, () => null)
      if (m.result?.ok) {
        if (m.why === 'away') await addSaving($, avoidedUnits(m.ctxTokens, m.prompt.length), m.ctxTokens)
        await update($, movedTo, () => m.title)
        if (m.noticeId) await update($, notices, ns => ns.filter(x => x.id !== m.noticeId))
        if (m.why === 'size') await update($, notices, ns => ns.filter(x => x.kind !== 'full'))
      } else {
        await update($, skipMove, () => true)
      }
      return next(e)
    }
    await update($, unitsSinceMeasure, x => x + units(e.usage, e.usage?.model))
    if (e.reason !== 'answer') return next(e)
    replies += 1
    const prompt = await read($, lastPrompt)
    const wasTaskDone = await read($, taskDone)
    await update($, taskDone, () => false)
    await update($, lastAnswer, () => e.answer)
    const answer = e.answer
    const n = replies
    // null: the wrap-up asked the user something, so no size move after it
    const seq = (await read($, taskAsks)) ? null : await read($, promptSeq)
    await update($, taskAsks, () => false)
    $.clock.after(0, () => {
      void afterReply($, root, sid, prompt, answer, wasTaskDone, n, seq)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const five = e.rateLimits.find(r => r.kind === 'five_hour')
    const week = e.rateLimits.find(r => r.kind === 'seven_day')
    if (five) {
      // Calibration: limit % gained vs the cost units spent since the last point. Other chats
      // running at the same time inflate it, so the counter leans high; it says "≈".
      const cur = await read($, measure)
      const since = await read($, unitsSinceMeasure)
      const base = cur.calibBase
      let nextBase = base
      if (base === undefined || five.percentUsed < base) {
        nextBase = five.percentUsed
        await update($, unitsSinceMeasure, () => 0)
      } else if (five.percentUsed > base && since > 0) {
        const c = ((await $.store.get('calib')) as Calib | undefined) ?? { pct: 0, units: 0 }
        await $.store.set('calib', { pct: c.pct + (five.percentUsed - base), units: c.units + since } satisfies Calib)
        nextBase = five.percentUsed
        await update($, unitsSinceMeasure, () => 0)
      }
      await update($, measure, m => ({ ...m, fiveHour: five.percentUsed, weekly: week?.percentUsed ?? m.weekly, measureSeen: true, calibBase: nextBase }))
      if (!cur.measureSeen) await trace($, root, sid, `limits readable: 5h ${five.percentUsed}%, weekly ${week?.percentUsed ?? '?'}%`)
      await report($, 'measure', true)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const m = await read($, measure)
    const ns = await read($, notices)
    if (!m.ctxTokens && ns.length === 0) return next(e)
    const b = await read($, busy)
    const cp = await read($, checkpointAt)
    const s = await read($, saved)
    const { Box, Button, Text } = $.ui.resolve(e)
    const ov = await read($, override)
    const model = m.model ? `${m.model.includes('opus') ? 'Opus' : m.model.includes('sonnet') ? 'Sonnet' : m.model.replace('claude-', '')}${m.effort ? ` ${m.effort}` : ''}${ov?.announced ? ' (switched by the mod)' : ''}` : ''
    const line = ['switcher', model, m.ctxTokens ? `chat ${k(m.ctxTokens)}` : '', cp ? `checkpoint ${hhmm(cp)}` : '', savedText(s), b ?? '']
      .filter(Boolean)
      .join(' · ')
    return (
      <Box flexDirection="column">
        <Text dimColor>{line}</Text>
        {ns.map(n => (
          <Box key={n.id} flexWrap="wrap" alignItems="center">
            <Text color={n.kind === 'warn' ? 'warning' : undefined}>{n.text} </Text>
            {n.kind === 'warn' ? null : n.kind === 'switched' ? (
              <Button key="undo" label="Undo" onPress={() => undoSwitch($, root, sid, n)} />
            ) : b ? (
              <Text dimColor>{b}</Text>
            ) : (
              <Button
                key="go"
                label={n.kind === 'escalate' ? 'Continue on Opus' : 'Start fresh chat'}
                onPress={() => pressFresh($, root, sid, n)}
              />
            )}
            <Button key="x" label="Dismiss" onPress={() => dismiss($, n)} />
          </Box>
        ))}
      </Box>
    )
  })
}
