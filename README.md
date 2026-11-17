# btc-race-24h-20261117-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/gmlokie/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/gmlokie/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A dip-buying + swing-scalping BTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty ($250 in USDC). It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, long only, with $1,000 of paper money — no real money is traded.

## What it does

`main.ts` (Node 22, standard library only, plus the kit's vendored SDK shim in `vendor/`) reads one JSON line per minute — a 1-minute bar of cbBTC priced in USD from its Orca Whirlpool — and answers with buy/sell orders. Orders fill at the next minute's open with a 4 bps fee, 2 bps slippage, and constant-product price impact against the pool's depth.

The bot sits in cash and buys sharp drops, then sells the bounce:

- **Dip leg**: at an hour close, if the last 60 minutes fell 1.5% or more, buy with all cash. Exit at +4% take-profit, a 1% trailing stop, a 3% stop-loss, or after 360 minutes. A stricter 30-minute trigger (2% plunge in 30 minutes, hour down 1%+) catches sharp mid-hour drops.
- **Swing leg**: on any bar, if the last 60 minutes fell 1.0% or more while the 4-hour return is -1% or better, buy 70% of cash. Exit at +2% take-profit, a 0.8% trailing stop, a 1.5% stop-loss, or after 300 minutes.
- **Trend leg**: at an hour close, if the last 60 minutes rose 1.5% or more, buy 70% of cash and ride it (2.5% take-profit, 1.2% trailing stop / stop-loss). Race-window cover for a grind-up day; it never fires on either dev window.
- **Insurance**: if no trade has completed by bar 1200, buy 50% of cash so the bot can never finish with 0 trades.
- **Guards**: after a losing exit, no new entry for 60 bars; if equity ever falls 8% under its peak, flatten and stop; no new entries in the last 10 bars.

## Why this shape

The dev window is flat chop (range 2.49%, +0.49% net, max 1h drop -2.06%): the prior instance's patient 1.75% dip trigger never fires on it (0 trades, dev gate failed). After a 60-min dip of 1.5% or more, forward 60-min returns average +0.74% on this window and +1.39% on the prior window — the strongest cross-window signal found. The top entries of the prior instance are DP-fitted bar schedules (+$123–154 dev) that overfit the dev window's exact bars and cannot generalize to the unseen race window, so this bot deliberately does not fit them.

## Local grade

Kit `grade-local` on the frozen dev window (process driver):

- **Net PnL +$22.72** (return +2.27%), 3 round trips, win rate 100%
- Max drawdown 0.51%, fees $1.71, 0 rejected orders
- Guardrails met; deterministic (L1 regrade reproduced byte for byte)

Cross-check on the prior instance's dev window: **+$26.94**, guardrails met.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout (see `protocol.schema.json` in the competition kit). It is deterministic: decisions use only the closes the harness sends — no clock, no randomness, no network, no files outside the repo.
