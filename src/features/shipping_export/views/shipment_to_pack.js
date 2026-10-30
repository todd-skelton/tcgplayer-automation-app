// @ts-check
// ShipmentToPack (pack_step.rs): packing from the keyboard, as the React screen did
// (`services/packShortcut.ts`). Space marks the shipment packed, or unmarks a packed one; Left
// and Right move to the shipment before or after. Keys typed into a field stay with the field,
// Space on a focused control activates that control, and keys with a modifier are the browser's.

/**
 * The parts the keys use.
 * @typedef {object} PackKeys
 * @property {HTMLAnchorElement} previous
 * @property {HTMLAnchorElement} next
 * @property {HTMLFormElement} toggle
 */

const CLICKABLE_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset"]);
const CONTROL_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
const CONTROL_ROLES = new Set(["button", "checkbox", "menuitem", "option", "tab", "switch", "radio"]);

/** @param {HTMLElement} el */
const takesTyping = (el) =>
  el.isContentEditable ||
  el.tagName === "TEXTAREA" ||
  el.tagName === "SELECT" ||
  (el instanceof HTMLInputElement && !CLICKABLE_INPUTS.has(el.type));

/** Whether Space already means "activate" for the element. @param {HTMLElement} el */
const isControl = (el) => {
  const role = el.getAttribute("role");
  return CONTROL_TAGS.has(el.tagName) || el.tagName === "INPUT" || (role !== null && CONTROL_ROLES.has(role));
};

/** A link to the shipment before or after, when there is one. @param {HTMLAnchorElement} link */
const go = (link) => {
  if (link.hasAttribute("href")) link.click();
};

/** @param {KeyboardEvent} event @param {HTMLElement} screen @param {PackKeys} k */
export function keys(event, screen, k) {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  // A dialog or popover outside the shipment keeps its keys.
  if (target instanceof Node && target !== document.body && !screen.contains(target)) return;
  const el = target instanceof HTMLElement && target !== document.body ? target : null;
  if (el && takesTyping(el)) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    go(k.previous);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    go(k.next);
  } else if (event.key === " ") {
    if (el && isControl(el)) return;
    event.preventDefault();
    k.toggle.requestSubmit();
  }
}
