// @ts-check
// IntakeScreen (intake_screen.rs): counting from the keyboard, as the React screen did.
//
// In a count field: + and - step it, typing sets it (sent when the field is left or Enter is
// pressed), Enter on a field not yet changed adds one, and either way goes back to the search;
// Up and Down move to the row above or below. Anywhere on the screen: Ctrl+Up and Ctrl+Down (Cmd
// on a Mac) step the condition, Page Up and Page Down the set.
//
// A field shows its new count at once and its form is sent with it. A change made while one is
// on its way waits for that answer, then goes with the latest count; the answer is the form with
// the count stored, which a refused change takes back.
import { keep } from "corten";

/**
 * The screen's parts the keys move between.
 * @typedef {object} Keys
 * @property {HTMLFormElement} filters
 * @property {HTMLSelectElement} conditions
 * @property {HTMLSelectElement} sets
 * @property {HTMLInputElement} search
 * @property {HTMLTableSectionElement} rows
 */

/**
 * What the screen keeps between events.
 * @typedef {object} State
 * @property {Map<string, number>} baseline Each field's count when it took focus or last sent one, by SKU.
 * @property {Set<string>} typed SKUs whose field was typed into and not sent.
 * @property {Set<string>} untouched SKUs whose field has not changed since it took focus.
 * @property {string | null} focused The SKU whose field has focus, so a field an answer replaced is not taken as new focus.
 */

/** @returns {State} */
const state = () =>
  keep(() => ({
    baseline: new Map(),
    typed: new Set(),
    untouched: new Set(),
    focused: null,
  }));

/** @param {unknown} el @returns {el is HTMLInputElement} */
const isCount = (el) => el instanceof HTMLInputElement && el.dataset.sku !== undefined;

/** A count as typed: a whole number, never below zero. @param {string} text */
const parse = (text) => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

/** The count field a row shows for the condition chosen, if it has one. @param {Element} row */
const fieldOf = (row) => Array.from(row.querySelectorAll("input")).find((i) => isCount(i) && i.checkVisibility()) ?? null;

/** @param {HTMLInputElement} field */
const focusField = (field) => {
  field.focus();
  field.select();
};

/** Steps a field's count by `delta`, not below zero. @param {HTMLInputElement} field @param {number} delta */
function step(field, delta) {
  const s = state();
  commit(field);
  const sku = field.dataset.sku ?? "";
  const current = parse(field.value);
  const next = Math.max(0, current + delta);
  s.untouched.delete(sku);
  if (next === current) return;
  field.value = String(next);
  s.baseline.set(sku, next);
  field.form?.requestSubmit();
  // Typing next replaces the count rather than adding digits to it.
  if (document.activeElement === field) field.select();
}

/** Sends what was typed into a field, if it changed the count. @param {HTMLInputElement} field */
function commit(field) {
  const s = state();
  const sku = field.dataset.sku ?? "";
  if (!s.typed.has(sku)) return;
  s.typed.delete(sku);
  const quantity = parse(field.value);
  field.value = String(quantity);
  const before = s.baseline.get(sku) ?? parse(field.defaultValue);
  if (quantity === before) return;
  s.baseline.set(sku, quantity);
  field.form?.requestSubmit();
}

/** The field of the row `by` rows from the focused one that has a field. @param {HTMLTableSectionElement} rows @param {HTMLInputElement} field @param {number} by */
function move(rows, field, by) {
  const all = Array.from(rows.rows);
  let at = all.indexOf(/** @type {HTMLTableRowElement} */ (field.closest("tr")));
  while (at >= 0) {
    at += by;
    const row = all[at];
    if (!row) return;
    const next = fieldOf(row);
    if (next) return focusField(next);
  }
}

/** Shows another condition, keeping the row that had focus. @param {Keys} k @param {number} by @param {EventTarget | null} from */
function stepCondition(k, by, from) {
  const select = k.conditions;
  const n = select.options.length;
  select.selectedIndex = (select.selectedIndex + by + n) % n;
  shown(k, from);
}

/** After the condition changed: the address says it, and the focused row's field for it takes focus. @param {Keys} k @param {EventTarget | null} from */
function shown(k, from) {
  const url = new URL(location.href);
  url.searchParams.set(k.conditions.name, k.conditions.value);
  history.replaceState(history.state, "", url);
  const row = from instanceof Element ? from.closest("tr") : null;
  const field = row && k.rows.contains(row) ? fieldOf(row) : null;
  if (field) focusField(field);
}

/**
 * The screen's keys, wherever focus is on the page; keys pressed in something outside the screen
 * (the app bar, a dialog) are that thing's.
 * @param {KeyboardEvent} event @param {HTMLElement} screen @param {Keys} k
 */
export function keys(event, screen, k) {
  if (event.defaultPrevented || event.isComposing) return;
  const target = event.target;
  if (target instanceof Node && target !== document.body && !screen.contains(target)) return;
  const primary = (event.ctrlKey || event.metaKey) && !(event.ctrlKey && event.metaKey) && !event.altKey;
  if (primary && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    if (isCount(target)) commit(target);
    return stepCondition(k, event.key === "ArrowUp" ? -1 : 1, target);
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (isCount(target)) {
    const key = event.key;
    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      commit(target);
      return move(k.rows, target, key === "ArrowUp" ? -1 : 1);
    }
    if (key === "Enter") {
      event.preventDefault();
      const s = state();
      if (s.untouched.has(target.dataset.sku ?? "")) step(target, 1);
      else commit(target);
      return focusField(k.search);
    }
    if (key === "+" || key === "=" || event.code === "NumpadAdd") {
      event.preventDefault();
      return step(target, 1);
    }
    if (key === "-" || key === "_" || event.code === "NumpadSubtract") {
      event.preventDefault();
      return step(target, -1);
    }
  }
  if ((event.key === "PageUp" || event.key === "PageDown") && !k.sets.disabled) {
    event.preventDefault();
    const n = k.sets.options.length;
    k.sets.selectedIndex = (k.sets.selectedIndex + (event.key === "PageUp" ? -1 : 1) + n) % n;
    k.filters.requestSubmit();
  }
}

/** A field taking focus starts an edit: nothing typed yet, its text selected. @param {FocusEvent} event */
export function focused(event) {
  const s = state();
  const target = event.target;
  if (!isCount(target)) {
    s.focused = null;
    return;
  }
  const sku = target.dataset.sku ?? "";
  // The same SKU again: an answer replaced the field and focus moved to the new one.
  if (s.focused === sku) return;
  s.focused = sku;
  s.untouched.add(sku);
  s.typed.delete(sku);
  s.baseline.set(sku, parse(target.value));
  setTimeout(() => {
    if (document.activeElement === target) target.select();
  }, 0);
}

/** @param {Event} event */
export function typed(event) {
  if (!isCount(event.target)) return;
  const s = state();
  const sku = event.target.dataset.sku ?? "";
  s.typed.add(sku);
  s.untouched.delete(sku);
}

/** A field left after typing sends what was typed. @param {Event} event */
export function committed(event) {
  if (isCount(event.target)) commit(event.target);
}

/**
 * What a click in the table opens or returns to.
 * @typedef {object} Picture
 * @property {HTMLDialogElement} dialog
 * @property {HTMLImageElement} image
 * @property {HTMLInputElement} search
 */

/**
 * A product's picture opens in the dialog rather than a new tab; the - and + buttons step its
 * count, and + goes back to the search, as the React screen did.
 * @param {MouseEvent} event @param {Picture} to
 */
export function clicked(event, to) {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest("a");
  if (link) {
    event.preventDefault();
    to.image.src = link.href;
    return to.dialog.showModal();
  }
  const button = target?.closest("button[data-step]");
  const field = button?.parentElement?.querySelector("input[data-sku]");
  if (!(button instanceof HTMLButtonElement) || !isCount(field)) return;
  const by = Number(button.dataset.step);
  step(field, by);
  if (by > 0) focusField(to.search);
}

/**
 * A filter changed: the condition is shown at once, anything else reads the screen again.
 * @param {Event} event @param {Keys} k
 */
export function filtered(event, k) {
  const target = event.target;
  if (target === k.conditions) return shown(k, null);
  if (target === k.search) return;
  k.filters.requestSubmit();
}

/** After a search, the first product's field takes focus. @param {HTMLTableSectionElement} rows @param {boolean} searched */
export function start(rows, searched) {
  if (!searched) return;
  for (const row of Array.from(rows.rows)) {
    const field = fieldOf(row);
    if (field) return focusField(field);
  }
}
