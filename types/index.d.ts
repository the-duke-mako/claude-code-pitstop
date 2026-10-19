// What the chat looks like right now: size from the last real request, limits from session.measure.
export type Measure = {
  ctxTokens?: number
  lastRealAt?: number
  fiveHour?: number
  weekly?: number
  measureSeen?: boolean
  // the model and effort the last real request ran on (after any switch)
  model?: string
  effort?: string
  // the model the app itself names for this chat (before any switch of ours)
  appModel?: string
  // 5-hour % at the last calibration point (see calibrate)
  calibBase?: number
}

// One line on the strip that stays until dismissed.
export type Notice = {
  id: string
  kind: 'full' | 'topic' | 'warn' | 'switched' | 'escalate'
  text: string
  // for a topic notice: the new message, so the handover is about it
  newWork?: string
  // the fresh chat it opens runs on Opus
  toOpus?: boolean
}

// A turn the mod answers itself to open a fresh chat. `phase` is 'pending' until the
// turn's first step names its turnId.
export type Move = {
  phase: string
  why: 'away' | 'button' | 'size'
  title: string
  prompt: string
  background: string
  ctxTokens: number
  awayMin: number
  result?: { ok: boolean; detail: string }
  // the notice whose button started it, removed once the chat opens
  noticeId?: string
}

// Test overrides for this chat only (/pitstop-test).
// What the sorter (Haiku) made of one message.
export type Sort = { topic?: string; job?: string; sure: boolean; pushback: boolean; raw: string }
// A model the mod runs this chat on instead of the app's (only ever Sonnet → Opus).
export type Override = { model: string; effort: 'medium' | 'high'; why: string; announced: boolean }

export type Tune = { awayMin?: number; moveMinK?: number; fullK?: number; earlyK?: number }

export type Part = 'measure' | 'haiku' | 'checkpoint' | 'move'
export type Health = { version?: string; verifying?: boolean; parts: Partial<Record<Part, 'ok' | 'fail'>> }

// Kept in $.store across chats.
export type SessMemo = { lastRealAt?: number; ctxTokens?: number }
export type Saving = { at: number; units: number; tokens: number }
export type Calib = { pct: number; units: number }

declare module 'claude-code' {
  interface PluginState {
    'pitstop': {
      measure: Measure
      notices: Notice[]
      dismissed: string[]
      busy: string | null
      move: Move | null
      skipMove: boolean
      lastAnswer: string
      lastPrompt: string
      taskDone: boolean
      checkpointAt: number | null
      tune: Tune
      health: Health
      saved: { units: number; tokens: number; moves: number; pctPerUnit?: number }
      unitsSinceMeasure: number
      // this chat's work moved to a fresh chat; until the user types here again, wake-ups get one line
      movedTo: string | null
      quietTurn: string | null
      override: Override | null
      noAuto: boolean
      pushes: boolean[]
      // a task finished in a chat past 200k and its checkpoint is saved: the next message moves
      sizeReady: boolean
      // counts the user's messages, so a checkpoint finished after they typed again doesn't arm a move
      promptSeq: number
      // the last wrap_up asked the user a question (the task waits on their answer)
      taskAsks: boolean
    }
  }
}
