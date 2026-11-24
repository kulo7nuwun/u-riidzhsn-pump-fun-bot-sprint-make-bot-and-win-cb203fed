// Momentum sniper for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most new pump.fun coins die fast, but the ones that catch a bid in
// their first minutes run hard. This bot watches every fresh curve from its
// CreateEvent, and only buys when the tape itself confirms early demand:
// the price has already risen at least 40% off its opening quote, still
// holds that rise 45 slots later, and at least 0.15 SOL of buy volume has
// hit it across at least 8 buy trades, with buys outweighing sells 4:1,
// inside a short window after creation. One small fixed stake per coin, at
// most five open positions, and every position is exited by rule, never by
// hope:
//   - take profit at +100% over the filled entry price,
//   - stop loss at -12%,
//   - trailing exit once a coin has run +40%: sell if it gives back 10%
//     from its peak,
//   - time exit: flat after 900 slots (~6 minutes) whatever the price.
// Everything is deterministic: every decision comes from the slot number
// and the events in the batch, never from the clock or randomness, so two
// runs of the same replay produce the same action log.
//
// Fees are steep on this harness (about 1.25% per side plus a fixed tx
// fee), so the 0.05 SOL stake and the +40% / -25% exits are sized so a
// winning round trip clears its fees several times over, while a stopped
// round trip stays small. The 20-coin guardrail is met by breadth: the bot
// keeps cycling its five slots through fresh coins all window long.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning

/** SOL staked on each fresh coin (0.05 SOL). */
const STAKE_LAMPORTS = 50_000_000n;
/** Smallest buy worth sending (0.02 SOL): below this the fees eat the trade. */
const MIN_STAKE_LAMPORTS = 20_000_000n;
/** Entry window: a coin is only considered this many slots after creation. */
const ENTRY_WINDOW_SLOTS = 180;
/** A coin must be at least this old (slots since first sight) before the
    bot buys it: the very first spike is usually the top. */
const MIN_ENTRY_AGE_SLOTS = 45;
/** Entry needs price >= 140% of its opening quote. */
const ENTRY_RISE_NUM = 140n;
const ENTRY_RISE_DEN = 100n;
/** Entry needs at least this much buy volume (0.15 SOL) in the window. */
const MIN_BUY_VOLUME_LAMPORTS = 150_000_000n;
/** Entry needs at least this many buy trades in the window. */
const MIN_BUY_TRADES = 8;
/** Take profit at +100% over the filled entry price. */
const TAKE_PROFIT_NUM = 200n;
const TAKE_PROFIT_DEN = 100n;
/** Stop loss at -12% under the filled entry price. */
const STOP_LOSS_NUM = 88n;
const STOP_LOSS_DEN = 100n;
/** Trailing exit arms once a coin has run +40% over entry. */
const TRAIL_ARM_NUM = 140n;
const TRAIL_ARM_DEN = 100n;
/** Once armed, sell when the price falls to 90% of its peak. */
const TRAIL_RET_NUM = 90n;
const TRAIL_RET_DEN = 100n;
/** Time exit: flat after this many slots held (~6 minutes). */
const MAX_HOLD_SLOTS = 900;
/** Slippage tolerance on fills (10000 bps = no effective cap): exits must
    execute even when the price is moving fast, or a stop becomes a bag. */
const BUY_SLIPPAGE_BPS = 10000;
const SELL_SLIPPAGE_BPS = 10000;

// ------------------------------------------------------------------ helpers

/** Compare two ratios a = aNum/aDen and b = bNum/bDen: true when a >= b. */
function ratioGte(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): boolean {
  return aNum * bDen >= bNum * aDen;
}

/** True when price p is at least `num/den` times reference price r. */
function priceAtLeast(
  pNum: bigint,
  pDen: bigint,
  rNum: bigint,
  rDen: bigint,
  num: bigint,
  den: bigint,
): boolean {
  // p >= r * num/den  <=>  pNum * rDen * den >= rNum * pDen * num
  return pNum * rDen * den >= rNum * pDen * num;
}

// ------------------------------------------------------------------ state

/** A fresh curve under observation, before any buy decision. */
interface Watch {
  baseNum: bigint; // opening price: virtual quote reserves ...
  baseDen: bigint; // ... over virtual token reserves.
  buyVolumeLamports: bigint;
  sellVolumeLamports: bigint;
  buyTrades: number;
  firstSlot: number;
  decided: boolean;
}

/** A filled position, with its entry price and running peak. */
interface Held {
  entryNum: bigint; // filled cost per token: quote spent ...
  entryDen: bigint; // ... over tokens received.
  peakNum: bigint; // highest price seen since entry ...
  peakDen: bigint; // ... as quote per token.
  entrySlot: number;
}

const watches = new Map<string, Watch>();
const held = new Map<string, Held>();

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch): Array<BuyInput | SellInput> {
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // 1. Fold this batch's fills into the position book. A buy fill fixes
    //    the entry price (what we actually paid per token); a sell fill, or
    //    a harness close (complete / flatten / write-off), ends the hold.
    for (const fill of batch.fills) {
      if (fill.status !== "filled") continue;
      if (fill.side === "buy") {
        const tokens = BigInt(fill.token_amount);
        const spent = BigInt(fill.quote_lamports);
        if (tokens > 0n && spent > 0n) {
          held.set(fill.mint, {
            entryNum: spent,
            entryDen: tokens,
            peakNum: spent,
            peakDen: tokens,
            entrySlot: fill.slot,
          });
        }
      } else {
        held.delete(fill.mint);
      }
    }
    // Prune holds whose position the harness already closed for us.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // 2. Watch this batch's events: new curves open a watch, trades on a
    //    watched curve add up buy volume. A curve that completes is done.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        if (!watches.has(event.mint) && !held.has(event.mint)) {
          const q = BigInt(event.virtual_quote_reserves);
          const t = BigInt(event.virtual_token_reserves);
          if (q > 0n && t > 0n) {
            watches.set(event.mint, {
              baseNum: q,
              baseDen: t,
              buyVolumeLamports: 0n,
              sellVolumeLamports: 0n,
              buyTrades: 0,
              firstSlot: event.slot,
              decided: false,
            });
          }
        }
      } else if (event.event === "TradeEvent") {
        const watch = watches.get(event.mint);
        if (watch !== undefined) {
          if (event.is_buy) {
            watch.buyVolumeLamports += BigInt(event.sol_amount);
            watch.buyTrades += 1;
          } else {
            watch.sellVolumeLamports += BigInt(event.sol_amount);
          }
        } else if (!held.has(event.mint)) {
          // First sight of this mint is a trade: open the watch at the
          // post-trade price so the rise is still measured from early on.
          const q = BigInt(event.virtual_quote_reserves);
          const t = BigInt(event.virtual_token_reserves);
          if (q > 0n && t > 0n) {
            watches.set(event.mint, {
              baseNum: q,
              baseDen: t,
              buyVolumeLamports: event.is_buy ? BigInt(event.sol_amount) : 0n,
              sellVolumeLamports: event.is_buy ? 0n : BigInt(event.sol_amount),
              buyTrades: event.is_buy ? 1 : 0,
              firstSlot: event.slot,
              decided: false,
            });
          }
        }
      } else {
        // CompleteEvent: the curve is over; stop watching it.
        watches.delete(event.mint);
      }
    }

    // 3. Exits first: every held position is checked against take-profit,
    //    stop-loss, the trailing rule and the time exit, in that order.
    for (const [mint, position] of state.positions) {
      const info = held.get(mint);
      const curve = state.curves.get(mint);
      if (info === undefined || curve === undefined || curve.complete) continue;
      const priceNum = curve.virtual_quote_reserves;
      const priceDen = curve.virtual_token_reserves;
      if (priceNum <= 0n || priceDen <= 0n) continue;

      // Track the peak for the trailing rule.
      if (ratioGte(priceNum, priceDen, info.peakNum, info.peakDen)) {
        info.peakNum = priceNum;
        info.peakDen = priceDen;
      }

      let sell = false;
      if (priceAtLeast(priceNum, priceDen, info.entryNum, info.entryDen, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN)) {
        sell = true; // take profit: +40%
      } else if (!priceAtLeast(priceNum, priceDen, info.entryNum, info.entryDen, STOP_LOSS_NUM, STOP_LOSS_DEN)) {
        sell = true; // stop loss: -25%
      } else if (
        priceAtLeast(info.peakNum, info.peakDen, info.entryNum, info.entryDen, TRAIL_ARM_NUM, TRAIL_ARM_DEN) &&
        !priceAtLeast(priceNum, priceDen, info.peakNum, info.peakDen, TRAIL_RET_NUM, TRAIL_RET_DEN)
      ) {
        sell = true; // trailing: armed at +25%, out after a 10% give-back
      } else if (batch.slot - info.entrySlot >= MAX_HOLD_SLOTS) {
        sell = true; // time exit: flat after ~10 minutes held
      }

      if (sell && orders.length < caps.max_orders_per_batch) {
        orders.push({
          side: "sell",
          mint,
          token_amount: position.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // 4. Entries: undecided watches, oldest first, that show confirmed
    //    early demand inside the entry window.
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const [mint, watch] of watches) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (watch.decided) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        watch.decided = true;
        continue;
      }
      if (batch.slot - watch.firstSlot > ENTRY_WINDOW_SLOTS) {
        // Window closed without a trigger: never chase this coin later.
        watch.decided = true;
        continue;
      }
      const priceNum = curve.virtual_quote_reserves;
      const priceDen = curve.virtual_token_reserves;
      if (priceNum <= 0n || priceDen <= 0n) continue;
      if (watch.buyTrades < MIN_BUY_TRADES) continue;
      if (watch.buyVolumeLamports < MIN_BUY_VOLUME_LAMPORTS) continue;
      // Buy dominance: the early flow must be net buying, not a few big
      // buys fighting heavy selling (the classic dump setup).
      if (watch.buyVolumeLamports < watch.sellVolumeLamports * 4n) continue;
      // Let the first spike settle: only buy a coin that is still up after
      // at least 30 slots of tape.
      if (batch.slot - watch.firstSlot < MIN_ENTRY_AGE_SLOTS) continue;
      if (!priceAtLeast(priceNum, priceDen, watch.baseNum, watch.baseDen, ENTRY_RISE_NUM, ENTRY_RISE_DEN)) {
        continue; // no confirmed +10% rise yet; keep watching
      }
      watch.decided = true;

      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_STAKE_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + txFee) continue;
      orders.push({
        side: "buy",
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      slots -= 1;
    }

    // 5. Housekeeping: forget watches that can never trigger again.
    for (const [mint, watch] of [...watches.entries()]) {
      if (watch.decided || batch.slot - watch.firstSlot > ENTRY_WINDOW_SLOTS) {
        watches.delete(mint);
      }
    }

    return orders;
  },
});
