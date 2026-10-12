import type { Elements, RenderNode } from 'claude-code'

import { BUCKETS, fmtTok, fmtUsd, rowUsd, shortModel, totals, type Buckets, type Ledger, type Row } from './meter'

export const PANE = 'taxi-meter'

/** Agent rows the pane lists before folding the cheapest into one line. */
const MAX_ROWS = 6

/** Clawd, the Claude Code mascot, three rows tall and padded to one width; a running agent's legs alternate between the two last rows. */
const CLAWD = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  ', '  ▝▝ ▘▘  ']
/** Main is Claude orange; each agent takes the next of these theme colours in the order it was spawned. */
const AGENT_COLORS = ['suggestion', 'success', 'autoAccept', 'warning', 'planMode', 'ide']
/** Narrower than this, a row drops Clawd for a one-cell glyph. */
const CLAWD_MIN_WIDTH = 28

const NAMES: Record<keyof Buckets, string> = { output: 'output', write: 'cache write', read: 'cache read', input: 'input' }
const COLORS: Record<keyof Buckets, string> = { output: 'claude', write: 'warning', read: 'success', input: 'suggestion' }

/** What /cost has added since the meter started, and the part of it no request the meter saw accounts for. */
export function official(l: Ledger, costUsd: number | null): { since: number; other: number } | null {
  if (costUsd === null) return null
  const since = Math.max(0, costUsd - l.baselineUsd)
  return { since, other: since - totals(l).total }
}

/** Cells per bucket that sum to `width`, largest remainders first. */
export function split(usd: Buckets, width: number): Array<[keyof Buckets, number]> {
  const total = usd.input + usd.write + usd.read + usd.output
  if (total <= 0) return []
  const exact = BUCKETS.map(k => [k, usd[k] / total * width] as const)
  const cells = exact.map(([k, x]) => [k, Math.floor(x)] as [keyof Buckets, number])
  let left = width - cells.reduce((n, [, c]) => n + c, 0)
  const order = exact.map(([, x], i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left-- <= 0) break
    cells[i][1]++
  }
  return cells
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round(part / whole * 100) : 0) + '%'

const ranked = (l: Ledger) => [...l.rows].sort((a, b) => rowUsd(b) - rowUsd(a))

const rowName = (r: Row) => (r.id === 'main' ? 'main' : r.label)

function rowColor(l: Ledger, r: Row): string {
  if (r.id === 'main') return 'claude'
  const i = l.rows.filter(x => x.id !== 'main').indexOf(r)
  return AGENT_COLORS[i % AGENT_COLORS.length]
}

export const anyRunning = (l: Ledger) => l.rows.some(r => r.running)

const rowDetail = (r: Row) =>
  [shortModel(r.model), r.id === 'main' ? null : r.kind, `${r.requests} req`, `${fmtTok(r.tokens.input + r.tokens.write + r.tokens.read)} in`, `${fmtTok(r.tokens.output)} out`, r.unpriced ? `${r.unpriced} unpriced` : null]
    .filter(Boolean).join(' · ')

/** The text a bare /meter answers with. */
export function cardText(l: Ledger, costUsd: number | null): string {
  const t = totals(l)
  if (t.requests === 0) return 'taxi-meter: no requests yet since the meter started.'
  const o = official(l, costUsd)
  const lines = [
    `taxi-meter: ${fmtUsd(t.total)} over ${t.requests} request${t.requests === 1 ? '' : 's'}` +
      (o ? ` · /cost ${fmtUsd(o.since)} since the meter started · other ${fmtUsd(Math.max(0, o.other))}` : ''),
    'where it goes: ' + BUCKETS.map(k => `${NAMES[k]} ${fmtUsd(t.usd[k])} (${pct(t.usd[k], t.total)})`).join(' · '),
  ]
  for (const r of ranked(l)) {
    const state = r.id === 'main' ? '' : r.running ? ' · running' : ' · done'
    lines.push(`  ${fmtUsd(rowUsd(r)).padStart(7)}  ${rowName(r)} · ${rowDetail(r)}${state}`)
  }
  return lines.join('\n')
}

type Els = Pick<Elements['terminal'], 'Box' | 'Text'>

/** `frame` counts the walk's steps: on odd ones a running agent's Clawd has lifted the other pair of legs. */
export function drawPane({ Box, Text }: Els, bodyColumns: number, l: Ledger, costUsd: number | null, frame = 0): RenderNode {
  const width = Math.max(16, Math.min(48, bodyColumns - 2))
  const t = totals(l)
  const o = official(l, costUsd)

  const heading = (text: string, aside?: string) => Box({ marginTop: 1, children: [
    Text({ bold: true, dimColor: true, children: [text] }),
    ...(aside ? [Text({ dimColor: true, children: [`  ${aside}`] })] : []),
  ] })
  // A label on the left and an amount flush right, cut to the pane's width.
  const line = (left: RenderNode[], leftLen: number, right: string, rightColor?: string, w = width) => Text({ wrap: 'truncate-end', children: [
    ...left,
    ' '.repeat(Math.max(1, w - leftLen - right.length)),
    Text({ color: rightColor, children: [right] }),
  ] })

  const fare = Box({ flexDirection: 'column', children: [
    Text({ bold: true, dimColor: true, children: ['TAXI METER'] }),
    Text({ children: [
      Text({ bold: true, color: 'claude', children: [fmtUsd(t.total)] }),
      Text({ dimColor: true, children: [`  ${t.requests} request${t.requests === 1 ? '' : 's'}`] }),
    ] }),
    ...(o ? [Text({ dimColor: true, wrap: 'truncate-end', children: [
      `/cost ${fmtUsd(o.since)}`,
      o.other >= 0.005 ? ` · other ${fmtUsd(o.other)}` : '',
    ] })] : []),
  ] })

  if (t.requests === 0) {
    return Box({ flexDirection: 'column', children: [fare, Box({ marginTop: 1, children: [Text({ dimColor: true, wrap: 'wrap', children: ['No requests yet. The meter runs from the next one.'] })] })] })
  }

  const segments = split(t.usd, width)
  const where = Box({ flexDirection: 'column', children: [
    heading('WHERE IT GOES'),
    Text({ children: segments.map(([k, n]) => Text({ color: COLORS[k], children: ['█'.repeat(n)] })) }),
    ...BUCKETS.map(k => {
      const label = `${NAMES[k].padEnd(12)}${pct(t.usd[k], t.total).padStart(4)}  ${fmtTok(t.tokens[k])}`
      return line([Text({ color: COLORS[k], children: ['■ '] }), Text({ children: [label] })], 2 + label.length, fmtUsd(t.usd[k]))
    }),
  ] })

  const all = ranked(l)
  const shown = all.slice(0, MAX_ROWS)
  const folded = all.slice(MAX_ROWS)
  const top = rowUsd(all[0]) || 1
  const clawd = width >= CLAWD_MIN_WIDTH
  // Beside Clawd the bar has a line of its own; without him it shares one with the detail.
  const barWidth = clawd ? Math.min(24, width - CLAWD[0].length - 1) : Math.max(4, Math.min(12, width - 30))
  const who = Box({ flexDirection: 'column', children: [
    heading('WHO SPENT IT', `${l.rows.length - (l.rows.some(r => r.id === 'main') ? 1 : 0)} agents`),
    ...shown.map(r => {
      const name = rowName(r)
      const color = rowColor(l, r)
      const filled = Math.max(rowUsd(r) > 0 ? 1 : 0, Math.round(rowUsd(r) / top * barWidth))
      const bar = Text({ wrap: 'truncate-end', children: [
        Text({ color, children: ['▬'.repeat(filled)] }),
        Text({ dimColor: true, children: ['─'.repeat(barWidth - filled)] }),
      ] })
      const state = r.id === 'main' ? '' : r.running ? ' · running' : ' · done'
      if (!clawd) {
        const glyph = r.id === 'main' ? '◆ ' : r.running ? '● ' : '✓ '
        return Box({ flexDirection: 'column', children: [
          line([Text({ color, children: [glyph] }), Text({ bold: r.running, children: [name] })], 2 + name.length, fmtUsd(rowUsd(r))),
          Text({ wrap: 'truncate-end', children: ['  ', bar, Text({ dimColor: true, children: [' ' + rowDetail(r) + state] })] }),
        ] })
      }
      // Clawd stands beside the row's three lines, walking while his agent runs and dimmed once it is done.
      const textWidth = width - CLAWD[0].length - 1
      const legs = r.running && frame % 2 ? CLAWD[3] : CLAWD[2]
      return Box({ flexDirection: 'row', children: [
        Box({ flexDirection: 'column', marginRight: 1, children: [CLAWD[0], CLAWD[1], legs].map(part => Text({ color, dimColor: r.id !== 'main' && !r.running, children: [part] })) }),
        Box({ flexDirection: 'column', children: [
          line([Text({ bold: r.running, children: [name] })], name.length, fmtUsd(rowUsd(r)), undefined, textWidth),
          bar,
          Text({ dimColor: true, wrap: 'truncate-end', children: [rowDetail(r) + state] }),
        ] }),
      ] })
    }),
    ...(folded.length
      ? [line([Text({ dimColor: true, children: [`+${folded.length} more`] })], `+${folded.length} more`.length, fmtUsd(folded.reduce((n, r) => n + rowUsd(r), 0)))]
      : []),
  ] })

  const notes: string[] = []
  if (o && o.other >= 0.005) notes.push('other: /cost spend the meter saw no request for (other mods\' model calls, compaction, web searches, fast mode).')
  notes.push('Cache writes are priced at the one-hour rate.')

  return Box({ flexDirection: 'column', children: [
    fare, where, who,
    Box({ marginTop: 1, flexDirection: 'column', children: notes.map(n => Text({ dimColor: true, wrap: 'wrap', children: [n] })) }),
  ] })
}
