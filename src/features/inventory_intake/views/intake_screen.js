// @ts-check
// IntakeScreen (intake_screen.rs): a set searched, sorted and paged in the browser, and counting
// from the keyboard.
//
// The page brings every product the filters keep (`listed`). Typing in the search narrows a
// set's at once (`set_search.js`, the server's rule), and the sort, the pages, the rows per page
// and the condition are drawn here too, with no request: the rows are `IntakeRow` views copied
// from the screen's template. A card number in every set is searched by the server, and another
// set, product line or filter is answered with the parts that change with it and the products
// it keeps (the filters are a GET `data-patch` form): the rows are drawn from them here, and the
// address says which set is shown, a new entry in the history, as a page would be.
//
// In a count field: + and - step it, typing sets it (sent when the field is left or Enter is
// pressed), Enter on a field not yet changed adds one, and either way goes back to the search;
// Up and Down move to the row above or below. Anywhere on the screen: Ctrl+Up and Ctrl+Down (Cmd
// on a Mac) step the condition, Page Up and Page Down the set, with an empty search to type in.
//
// A field shows its new count at once and its form is sent with it. A change made while one is
// on its way waits for that answer, then goes with the latest count; the answer is the form with
// the count stored, which a refused change takes back.
import { keep } from "corten";
import { IntakeRow, rows } from "corten/views";
import { search as searchSet } from "./set_search.js";
/** @import { Message, NumberFormat } from "corten" */
/** @import { Holds } from "corten/views" */
/** @typedef {import("../../../../types/app").IntakeListing} IntakeListing */
/** @typedef {import("../../../../types/app").IntakeCounts} IntakeCounts */
/** @typedef {import("../../../../types/app").ListedProduct} ListedProduct */

/**
 * The screen's parts the keys and the drawing reach, and the text it writes.
 * @typedef {object} Keys
 * @property {HTMLFormElement} filters
 * @property {HTMLSelectElement} conditions
 * @property {HTMLLabelElement} set The Set field, whose select a set's answer replaces.
 * @property {HTMLInputElement} search
 * @property {HTMLButtonElement} go The Search button, which sends a search.
 * @property {HTMLSelectElement} size
 * @property {HTMLInputElement} sort The filters' sort, sent while the products are shown Z to A.
 * @property {Holds<IntakeRow, HTMLTableSectionElement>} rows
 * @property {Holds<IntakeRow, HTMLTemplateElement>} template
 * @property {HTMLTableElement} table
 * @property {HTMLDivElement} paging
 * @property {HTMLSpanElement} range
 * @property {HTMLButtonElement} previous
 * @property {HTMLButtonElement} next
 * @property {HTMLDivElement} none
 * @property {Message<"first" | "last" | "total">} shown
 * @property {Message<"product" | "condition">} quantity
 * @property {Message<"condition">} unavailable
 * @property {NumberFormat} number
 */

/**
 * What the screen keeps between events.
 * @typedef {object} State
 * @property {Map<string, number>} baseline Each field's count when it took focus or last sent one, by SKU.
 * @property {Set<string>} typed SKUs whose field was typed into and not sent.
 * @property {Set<string>} untouched SKUs whose field has not changed since it took focus.
 * @property {string | null} focused The SKU whose field has focus, so a field an answer replaced is not taken as new focus.
 * @property {IntakeListing | null} listing The products the page brought.
 * @property {Map<number, number>} counts The counts not yet queued, by SKU.
 * @property {number} page The page shown, counting from 1.
 * @property {boolean} descending Whether the products are shown by name, Z to A.
 * @property {Keys | null} keys The screen's parts, for an answer's counts.
 */

/** @returns {State} */
const state = () =>
  keep(() => ({
    baseline: new Map(),
    typed: new Set(),
    untouched: new Set(),
    focused: null,
    listing: null,
    counts: new Map(),
    page: 1,
    descending: false,
    keys: null,
  }));

/** The set select, the one in the page now. @param {Keys} k */
const setsOf = (k) => /** @type {HTMLSelectElement} */ (k.set.control);

/** @param {unknown} el @returns {el is HTMLInputElement} */
const isCount = (el) => el instanceof HTMLInputElement && el.dataset.sku !== undefined;

/** A count as typed: a whole number, never below zero. @param {string} text */
const parse = (text) => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

/** The count field a row shows, if the product has a SKU in the condition chosen. @param {Element} row */
const fieldOf = (row) => Array.from(row.querySelectorAll("input")).find((i) => isCount(i) && i.checkVisibility()) ?? null;

/** @param {HTMLInputElement} field */
const focusField = (field) => {
  field.focus();
  field.select();
};

/** The first product's count field takes focus, as after a search. @param {Keys} k */
function focusFirst(k) {
  for (const row of Array.from(k.rows.rows)) {
    const field = fieldOf(row);
    if (field) return focusField(field);
  }
}


/**
 * A product's row in the condition chosen, as the server fills one (`RowOf::new`). A row already
 * drawn for the same SKU keeps its element, so its count and its form's submit key stay its own;
 * a new one is copied from the template, whose form holds no key, and the runtime gives it one
 * when its count is first sent, since a key two forms shared would apply only the first's count.
 * @param {Keys} k @param {IntakeListing} listing @param {ListedProduct} product @param {Map<number, IntakeRow>} drawn
 */
function rowOf(k, listing, product, drawn) {
  const s = state();
  const sealed = product.skus.length === 1;
  const at = sealed ? 0 : k.conditions.selectedIndex;
  const sku = product.skus[at] ?? 0;
  const named = sealed ? listing.unopened : (listing.conditions[at] ?? "");
  // Without a SKU, the product's first one negated, so no two rows share a key (`key_of`).
  const key = sku !== 0 ? sku : -(product.skus.find((other) => other !== 0) ?? 0);
  const kept = drawn.get(key);
  const count = kept && Number.isFinite(kept.count) ? kept.count : (s.counts.get(sku) ?? 0);
  const printed = product.printing === "" ? product.name : product.name + " " + product.printing;
  const [before = "", after = ""] = listing.picture;
  return {
    key,
    condition: sealed ? "" : k.conditions.value,
    missing: sku === 0,
    picture: before + product.product + after,
    set: listing.sets[product.set] ?? "",
    sku_name: sku === 0 ? k.unavailable({ condition: named }) : product.printing === "" ? named : named + " " + product.printing,
    printing: product.printing,
    form: sku === 0 ? "" : listing.count_form + sku,
    sku,
    count,
    label: k.quantity({ product: printed, condition: named }),
    name: product.name,
  };
}

/**
 * Draws what the search finds, in the order chosen, on the page shown, in the condition chosen,
 * and says which and how many; the address says so too, so a reload or a link shows the same.
 * @param {Keys} k
 */
function draw(k) {
  const s = state();
  const listing = s.listing;
  if (!listing) return;
  const query = k.search.value;
  const found = listing.searches ? searchSet(listing.products, query) : listing.products.slice();
  if (s.descending) found.reverse();
  const size = Number(k.size.value);
  const pages = Math.max(1, Math.ceil(found.length / size));
  s.page = Math.min(Math.max(1, s.page), pages);
  const from = (s.page - 1) * size;
  const page = found.slice(from, from + size);
  const list = rows(k.rows, IntakeRow, k.template);
  /** @type {Map<number, IntakeRow>} */
  const drawn = new Map();
  for (const row of list) drawn.set(row.key, row);
  list.replace(page.map((product) => rowOf(k, listing, product, drawn)));
  k.table.hidden = page.length === 0;
  k.none.hidden = !(listing.searches && query.trim() !== "" && found.length === 0);
  k.paging.hidden = pages <= 1;
  k.range.textContent = k.shown({ first: String(from + 1), last: String(from + page.length), total: k.number(found.length) });
  k.previous.disabled = s.page <= 1;
  k.next.disabled = s.page >= pages;
  const url = new URL(location.href);
  /** @param {string} name @param {string} value */
  const put = (name, value) => (value === "" ? url.searchParams.delete(name) : url.searchParams.set(name, value));
  put(k.conditions.name, k.conditions.value);
  put(k.size.name, k.size.value);
  put(k.sort.name, s.descending ? k.sort.value : "");
  put(listing.page_field, s.page > 1 ? String(s.page) : "");
  if (listing.searches) put(k.search.name, query.trim() === "" ? "" : query);
  history.replaceState(history.state, "", url);
  // The sort link, for a click that opens it elsewhere: this screen sorted the other way, from
  // its first page.
  const sorter = k.table.tHead?.querySelector("a[href]");
  if (sorter instanceof HTMLAnchorElement) {
    const other = new URL(url);
    other.searchParams.delete(listing.page_field);
    if (s.descending) other.searchParams.delete(k.sort.name);
    else other.searchParams.set(k.sort.name, k.sort.value);
    sorter.href = other.pathname + other.search;
  }
}

/**
 * The products the page brought, which the screen draws from from now on. Those a set's answer
 * brings are drawn at once with the counts the screen holds, and the address says which set it
 * is: a new history entry, so Back returns to the set before. A card number found in every set
 * puts focus on the first product's field, as after a search of the set.
 * @param {IntakeListing} listing
 */
export function listed(listing) {
  const s = state();
  const answered = s.listing !== null;
  s.listing = listing;
  s.page = listing.page;
  s.descending = listing.descending;
  const k = s.keys;
  if (!answered || !k) return;
  const to = new URL(listing.address, location.href);
  if (to.href !== location.href) history.pushState(null, "", to);
  k.sort.disabled = !s.descending;
  draw(k);
  if (!listing.searches && k.search.value.trim() !== "") focusFirst(k);
}

/**
 * The counts not yet queued, from the page or from a count's or a queue's answer: the rows the
 * screen makes show them, and a row of a SKU no longer counted (handed off to a batch) shows none.
 * @param {IntakeCounts} counts
 */
export function recounted(counts) {
  const s = state();
  const next = new Map(counts.counts.map((c) => [c.sku, c.quantity]));
  if (s.keys) {
    for (const row of rows(s.keys.rows, IntakeRow)) {
      if (row.sku !== 0 && s.counts.has(row.sku) && !next.has(row.sku)) row.count = 0;
    }
  }
  s.counts = next;
}

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

/** After the condition changed: the rows are drawn in it, and the focused row's field takes focus. @param {Keys} k @param {EventTarget | null} from */
function shown(k, from) {
  const row = from instanceof Element ? from.closest("tr") : null;
  const at = row && k.rows.contains(row) ? Array.from(k.rows.rows).indexOf(/** @type {HTMLTableRowElement} */ (row)) : -1;
  draw(k);
  const now = at >= 0 ? k.rows.rows[at] : undefined;
  const field = now ? fieldOf(now) : null;
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
  const sets = setsOf(k);
  if ((event.key === "PageUp" || event.key === "PageDown") && !sets.disabled) {
    // The next set, to search afresh: the search is emptied and keeps focus, and the filters go
    // with no submitter, so the set's answer comes (`submitted` keeps a search to the page), and
    // focus stays in the search, which the answer leaves as it is.
    event.preventDefault();
    const n = sets.options.length;
    sets.selectedIndex = (sets.selectedIndex + (event.key === "PageUp" ? -1 : 1) + n) % n;
    k.search.value = "";
    focusField(k.search);
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

/** Typing in a count field starts a count; in a set's search, narrows the products at once. @param {Event} event @param {Keys} k */
export function typed(event, k) {
  const s = state();
  if (event.target === k.search) {
    if (!s.listing?.searches) return;
    s.page = 1;
    return draw(k);
  }
  if (!isCount(event.target)) return;
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
 * count, and + goes back to the search.
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
  if (!(button instanceof HTMLButtonElement)) return;
  const field = button.form?.querySelector("input[data-sku]");
  if (!isCount(field)) return;
  const by = Number(button.dataset.step);
  step(field, by);
  if (by > 0) focusField(to.search);
}

/**
 * A filter changed: the condition and the rows per page are drawn at once, the search as it is
 * typed, and anything else is sent for the products it keeps.
 * @param {Event} event @param {Keys} k
 */
export function filtered(event, k) {
  const target = event.target;
  if (target === k.conditions) return shown(k, null);
  if (target === k.search) return;
  if (target === k.size && state().listing) {
    state().page = 1;
    return draw(k);
  }
  k.filters.requestSubmit();
}

/**
 * The filters sent. A search of the set sent from the search (Enter, or the Search button) is
 * drawn here with no request, and the first product's field takes focus, as after any search;
 * a card number in every set, and the other filters, are sent for the products they keep.
 * @param {SubmitEvent} event @param {Keys} k
 */
export function submitted(event, k) {
  if (event.submitter !== k.go || !state().listing?.searches) return;
  event.preventDefault();
  state().page = 1;
  draw(k);
  focusFirst(k);
}

/**
 * The products shown by name the other way, from the first page; a click with a modifier key is
 * left to the link, which opens the sorted screen.
 * @param {Event} event @param {HTMLElement} link @param {Keys} k
 */
export function sorted(event, link, k) {
  const s = state();
  if (!s.listing) return;
  if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
  event.preventDefault();
  s.descending = !s.descending;
  s.page = 1;
  link.closest("th")?.setAttribute("aria-sort", s.descending ? "descending" : "ascending");
  k.sort.disabled = !s.descending;
  draw(k);
}

/** The page before or after. @param {Keys} k @param {number} by */
export function turned(k, by) {
  state().page += by;
  draw(k);
}

/** The screen on the page; after a search, the first product's field takes focus. @param {Keys} k @param {boolean} searched */
export function start(k, searched) {
  state().keys = k;
  if (searched) focusFirst(k);
}
