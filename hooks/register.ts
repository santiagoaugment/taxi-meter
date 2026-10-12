import type { EngineInterface, Register, Timer } from 'claude-code'

import { freshLedger, noteDone, noteSpawn, recordStep, type Ledger } from './meter'
import { PANE, anyRunning, cardText, drawPane } from './pane'

const KEY_PANE = 'pane'
const TITLE = 'Taxi Meter'
/** How often a running agent's Clawd takes a step. */
const STEP_MS = 400

type State = { l: Ledger; surface: string | null; paneOpen: boolean; frame: number; walking: Timer | null }

/** Steps the Clawds while the pane is open and some agent runs, and stops the timer the moment neither holds. */
function walk($: EngineInterface, s: State) {
  const due = s.paneOpen && anyRunning(s.l)
  if (due && !s.walking) {
    s.walking = $.clock.every(STEP_MS, () => {
      s.frame++
      $.ui.invalidate('ui.render')
    })
  } else if (!due && s.walking) {
    s.walking.cancel()
    s.walking = null
  }
}

function redraw($: EngineInterface, s: State) {
  walk($, s)
  if (s.paneOpen) $.ui.invalidate('ui.render')
}

/** /cost's running total; free to read without arguments. */
async function costUsd($: EngineInterface): Promise<number | null> {
  return (await $.session.usage()).cost?.usd ?? null
}

/** The meter starts over from /cost's total now, so Other counts only what comes after. */
async function restart($: EngineInterface, s: State) {
  s.l = freshLedger((await costUsd($)) ?? 0)
  redraw($, s)
}

async function openPane($: EngineInterface, s: State) {
  s.paneOpen = true
  await $.ui.open({ id: PANE, title: TITLE })
  redraw($, s)
}

export const register: Register = on => {
  const s: State = { l: freshLedger(0), surface: null, paneOpen: false, frame: 0, walking: null }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.surface = e.surface
    await restart($, s)
    await $.command.register({
      name: 'meter',
      description: 'What this session has spent, per agent and per token type; pane opens the sidebar, reset starts over (taxi-meter)',
      argumentHint: '[pane | pane off | reset]',
      immediate: true,
    })
    // Unasked, the engine seats it only where the terminal is wide enough; narrower, it waits undrawn.
    if ((s.surface === 'terminal' || s.surface === 'desktop') && (await $.store.get(KEY_PANE)) === true) void openPane($, s)
    return r
  })

  // classic.SessionStart is withheld from user-tier plugins, so a /clear is seen here.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await restart($, s)
    return next(e)
  })

  // The meter only watches: a failure in it must never fail a request, a spawn or a turn, so each of these hooks swallows its own errors.

  // Every model request, the main loop's and each subagent's, once its response is whole.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      if (r.usage) {
        recordStep(s.l, e.agentId, r.usage, await $.clock.now())
        redraw($, s)
      }
    } catch {}
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.agentId) {
        // A named agent goes by its name; a teammate by the one its team settled on (`scout-2`), the part of its address before the `@`.
        const name = r.teammateId?.split('@')[0] ?? e.name
        noteSpawn(s.l, r.agentId, { label: name || e.description, kind: e.subagentType, model: r.model }, await $.clock.now())
        redraw($, s)
      }
    } catch {}
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId) {
        noteDone(s.l, e.agentId)
        redraw($, s)
      }
    } catch {}
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // A sidebar or nothing: inline on the terminal's main screen it would push the transcript around.
    if (e.surface === 'terminal' && e.props.placement === 'inline') {
      void $.ui.close({ id: PANE })
      return Box({ children: [] })
    }
    s.paneOpen = true
    return drawPane({ Box, Text }, e.props.bodyColumns, s.l, await costUsd($), s.frame)
  })

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id !== PANE) return r
    s.paneOpen = false
    walk($, s)
    // Closed by its own mark: the person no longer wants it at session start either.
    if (e.origin.kind === 'person') await $.store.delete(KEY_PANE).catch(() => {})
    return r
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (words[0] === 'reset') {
      await restart($, s)
      return { text: 'taxi-meter: reset; the meter runs from the next request.' }
    }
    if (words[0] === 'pane') {
      if (words[1] === 'off') {
        await $.store.delete(KEY_PANE)
        s.paneOpen = false
        walk($, s)
        await $.ui.close({ id: PANE })
        return { text: 'taxi-meter pane closed, and no longer opens at session start.' }
      }
      if (s.surface === 'terminal' && !e.presentation?.isFullscreen) {
        return { text: 'the taxi-meter pane docks beside the transcript in the fullscreen layout: run /tui fullscreen, then /meter pane' }
      }
      await $.store.set(KEY_PANE, true)
      await openPane($, s)
      return { text: 'taxi-meter pane open, and it reopens at session start; /meter pane off closes it for good.' }
    }
    return { text: cardText(s.l, await costUsd($)) }
  })
}
