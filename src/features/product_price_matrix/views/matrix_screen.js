// @ts-check
// MatrixScreen (matrix_screen.rs): pricing by the policy takes most of a minute, so the
// Suggested Pricing link says it is working until the priced page replaces this one, as the React
// button showed a spinner. Without a script the browser's own loading indicator does.

/** @param {MouseEvent} event @param {HTMLAnchorElement} link */
export function pricing(event, link) {
  // A click that opens another tab or window leaves this page as it is.
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  link.setAttribute("aria-busy", "true");
}
