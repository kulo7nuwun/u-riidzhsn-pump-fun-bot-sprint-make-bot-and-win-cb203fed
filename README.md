[![Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/kulo7nuwun/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/kulo7nuwun/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Momentum Sniper — Pump.fun Bot Sprint

A paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
competition on [make.fun](https://make.fun). It trades paper SOL on a replay
of pump.fun bonding-curve events (`agent-fun/replay/v2`), ranked on net PnL.

## Strategy

Most new pump.fun coins die fast, but the ones that catch a bid in their
first minutes run hard. The bot watches every fresh curve from its
`CreateEvent` and only buys when the tape itself confirms early demand:

- the price has risen at least **40%** off its opening quote, and still
  holds that rise **45 slots** later;
- at least **0.15 SOL** of buy volume across at least **8 buy trades**,
  with buys outweighing sells **4:1**;
- all inside a **180-slot** window after creation.

One fixed **0.05 SOL** stake per coin, at most **5 open positions**, and
every position is exited by rule, never by hope:

- **Take profit** at +100% over the filled entry price.
- **Stop loss** at −12%.
- **Trailing exit** once a coin has run +40%: sell if it gives back 10%
  from its peak.
- **Time exit**: flat after 900 slots (~6 minutes) whatever the price.

Everything is deterministic: every decision comes from the slot number and
the events in the batch, never from the clock or randomness, so two runs of
the same replay produce the same action log.

## Layout

- `main.ts` — the entrypoint: the strategy, run by the grader as
  `node /bot/main.ts`.
- `vendor/makefun-bot.ts` — the kit's replay shim (vendored as the kit
  instructs; it owns the wire protocol and is excluded from authorship).

## Local result (dev dataset)

Graded locally with the kit (`grade-local`, process driver), the bot
finishes the dev window at **−0.31 SOL net PnL** (−3.1% return, 90%
interval −0.62 … +0.03 SOL), **27.8% win rate** over 97 round trips on
**85 coins**, max drawdown **0.042** — guardrails met (≥20 coins,
drawdown ≤ 0.50). The dev window is a hard regime where most coins bleed;
the bot's edge is selectivity: each tightening of the entry filter cut the
loss roughly in half across six graded iterations.

## License

MIT — see [LICENSE](LICENSE).
