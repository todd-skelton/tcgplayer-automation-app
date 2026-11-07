// @ts-check
// PublishDialog (publish_dialog.rs): the selection's count and quantity change as SKUs are
// checked, and the buttons that check every SKU or none.
import { PublishItem, rows } from "corten/views";
/** @import { Message, NumberFormat } from "corten" */
/** @import { Holds } from "corten/views" */

/**
 * What the count reads and writes. The markup builds it once, `js::Selection { .. }`.
 * @typedef {object} Selection
 * @property {Holds<PublishItem, HTMLUListElement>} items
 * @property {HTMLSpanElement} note
 * @property {HTMLButtonElement} submit
 * @property {Message<"count" | "delta">} selected what the checked SKUs read, by their count
 * @property {Message<"count">} publish
 * @property {NumberFormat} number
 */

/** @param {PublishItem} item */
function box(item) {
  return /** @type {HTMLInputElement} */ (item.el.querySelector("input[type=checkbox]"));
}

/**
 * Writes how many SKUs are checked and how much they change the quantity.
 * @param {Selection} s
 */
export function count(s) {
  let checked = 0;
  let delta = 0;
  for (const item of rows(s.items, PublishItem)) {
    if (!box(item).checked) continue;
    checked += 1;
    delta += item.delta;
  }
  s.note.textContent = s.selected({
    count: checked,
    delta: (delta >= 0 ? "+" : "") + s.number(delta),
  });
  s.note.parentElement?.setAttribute("data-changes", String(delta !== 0));
  s.submit.textContent = s.publish({ count: s.number(checked) });
}

/**
 * Shows the buttons only a script can run, and counts what is checked.
 * @param {Selection} s @param {HTMLSpanElement} tools
 */
export function start(s, tools) {
  tools.hidden = false;
  count(s);
}

/**
 * Checks every ready SKU, or none. Setting `checked` sends no `change`, so one is sent: the list's
 * CheckboxGroup checks again whether any box is checked, and the form's handler counts.
 * @param {Selection} s @param {boolean} checked
 */
export function checkAll(s, checked) {
  /** @type {HTMLInputElement | null} */
  let first = null;
  for (const item of rows(s.items, PublishItem)) {
    const each = box(item);
    each.checked = checked;
    first ??= each;
  }
  if (first) first.dispatchEvent(new Event("change", { bubbles: true }));
  else count(s);
}

/**
 * A form's `reset` event comes before the fields are reset, so the count waits for them.
 * @param {Selection} s
 */
export function afterReset(s) {
  setTimeout(() => count(s));
}
