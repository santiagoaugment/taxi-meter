# taxi-meter

A Claude Code mod: a sidebar meter of what the session spends. It shows every model request, on the main conversation and in each subagent, priced by token type, next to `/cost`'s official total, and on a subscription how full the plan's 5-hour and 7-day windows are.

```
TAXI METER
$4.82  37 requests
/cost $5.10 · other $0.28

PLAN
5h ██████░░░░░  58%  resets in 2h 14m
7d ██░░░░░░░░░  21%  resets in 3d 4h

WHERE IT GOES
██████████████▓▓▓▓▓▓▓▓▓░░░░░░░
■ output        44%  96k      $2.10
■ cache write   33%  200k     $1.60
■ cache read    19%  4.5M     $0.90
■ input          4%  55k      $0.22

WHO SPENT IT  3 agents
◆ main                        $3.10
  ▬▬▬▬▬▬▬▬▬▬▬▬ opus 5.5 · 29 req · 4.6M in · 80k out
● find the pane code          $0.92
  ▬▬▬▬──────── haiku 5.5 · Explore · 6 req · …
```

## Commands

- `/meter`: the same figures as text
- `/meter pane`: open the sidebar (needs the fullscreen layout, `/tui fullscreen`); it reopens at session start
- `/meter pane off`: close it, and stop reopening it
- `/meter reset`: start the meter over. `/clear` does this too.

## How it counts

- Each `turn.step` (one API request) adds its four token counts to the row of the loop that made it: `main`, or the subagent's id from `agent.spawn`.
- Dollars are the token counts × list prices (`hooks/meter.ts`, checked 2026-10-12). Cache writes are priced at the one-hour rate, which Claude Code uses; a five-minute write costs 1.25× base instead of 2×.
- **other** is `/cost`'s total since the meter started minus what the meter priced: model calls it never sees as a request (other mods' forks, compaction), web searches ($10 per 1,000), fast mode's premium.
- On a subscription, the dollars are what the same usage would cost at API list prices. What the plan actually runs out of is its windows, so **PLAN** shows each one the last response reported (`$.session.usage().rateLimits`): green, then warning from 80% and error from 95%, with a note once one reaches its limit. The windows are the account's, shared with every other session on it, so the meter does not split them by agent. Off a subscription the block is not drawn.

## Install

```
claude plugin marketplace add ~/Projects/taxi-meter
claude plugin install taxi-meter@santi-taxi-meter --scope user
```

To ship a change: edit, `claude plugin test .`, bump the version in `.claude-plugin/plugin.json`, commit, then `claude plugin marketplace update santi-taxi-meter` and `claude plugin update taxi-meter@santi-taxi-meter`.
