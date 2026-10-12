import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { AgentSpawnInput, CommandRunInput, On, RenderPropsOf, SessionRateLimit, SessionStartInput, TurnCompleteInput, TurnStepInput, TurnUsage } from 'claude-code'

import { fmtLeft, fmtUsd, freshLedger, noteDone, noteSpawn, priceOf, recordStep, shortModel, totals } from '../hooks/meter'

tier('user')

type T = Parameters<Parameters<typeof test>[1]>[0]

// Dollars to whole micro-dollars, so float sums compare exactly.
const micro = (usd: number) => Math.round(usd * 1e6)

const START = 1_000_000

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 1000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 100000, output_tokens: 2000, model: 'claude-opus-5-5', ...over,
})

const run = (args: string, isFullscreen = true): CommandRunInput => ({
  command: 'meter', args, origin: { kind: 'composer' }, presentation: { isFullscreen, columns: 200 },
})

const spawnInput = (over: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  prompt: 'look around', description: 'find the pane code', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
} as AgentSpawnInput)

let turns = 0
const turnDone = (agentId?: string): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', agentId,
} as TurnCompleteInput)

const paneProps: RenderPropsOf['Pane'] = {
  title: 'Taxi Meter', isFocused: false, bodyColumns: 40, placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 }, view: {},
}

// The engine beneath the mod: a store, an official /cost total the test moves, panes, and model requests answered with the usage each test names.
function world(on: On, opts: { store?: Map<string, unknown> } = {}) {
  const store = opts.store ?? new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const official = { usd: 0, limits: [] as SessionRateLimit[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: 0 }, rateLimits: official.limits, cost: { usd: official.usd } } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [''] }))
  const panes = new Set<string>()
  on('ui.open', ($, e) => { panes.add(e.id); return { value: { isPlaced: true as const } } })
  on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
  let agents = 0
  // A teammate's address carries the name the team gave it, suffixed with its spawn count.
  on('agent.spawn', ($, e) => ({ model: e.model ?? e.parentModel, agentId: 'a' + ++agents, ...(e.isTeammate ? { teammateId: `${e.name}-${agents}@crew` } : {}) }))
  const answers: Array<TurnUsage | null> = []
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: answers.shift() ?? null }
  })
  return { store, official, panes, answers }
}

async function step($: T, w: ReturnType<typeof world>, u: TurnUsage | null, agentId?: string) {
  w.answers.push(u)
  const input: TurnStepInput = { turnId: 't' + ++turns, index: 0, model: u?.model ?? 'claude-opus-5-5', messageCount: 3, agentId }
  const stream = $.turn.step(input)
  for await (const _ of stream) { /* drain */ }
  return stream.result
}

const mountPane = ($: T, props = paneProps) =>
  $.ui.mount({ plugin: 'taxi-meter', surface: 'terminal', component: 'Pane', requestId: 'taxi-meter', props })

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

describe('prices', () => {
  test('a model id finds its own row, never a shorter family that it contains', async () => {
    expect(priceOf('claude-opus-5-5', 0)).toEqual({ input: 4, write: 8, read: 0.2, output: 20 })
    expect(priceOf('claude-opus-5', 0)).toEqual({ input: 5, write: 10, read: 0.5, output: 25 })
    expect(priceOf('claude-sonnet-5-5', 0)?.read).toBe(0.1)
    expect(priceOf('claude-sonnet-5', 0)?.read).toBe(0.2)
    expect(priceOf('claude-fable-5-1', 0)?.read).toBe(0.25)
    expect(priceOf('claude-fable-5', 0)?.read).toBe(1)
    expect(priceOf('claude-opus-4-1-20250805', 0)?.input).toBe(15)
    expect(priceOf('claude-opus-4-8', 0)?.input).toBe(5)
    expect(priceOf('us.anthropic.claude-sonnet-4-6', 0)?.output).toBe(15)
    expect(priceOf('claude-opus-5-5[1m]', 0)?.input).toBe(4)
    expect(priceOf('gpt-5', 0)).toBeNull()
  })

  test('Haiku 5.5 pays its higher prices once the whole prompt passes 100k tokens', async () => {
    expect(priceOf('claude-haiku-5-5', 100000)?.input).toBe(0.1)
    expect(priceOf('claude-haiku-5-5', 100001)).toEqual({ input: 0.5, write: 1, read: 0.05, output: 2.5 })
  })

  test('one request is priced bucket by bucket, cache writes at the one-hour rate', async () => {
    const l = freshLedger(0)
    recordStep(l, undefined, usage())
    const t = totals(l)
    // 1k input at $4, 10k written at $8, 100k read at $0.20, 2k output at $20, per million.
    expect(micro(t.usd.input)).toBe(micro(0.004))
    expect(micro(t.usd.write)).toBe(micro(0.08))
    expect(micro(t.usd.read)).toBe(micro(0.02))
    expect(micro(t.usd.output)).toBe(micro(0.04))
    expect(micro(t.total)).toBe(micro(0.144))
  })

  test('an unknown model still counts its tokens and is flagged unpriced', async () => {
    const l = freshLedger(0)
    recordStep(l, undefined, usage({ model: 'mystery-1' }))
    expect(totals(l).total).toBe(0)
    expect(totals(l).tokens.read).toBe(100000)
    expect(l.rows[0].unpriced).toBe(1)
  })

  test('formatting', async () => {
    expect(fmtUsd(0)).toBe('$0.00')
    expect(fmtUsd(0.004)).toBe('<$0.01')
    expect(fmtUsd(3.456)).toBe('$3.46')
    expect(fmtUsd(1234.5)).toBe('$1235')
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(shortModel('claude-fable-5')).toBe('fable 5')
    expect(shortModel('us.anthropic.claude-sonnet-5-5[1m]')).toBe('sonnet 5.5')
    expect(fmtLeft(30 * 1000)).toBe('<1m')
    expect(fmtLeft(45 * 60000)).toBe('45m')
    expect(fmtLeft((2 * 60 + 14) * 60000)).toBe('2h 14m')
    expect(fmtLeft(((3 * 24 + 4) * 60 + 30) * 60000)).toBe('3d 4h')
  })
})

describe('ledger', () => {
  test('main and each agent keep their own row; a step before its spawn is answered still lands on the agent', async () => {
    const l = freshLedger(0)
    recordStep(l, 'a1', usage({ model: 'claude-haiku-5-5', input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }))
    noteSpawn(l, 'a1', { label: 'find the pane code', kind: 'Explore', model: 'claude-haiku-5-5' }, START)
    recordStep(l, undefined, usage())
    expect(l.rows.map(r => r.id)).toEqual(['main', 'a1'])
    const agent = l.rows[1]
    expect(agent.label).toBe('find the pane code')
    expect(agent.kind).toBe('Explore')
    expect(agent.requests).toBe(1)
    expect(agent.running).toBe(true)
    noteDone(l, 'a1')
    expect(agent.running).toBe(false)
  })
})

describe('wiring', () => {
  test('requests on the main loop and in a subagent are metered apart, with the agent\'s spawn details', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await step($, w, usage())
    const spawned = await $.agent.spawn(spawnInput({ model: 'claude-haiku-5-5' }))
    expect(spawned.agentId).toBe('a1')
    await step($, w, usage({ model: 'claude-haiku-5-5', output_tokens: 500 }), 'a1')
    await step($, w, usage({ model: 'claude-haiku-5-5', output_tokens: 500 }), 'a1')
    w.official.usd = 0.5
    const card = (await $.command.run(run(''))).text ?? ''
    expect(card).toMatch(/main/)
    expect(card).toMatch(/find the pane code/)
    expect(card).toMatch(/haiku 5\.5/)
    expect(card).toMatch(/2 req/)
    expect(card).toMatch(/\/cost \$0\.50/)
  })

  test('a step that reports no usage changes nothing', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await step($, w, null)
    expect((await $.command.run(run(''))).text).toMatch(/no requests yet/i)
  })

  test('/clear starts a fresh meter, and Other counts only /cost spent since then', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await step($, w, usage())
    w.official.usd = 2
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    expect((await $.command.run(run(''))).text).toMatch(/no requests yet/i)
    await step($, w, usage())
    // 0.144 metered since the clear; /cost moved from 2 to 2.30, so 0.156 went to requests the meter could not see.
    w.official.usd = 2.3
    const card = (await $.command.run(run(''))).text ?? ''
    expect(card).toMatch(/\$0\.14/)
    expect(card).toMatch(/other \$0\.16/i)
  })

  test('/meter reset zeroes the meter the same way', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await step($, w, usage())
    w.official.usd = 1
    await $.command.run(run('reset'))
    expect((await $.command.run(run(''))).text).toMatch(/no requests yet/i)
  })

  test('a finished agent reads done', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.agent.spawn(spawnInput())
    await step($, w, usage({ model: 'claude-haiku-5-5' }), 'a1')
    expect((await $.command.run(run(''))).text).toMatch(/running/)
    await $.turn.complete(turnDone('a1'))
    expect((await $.command.run(run(''))).text).toMatch(/done/)
  })

  test('a named agent shows its name, a teammate the name its team gave it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.agent.spawn(spawnInput({ name: 'scout' }))
    await step($, w, usage(), 'a1')
    await $.agent.spawn(spawnInput({ name: 'scout', isTeammate: true }))
    await step($, w, usage(), 'a2')
    const card = (await $.command.run(run(''))).text ?? ''
    expect(card).toMatch(/ scout · /)
    expect(card).toMatch(/ scout-2 · /)
    expect(card).not.toMatch(/find the pane code/)
  })
})

describe('pane', () => {
  test('/meter pane opens and remembers it; /meter pane off closes and forgets', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    expect(w.panes.has('taxi-meter')).toBe(false)
    await $.command.run(run('pane'))
    expect(w.panes.has('taxi-meter')).toBe(true)
    expect(w.store.get('pane')).toBe(true)
    await $.command.run(run('pane off'))
    expect(w.panes.has('taxi-meter')).toBe(false)
    expect(w.store.has('pane')).toBe(false)
  })

  test('outside the fullscreen layout /meter pane says how to get one', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    expect((await $.command.run(run('pane', false))).text).toMatch(/\/tui fullscreen/)
    expect(w.panes.has('taxi-meter')).toBe(false)
  })

  test('a remembered pane reopens at session start', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { store: new Map([['pane', true]]) })
    await $.session.start(session)
    expect(w.panes.has('taxi-meter')).toBe(true)
  })

  test('drawn inline on the main screen it closes itself instead', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { store: new Map([['pane', true]]) })
    await $.session.start(session)
    expect(w.panes.has('taxi-meter')).toBe(true)
    await mountPane($, { ...paneProps, placement: 'inline' })
    expect(w.panes.has('taxi-meter')).toBe(false)
  })

  test('shows the fare, where it goes, and who spent it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('pane'))
    const ui = await mountPane($)
    expect(await texts(ui)).toMatch(/no requests yet/i)
    await step($, w, usage())
    await $.agent.spawn(spawnInput({ model: 'claude-haiku-5-5' }))
    await step($, w, usage({ model: 'claude-haiku-5-5' }), 'a1')
    w.official.usd = 1
    const shown = await texts(ui)
    expect(shown).toMatch(/\$0\.14/)
    expect(shown).toMatch(/output/)
    expect(shown).toMatch(/cache write/)
    expect(shown).toMatch(/cache read/)
    expect(shown).toMatch(/main/)
    expect(shown).toMatch(/find the pane code/)
    expect(shown).toMatch(/\/cost \$1\.00/)
  })

  test('each row who spent it is drawn with a Clawd', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('pane'))
    await step($, w, usage())
    await $.agent.spawn(spawnInput())
    await step($, w, usage(), 'a1')
    const heads = await (await mountPane($)).findAll({ type: 'Text', text: '▐▛███▜▌' })
    expect(heads).toHaveLength(2)
  })

  test('main stays orange and each agent gets a colour of its own', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('pane'))
    await step($, w, usage())
    for (const id of ['a1', 'a2']) {
      await $.agent.spawn(spawnInput())
      await step($, w, usage(), id)
    }
    const colors = (await (await mountPane($)).findAll({ type: 'Text', text: '▐▛███▜▌' })).map(h => h.props.color)
    expect(colors).toHaveLength(3)
    expect(colors.filter(c => c === 'claude')).toHaveLength(1)
    expect(new Set(colors).size).toBe(3)
  })

  test('a running agent walks, and stands still once it is done', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('pane'))
    await $.agent.spawn(spawnInput())
    await step($, w, usage(), 'a1')
    const ui = await mountPane($)
    const legs = async () => (await ui.findAll({ type: 'Text', text: /[▘▝]/ })).map(t => t.text).join('|')
    const first = await legs()
    await clock.advance(400)
    expect(await legs()).not.toBe(first)
    await $.turn.complete(turnDone('a1'))
    const still = await legs()
    await clock.advance(1000)
    expect(await legs()).toBe(still)
  })

  test('past the row limit the cheapest agents fold into one line', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('pane'))
    for (let i = 1; i <= 10; i++) {
      await $.agent.spawn(spawnInput({ description: `job ${i}` }))
      await step($, w, usage({ output_tokens: i * 1000 }), 'a' + i)
    }
    const shown = await texts(await mountPane($))
    expect(shown).toMatch(/job 10/)
    expect(shown).not.toMatch(/job 1\b/)
    expect(shown).toMatch(/\+\d+ more/)
  })
})

// Plan windows as a Team or Max subscription reports them, measured from START.
const iso = (ms: number) => new Date(START + ms).toISOString()
const H = 3600000
const limits = (fiveHour: number, sevenDay: number): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed: fiveHour, resetsAt: iso(2 * H + 14 * 60000) },
  { kind: 'seven_day', percentUsed: sevenDay, resetsAt: iso(76 * H) },
]

describe('plan usage', () => {
  test('the pane shows each plan window, how full it is and when it resets, before any request', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    w.official.limits = limits(58, 21)
    await $.session.start(session)
    await $.command.run(run('pane'))
    const shown = await texts(await mountPane($))
    expect(shown).toMatch(/PLAN/)
    expect(shown).toMatch(/5h[\s█░]+58%\s+resets in 2h 14m/)
    expect(shown).toMatch(/7d[\s█░]+21%\s+resets in 3d 4h/)
  })

  test('off a subscription there is no plan block', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('pane'))
    await step($, w, usage())
    expect(await texts(await mountPane($))).not.toMatch(/PLAN/)
    expect((await $.command.run(run(''))).text).not.toMatch(/plan/)
  })

  test('a window turns warning past 80% and error past 95%, and at its limit the pane says so', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    w.official.limits = limits(97, 85)
    await $.session.start(session)
    await $.command.run(run('pane'))
    const ui = await mountPane($)
    const pcts = await ui.findAll({ type: 'Text', text: /^\s*\d+%$/ })
    expect(pcts.map(t => t.props.color)).toEqual(['error', 'warning'])
    expect(await texts(ui)).not.toMatch(/extra usage/)
    w.official.limits = limits(100, 85)
    await $.session.measure({ context: { window: 1000000, tokens: 0 }, rateLimits: w.official.limits, changed: ['rateLimits'] })
    expect(await texts(ui)).toMatch(/extra usage/)
  })

  test('a window that moves redraws the pane', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    w.official.limits = limits(10, 5)
    await $.session.start(session)
    await $.command.run(run('pane'))
    const ui = await mountPane($)
    expect(await texts(ui)).toMatch(/10%/)
    w.official.limits = limits(11, 5)
    await $.session.measure({ context: { window: 1000000, tokens: 0 }, rateLimits: w.official.limits, changed: ['rateLimits'] })
    expect(await texts(ui)).toMatch(/11%/)
  })

  test('/meter answers with the plan windows too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    w.official.limits = limits(58, 21)
    await $.session.start(session)
    expect((await $.command.run(run(''))).text).toMatch(/plan: 5h 58% \(resets in 2h 14m\) · 7d 21% \(resets in 3d 4h\)/)
    await step($, w, usage())
    expect((await $.command.run(run(''))).text).toMatch(/plan: 5h 58%/)
  })
})
