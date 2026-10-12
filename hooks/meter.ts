import type { TurnUsage } from 'claude-code'

/** The four ways a request bills tokens, as the API reports them. */
export type Buckets = { input: number; write: number; read: number; output: number }

/** $ per million tokens. `write` is the one-hour cache write, which Claude Code uses. */
export type Price = Buckets

export type Row = {
  /** 'main', or the subagent's id. */
  id: string
  label: string
  /** 'main', or the agent type (Explore, general-purpose, a plugin's). */
  kind: string
  /** The model that last answered, or the one the spawn asked for before any answer. */
  model: string
  running: boolean
  startedAt: number
  requests: number
  tokens: Buckets
  usd: Buckets
  /** Requests whose model has no row in PRICES: their tokens count, their dollars do not. */
  unpriced: number
}

export type Ledger = {
  rows: Row[]
  /** /cost's total when this meter started, so Other counts only what was spent since. */
  baselineUsd: number
}

// List prices, platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-12.
// [family, input, 1h cache write, cache read, output]. A model id takes the first row it contains,
// so a longer family comes before any shorter one it contains (opus-5-5 before opus-5).
const PRICES: Array<[string, number, number, number, number]> = [
  ['fable-5-1', 10, 20, 0.25, 50],
  ['mythos-5-1', 10, 20, 0.25, 50],
  ['fable-5', 10, 20, 1, 50],
  ['mythos-5', 10, 20, 1, 50],
  ['opus-5-5', 4, 8, 0.2, 20],
  ['opus-5', 5, 10, 0.5, 25],
  ['opus-4-8', 5, 10, 0.5, 25],
  ['opus-4-7', 5, 10, 0.5, 25],
  ['opus-4-6', 5, 10, 0.5, 25],
  ['opus-4-5', 5, 10, 0.5, 25],
  ['opus-4', 15, 30, 1.5, 75],
  ['sonnet-5-5', 2, 4, 0.1, 10],
  ['sonnet-5', 2, 4, 0.2, 10],
  ['sonnet-4', 3, 6, 0.3, 15],
  ['haiku-5-5', 0.1, 0.2, 0.01, 0.5],
  ['haiku-4-5', 1, 2, 0.1, 5],
  ['haiku-3-5', 0.8, 1.6, 0.08, 4],
]

// Haiku 5.5 bills a whole request at these once its prompt (input, cache reads and writes) passes 100k tokens.
const HAIKU_55_LONG: Price = { input: 0.5, write: 1, read: 0.05, output: 2.5 }
const HAIKU_55_LONG_FROM = 100000

export function priceOf(model: string, promptTokens: number): Price | null {
  const m = model.toLowerCase()
  for (const [family, input, write, read, output] of PRICES) {
    if (!m.includes(family)) continue
    if (family === 'haiku-5-5' && promptTokens > HAIKU_55_LONG_FROM) return HAIKU_55_LONG
    return { input, write, read, output }
  }
  return null
}

const zero = (): Buckets => ({ input: 0, write: 0, read: 0, output: 0 })

export function freshLedger(baselineUsd: number): Ledger {
  return { rows: [], baselineUsd }
}

function rowFor(l: Ledger, agentId: string | undefined, now: number): Row {
  const id = agentId ?? 'main'
  let row = l.rows.find(r => r.id === id)
  if (!row) {
    row = {
      id, label: agentId ? 'agent' : 'main', kind: agentId ? 'agent' : 'main', model: '', running: Boolean(agentId),
      startedAt: now, requests: 0, tokens: zero(), usd: zero(), unpriced: 0,
    }
    // main always first; agents in the order they started.
    if (agentId) l.rows.push(row)
    else l.rows.unshift(row)
  }
  return row
}

/** One model request, on the main loop (no agentId) or in a subagent. */
export function recordStep(l: Ledger, agentId: string | undefined, u: TurnUsage, now = 0): void {
  const row = rowFor(l, agentId, now)
  const tokens: Buckets = { input: u.input_tokens, write: u.cache_creation_input_tokens, read: u.cache_read_input_tokens, output: u.output_tokens }
  row.requests++
  if (u.model) row.model = u.model
  if (agentId) row.running = true
  for (const k of BUCKETS) row.tokens[k] += tokens[k]
  const price = priceOf(u.model ?? '', tokens.input + tokens.write + tokens.read)
  if (!price) {
    row.unpriced++
    return
  }
  for (const k of BUCKETS) row.usd[k] += tokens[k] * price[k] / 1e6
}

export function noteSpawn(l: Ledger, agentId: string, spawn: { label: string; kind: string; model: string }, now: number): void {
  const row = rowFor(l, agentId, now)
  row.label = spawn.label || spawn.kind
  row.kind = spawn.kind
  if (!row.model) row.model = spawn.model
  row.running = true
}

export function noteDone(l: Ledger, agentId: string): void {
  const row = l.rows.find(r => r.id === agentId)
  if (row) row.running = false
}

export const BUCKETS = ['output', 'write', 'read', 'input'] as const

export const rowUsd = (r: Row): number => r.usd.input + r.usd.write + r.usd.read + r.usd.output

export function totals(l: Ledger): { tokens: Buckets; usd: Buckets; total: number; requests: number } {
  const tokens = zero()
  const usd = zero()
  let requests = 0
  for (const r of l.rows) {
    requests += r.requests
    for (const k of BUCKETS) {
      tokens[k] += r.tokens[k]
      usd[k] += r.usd[k]
    }
  }
  return { tokens, usd, total: usd.input + usd.write + usd.read + usd.output, requests }
}

export function fmtUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01'
  return '$' + (usd >= 1000 ? usd.toFixed(0) : usd.toFixed(2))
}

export function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(n)
}

/** claude-opus-5-5 → opus 5.5; drops a provider prefix, a date suffix and a [1m] tag. */
export function shortModel(model: string): string {
  if (!model) return '?'
  return model
    .replace(/\[.*\]$/, '')
    .replace(/^.*claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')
}
