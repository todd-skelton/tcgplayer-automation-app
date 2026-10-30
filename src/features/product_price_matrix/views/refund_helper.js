// @ts-check
// RefundHelper (refund_helper.rs): the dispute drawn again as the operator changes it, from the
// prices the page drew (`ConditionRefundHelper.tsx`). Choosing another variant or sold condition
// starts from the price the buyer most likely paid for it, and the received condition follows
// the sold one until it is chosen.
import { keep } from "corten";
import { PricedCondition, rows } from "corten/views";
/** @import { Message, MoneyFormat } from "corten" */
/** @import { Holds } from "corten/views" */

/**
 * The helper's controls, what it writes, and the text it writes with.
 * @typedef {object} Dispute
 * @property {HTMLSelectElement} variant
 * @property {HTMLSelectElement} sold
 * @property {HTMLSelectElement} received
 * @property {HTMLInputElement} paid
 * @property {HTMLParagraphElement} same
 * @property {HTMLParagraphElement} enter
 * @property {HTMLParagraphElement} unpriced
 * @property {HTMLDivElement} results
 * @property {HTMLElement} refund
 * @property {HTMLParagraphElement} keeps
 * @property {HTMLParagraphElement} no_loss
 * @property {HTMLParagraphElement} sells
 * @property {HTMLElement} market
 * @property {HTMLParagraphElement} versus
 * @property {HTMLParagraphElement} no_market
 * @property {HTMLElement} relist
 * @property {HTMLParagraphElement} relist_note
 * @property {Map<string, HTMLDivElement>} notes
 * @property {Holds<PricedCondition, HTMLUListElement>} cells
 * @property {Message<"condition">} unpriced_text
 * @property {Message<"net" | "condition">} keeps_text
 * @property {Message<"condition" | "paid">} no_loss_text
 * @property {Message<"received" | "received_price" | "sold_price" | "sold">} sells_text
 * @property {Message<"difference" | "received" | "received_price" | "sold" | "sold_price">} versus_text
 * @property {Message<"condition">} relist_text
 * @property {Message<"condition" | "days">} relist_eta_text
 * @property {MoneyFormat} money
 * @property {string} none what a missing price reads
 */

const kept = () => keep(() => ({ receivedChosen: false }));

/** @param {number} value */
const cents = (value) => Math.round(value * 100);

/** A price of more than nothing, else null. @param {number} value */
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/**
 * The refund that leaves the buyer paying what the received condition sells for (`refund`).
 * @param {number | null} paid @param {number | null} received
 */
function refundOf(paid, received) {
  if (paid === null || received === null) return null;
  const refund = cents(Math.max(0, paid - received)) / 100;
  return { refund, net: cents(paid - refund) / 100 };
}

/** @param {Dispute} d */
function cellsOf(d) {
  return [...rows(d.cells, PricedCondition)].filter((c) => c.variant === d.variant.value);
}

/** The variant's conditions offered; a hidden choice moves to the first. @param {Dispute} d */
function offer(d) {
  const conditions = cellsOf(d).map((c) => c.condition);
  for (const select of [d.sold, d.received]) {
    for (const option of select.options) option.hidden = !conditions.includes(option.value);
    if (!conditions.includes(select.value)) select.value = conditions[0] ?? "";
  }
  return conditions;
}

/** The condition after the sold one, or the sold one when it is the worst. @param {Dispute} d @param {string[]} conditions */
function followSold(d, conditions) {
  const index = conditions.indexOf(d.sold.value);
  d.received.value = conditions[Math.min(conditions.length - 1, index + 1)] ?? "";
}

/** @param {Dispute} d */
function startPaid(d) {
  const sold = cellsOf(d).find((c) => c.condition === d.sold.value);
  d.paid.value = sold?.paid ?? "";
}

/** @param {Dispute} d @param {number | null} value */
const usd = (d, value) => (value === null ? d.none : d.money(cents(value)));

/** The server's `signed`, signed by hand until money formats carry their sign (corten#419). @param {Dispute} d @param {number} value */
function signed(d, value) {
  const n = cents(value);
  return (n > 0 ? "+" : n < 0 ? "-" : "") + d.money(Math.abs(n));
}

/** @param {Dispute} d */
function draw(d) {
  const of = cellsOf(d);
  const sold = of.find((c) => c.condition === d.sold.value);
  const received = of.find((c) => c.condition === d.received.value);
  const soldName = d.sold.value;
  const receivedName = d.received.value;
  const paid = positive(Number(d.paid.value));
  const same = soldName !== "" && soldName === receivedName;
  const bySellAt = refundOf(paid, positive(received?.ladder ?? 0));
  const byMarket = refundOf(paid, positive(received?.market_ladder ?? 0));
  d.same.hidden = !same;
  d.enter.hidden = same || paid !== null;
  d.unpriced.hidden = same || paid === null || bySellAt !== null;
  d.unpriced.textContent = d.unpriced_text({ condition: receivedName });
  d.results.hidden = same || bySellAt === null;
  if (bySellAt === null || paid === null) return;
  d.refund.textContent = usd(d, bySellAt.refund);
  d.keeps.hidden = bySellAt.refund === 0;
  d.no_loss.hidden = bySellAt.refund !== 0;
  d.keeps.textContent = d.keeps_text({ net: usd(d, bySellAt.net), condition: receivedName });
  d.no_loss.textContent = d.no_loss_text({ condition: receivedName, paid: usd(d, paid) });
  d.sells.textContent = d.sells_text({
    received: receivedName,
    received_price: usd(d, positive(received?.ladder ?? 0)),
    sold_price: usd(d, positive(sold?.ladder ?? 0)),
    sold: soldName,
  });
  d.market.textContent = byMarket ? usd(d, byMarket.refund) : d.none;
  d.versus.hidden = byMarket === null;
  d.no_market.hidden = byMarket !== null;
  if (byMarket) {
    d.versus.textContent = d.versus_text({
      difference: signed(d, byMarket.refund - bySellAt.refund),
      received: receivedName,
      received_price: usd(d, positive(received?.market_ladder ?? 0)),
      sold: soldName,
      sold_price: usd(d, positive(sold?.market_ladder ?? 0)),
    });
  }
  d.relist.textContent = usd(d, positive(received?.sell_at ?? 0));
  d.relist_note.textContent = received?.days
    ? d.relist_eta_text({ condition: receivedName, days: received.days })
    : d.relist_text({ condition: receivedName });
  const shown = `${d.variant.value}|${receivedName}`;
  for (const [key, notes] of d.notes) notes.hidden = key !== shown;
}

/** A variant or a condition chosen. @param {Event} event @param {Dispute} d */
export function changed(event, d) {
  const state = kept();
  if (event.target === d.variant) {
    const before = d.received.value;
    const conditions = offer(d);
    if (!state.receivedChosen || !conditions.includes(before)) followSold(d, conditions);
    startPaid(d);
  } else if (event.target === d.sold) {
    if (!state.receivedChosen) followSold(d, cellsOf(d).map((c) => c.condition));
    startPaid(d);
  } else if (event.target === d.received) {
    state.receivedChosen = true;
  }
  draw(d);
}

/** The price paid typed. @param {Event} event @param {Dispute} d */
export function typed(event, d) {
  if (event.target === d.paid) draw(d);
}
