// @ts-check
// LabelForm (label_management.rs): choosing other labels or another service draws the form
// again for it, as the React panel did as it changed. Without a script, the Apply button does.

/** @param {Event} event @param {HTMLButtonElement} redraw */
export function changed(event, redraw) {
  const control = event.target;
  if (control instanceof HTMLElement && control.hasAttribute("data-redraws")) {
    redraw.form?.requestSubmit(redraw);
  }
}
