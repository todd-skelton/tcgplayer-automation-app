// @ts-check
// ShipmentToPack (pack_step.rs): packing from the keyboard (`services/packShortcut.ts`). Space
// marks the shipment packed, or unmarks a packed one; Left
// and Right move to the shipment before or after. `shortcut` leaves a key to a field, to the
// control it presses, to a dialog, and to the browser when a modifier is held.

import { shortcut } from "corten/keys";

/**
 * The parts the keys use.
 * @typedef {object} PackKeys
 * @property {HTMLAnchorElement} previous
 * @property {HTMLAnchorElement} next
 * @property {HTMLFormElement} toggle
 */

/** A link to the shipment before or after, when there is one. @param {HTMLAnchorElement} link */
const go = (link) => {
  if (link.hasAttribute("href")) link.click();
};

/** @param {KeyboardEvent} event @param {HTMLElement} screen @param {PackKeys} k */
export function keys(event, screen, k) {
  const key = shortcut(event, screen);
  if (key === "ArrowLeft") {
    event.preventDefault();
    go(k.previous);
  } else if (key === "ArrowRight") {
    event.preventDefault();
    go(k.next);
  } else if (key === "Space") {
    event.preventDefault();
    k.toggle.requestSubmit();
  }
}