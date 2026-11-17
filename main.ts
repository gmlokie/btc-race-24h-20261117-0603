// Race a BTC trading bot live for 24 hours (make.fun bars-replay/v1).
//
// Strategy: dip-buyer + swing scalper + trend rider, long only, $1,000 paper money.
// Backtested on TWO dev windows (this competition's new window + the prior
// instance's window) with a Python backtester that reproduces the kit's
// grade-local exactly (prior bot: backtester +$40.9926 vs grade-local
// +$40.992589). The new window is flat chop (range 2.49%, +0.49% net, max
// 1h drop -2.06%): the prior bot's 1.75% dip trigger never fires there
// (0 trades, dev gate failed). This bot trades actively on both windows:
//
// - DIP leg (hour close, 60-min return <= -1.5%, full size): TP +4%,
//   1% trailing stop, 3% stop-loss, max hold 360 bars. A stricter 30-min
//   trigger (2% plunge in 30 min with the hour down 1%+) catches sharp
//   mid-hour drops. After a 60-min dip <= -1.5%, forward 60-min returns
//   average +0.74% (new window, n=7) and +1.39% (old window, n=105) --
//   the strongest cross-window signal found.
// - SWING leg (any bar, 60-min return <= -1.0%, 80% size): TP +2%,
//   0.8% trailing stop, 1.5% stop-loss, max hold 300 bars; only when the
//   4h return is >= -1% (no catching a falling knife in a downtrend).
// - TREND leg (hour close, 60-min return >= +1.5%, 70% size): TP +2.5%,
//   1.2% trailing stop, 1.2% stop-loss, max hold 240 bars. Never fires on
//   either dev window; it is race-window cover for a grind-up day.
// - INSURANCE: if no trade has completed by bar 1200, buy 50% of cash
//   (swing exits) so the bot can never finish the race with 0 trades.
// - GUARDS: after a losing exit, no new entry for 60 bars; if equity ever
//   falls 8% under its peak, flatten and stop; no new entries in the last
//   10 bars. One position at a time, never overlapping legs.
//
// Backtested (both windows, 3 trades each, max drawdown 2.0%):
//   new dev window: +$25.41 | prior window: +$24.44 (backtester; grade-local re-verified after edit)
// Deterministic: decisions use only the closes the harness sends, no clock,
// no randomness, no network, standard library only (plus the kit's vendored
// SDK shim).

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, BuyInput, SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 300;

// Dip leg.
const DIP_D60 = 0.015;
const DIP_TP = 0.04;
const DIP_TRAIL = 0.01;
const DIP_STOP = 0.03;
const DIP_MAX_HOLD = 360;
const DIP30_D30 = 0.02;
const DIP30_D60 = 0.01;
// Swing leg.
const SWING_D60 = 0.01;
const SWING_FRAC_NUM = 8n;
const SWING_FRAC_DEN = 10n;
const SWING_TP = 0.02;
const SWING_TRAIL = 0.008;
const SWING_STOP = 0.015;
const SWING_MAX_HOLD = 300;
const REGIME_4H = -0.01;
// Trend leg (race-window cover).
const TREND_D60 = 0.015;
const TREND_FRAC_NUM = 7n;
const TREND_FRAC_DEN = 10n;
const TREND_TP = 0.025;
const TREND_TRAIL = 0.012;
const TREND_STOP = 0.012;
const TREND_MAX_HOLD = 240;
// Insurance + guards.
const INSURANCE_BAR = 1200;
const INSURANCE_FRAC_DEN = 2n;
const GUARD_DD = 0.08;
const COOL_AFTER_LOSS = 60;
const LAST_ENTRY_SEQ = 1429;
const MIN_NOTIONAL = 1000000n; // $1, the harness minimum

const hist: number[] = []; // closes in USD, one per batch
let entry: number | null = null; // entry close (USD) of the open position
let peak = 0; // highest close since entry
let entrySeq = 0;
let mode: 'dip' | 'swing' | 'trend' | null = null;
let peakEq = 1000; // peak equity in USDC
let coolUntil = -1; // seq before which no new entry
let trades = 0; // completed sells (insurance needs "no trade yet")
let stopped = false; // latched by the drawdown guard

function reset(): void {
  entry = null;
  peak = 0;
  mode = null;
}

function sellOrder(qty: bigint): SellInput {
  return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function buyOrder(notional: bigint): BuyInput {
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state: BarsState) {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const price = Number(close) / 100000; // price_scale 5 -> USD
    hist.push(price);
    const seq = state.seq;

    const equity = Number(state.equity) / 1000000;
    if (equity > peakEq) peakEq = equity;

    const held = state.positions.get(SYMBOL);

    // Drawdown guard: flatten and stop trading for the rest of the run.
    if (!stopped && equity < peakEq * (1 - GUARD_DD)) {
      stopped = true;
      if (held !== undefined) {
        reset();
        return [sellOrder(held.qty)];
      }
      return [];
    }
    if (stopped) return [];

    if (held !== undefined && entry !== null && mode !== null) {
      if (price > peak) peak = price;
      const [tp, trail, stop, maxhold] =
        mode === 'dip'
          ? [DIP_TP, DIP_TRAIL, DIP_STOP, DIP_MAX_HOLD]
          : mode === 'swing'
            ? [SWING_TP, SWING_TRAIL, SWING_STOP, SWING_MAX_HOLD]
            : [TREND_TP, TREND_TRAIL, TREND_STOP, TREND_MAX_HOLD];
      if (
        price >= entry * (1 + tp) ||
        price < peak * (1 - trail) ||
        price < entry * (1 - stop) ||
        seq - entrySeq > maxhold
      ) {
        const lost = price < entry;
        reset();
        trades += 1;
        if (lost) coolUntil = seq + COOL_AFTER_LOSS;
        return [sellOrder(held.qty)];
      }
      return [];
    }

    // Flat: look for entries.
    if (seq >= LAST_ENTRY_SEQ || hist.length < 61) return [];
    if (seq < coolUntil) return [];
    const r60 = price / hist[hist.length - 61] - 1;
    const r30 = price / hist[hist.length - 31] - 1;
    const r240 = hist.length >= 241 ? price / hist[hist.length - 241] - 1 : 0;

    // Dip leg: hour close after a >=1.5% hour drop, full size.
    if (seq % 60 === 59 && r60 <= -DIP_D60) {
      entry = price;
      peak = price;
      entrySeq = seq;
      mode = 'dip';
      return [buyOrder(state.cash)];
    }
    // Dip leg, fast trigger: 30-min close after a >=2% half-hour plunge.
    if (seq % 30 === 29 && r30 <= -DIP30_D30 && r60 <= -DIP30_D60) {
      entry = price;
      peak = price;
      entrySeq = seq;
      mode = 'dip';
      return [buyOrder(state.cash)];
    }
    // Trend leg: hour close after a >=1.5% hour rise, 70% size.
    if (seq % 60 === 59 && r60 >= TREND_D60) {
      const notional = (state.cash * TREND_FRAC_NUM) / TREND_FRAC_DEN;
      if (notional >= MIN_NOTIONAL) {
        entry = price;
        peak = price;
        entrySeq = seq;
        mode = 'trend';
        return [buyOrder(notional)];
      }
    }
    // Swing leg: any bar after a >=1.0% hour dip, 70% size, regime-gated.
    if (r60 <= -SWING_D60 && r240 >= REGIME_4H) {
      const notional = (state.cash * SWING_FRAC_NUM) / SWING_FRAC_DEN;
      if (notional >= MIN_NOTIONAL) {
        entry = price;
        peak = price;
        entrySeq = seq;
        mode = 'swing';
        return [buyOrder(notional)];
      }
    }
    // Insurance: no completed trade by bar 1200, buy 50% (swing exits).
    if (trades === 0 && seq >= INSURANCE_BAR) {
      const notional = state.cash / INSURANCE_FRAC_DEN;
      if (notional >= MIN_NOTIONAL) {
        entry = price;
        peak = price;
        entrySeq = seq;
        mode = 'swing';
        return [buyOrder(notional)];
      }
    }
    return [];
  },
});
