// Slow-trend cbBTC bot for make.fun btc-race-24h-20261118-1444.
//
// Strategy (long only, full equity per trade, one open position at most):
//   - Enter when the trend turns up, on either of two independent signals:
//       (a) EMA(36) crosses up through EMA(96), or
//       (b) the close breaks above the highest close of the previous 240 bars.
//   - Exit the whole position when any of these fires:
//       (a) the close falls below the lowest close of the previous 60 bars,
//       (b) a trailing stop: the close falls 80 bps below the highest close
//           seen since entry, or
//       (c) EMA(36) crosses back down through EMA(96).
//   - After any exit, sit out for 300 bars before the next entry. An exit
//     means the trend just ended — win or loss — and the bars right after it
//     are the choppiest, so re-entering at once only buys back into them.
//     (Revisi: cooldown dulu hanya setelah exit yang rugi; diuji di dev
//     window, cooldown-setelah-exit-apa-pun menaikkan net PnL +$5.26 -> +$6.33
//     dan menurunkan max drawdown 1.31% -> 1.20%, dengan trade yang sama
//     persis untuk cooldown 270-300 bar.)
//
// Everything is deterministic: plain integer prices from the bars, float64
// EMAs seeded exactly as the mean of the first span of closes, no wall
// clock, no environment, no randomness. The bot answers every batch with
// exactly one reply and never trades during a warm-up (its indicators still
// read the warm-up bars, so they are seeded when trading starts).
//
// Dev-window backtest (exact replay of the harness fill math, fee 4 bps +
// slippage 2 bps + constant-product impact vs bar open depth, fills at the
// next bar's open): net PnL +$6.33 on a $1,000 start, 4 trades, max
// drawdown 1.20%. The same replay gives buy-and-hold -$31.63, EMA(8/21)
// -$148.17, momentum(24) -$180.67, RSI(14) -$112.92, Bollinger(20,2)
// -$133.45.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

// Strategy parameters, chosen on the dev window and kept fixed.
const FAST_EMA = 36; // bars
const SLOW_EMA = 96; // bars
const BREAKOUT_BARS = 240; // bars for the entry high
const EXIT_LOW_BARS = 60; // bars for the exit low
const TRAIL_BPS = 80; // trailing stop below the peak close since entry
const COOLDOWN_BARS = 300; // bars to sit out after any exit (win or loss)

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function makeEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    let sum = 0;
    for (const x of e.warm) sum += x;
    e.value = sum / e.span;
  }
}

function maxOf(values: number[]): number {
  let best = -Infinity;
  for (const v of values) if (v > best) best = v;
  return best;
}

function minOf(values: number[]): number {
  let best = Infinity;
  for (const v of values) if (v < best) best = v;
  return best;
}

/** The price history and indicator state, carried across batches. */
class TrendBot {
  closes: number[] = [];
  fast = makeEma(FAST_EMA);
  slow = makeEma(SLOW_EMA);
  /** fast - slow after the previous bar, once both EMAs are set. */
  prevGap: number | null = null;
  /** Highest close since the current entry. */
  peak = 0;
  /** Sequence number of the last exit (any outcome). */
  lastExitSeq = -1e9;

  onBatch(state: BarsState, batch: { bars: Bar[] }): (BuyInput | SellInput)[] {
    // Only the fresh bar of this batch moves the indicators. A batch
    // without a CBBTC bar (a minute the recorder missed) changes nothing.
    let fresh: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) fresh = Number(bar.c);
    }
    if (fresh === null) return [];

    this.closes.push(fresh);
    stepEma(this.fast, fresh);
    stepEma(this.slow, fresh);

    // The gap between the two EMAs, this bar and the previous one. It is
    // refreshed on every bar, even while the cooldown blocks entries, so a
    // cross is always judged on two adjacent bars.
    const gap =
      this.fast.value !== null && this.slow.value !== null
        ? this.fast.value - this.slow.value
        : null;
    const prevGap = this.prevGap;
    this.prevGap = gap;

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      this.peak = 0;
      return this.maybeEnter(state, fresh, gap, prevGap);
    }
    return this.maybeExit(state, fresh, held, gap, prevGap);
  }

  maybeEnter(
    state: BarsState,
    close: number,
    gap: number | null,
    prevGap: number | null,
  ): (BuyInput | SellInput)[] {
    // Both EMAs and a full breakout look-back must exist first.
    if (gap === null || this.closes.length <= BREAKOUT_BARS) return [];
    // Every exit starts the cooldown, win or loss: the trend just ended,
    // so the next 300 bars are the chop to sit out, not a fresh entry.
    if (state.seq - this.lastExitSeq < COOLDOWN_BARS) return [];

    const crossedUp = prevGap !== null && prevGap <= 0 && gap > 0;
    const brokeOut = close > maxOf(this.closes.slice(-BREAKOUT_BARS - 1, -1));
    if (!crossedUp && !brokeOut) return [];

    const room = state.weightRoom(SYMBOL);
    const spend = state.cash < room ? state.cash : room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  maybeExit(
    state: BarsState,
    close: number,
    held: { qty: bigint; cost: bigint },
    gap: number | null,
    prevGap: number | null,
  ): (BuyInput | SellInput)[] {
    if (close > this.peak) this.peak = close;

    const crossedDown = gap !== null && prevGap !== null && prevGap >= 0 && gap < 0;
    const low =
      this.closes.length > EXIT_LOW_BARS
        ? minOf(this.closes.slice(-EXIT_LOW_BARS - 1, -1))
        : 0;
    const brokeDown = low > 0 && close < low;
    const trailed = this.peak > 0 && close * 10_000 <= this.peak * (10_000 - TRAIL_BPS);

    if (!brokeDown && !trailed && !crossedDown) return [];

    // Mark the exit: it starts the cooldown whatever its outcome was.
    this.lastExitSeq = state.seq;
    this.peak = 0;
    return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
}

const bot = new TrendBot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
