// @ts-check
// LabelForm (label_management.rs): choosing other labels shows what buying them says, and
// choosing another service fills in the package it gives the order (`LabelFormFill`), with no
// request. Without a script, the Apply button draws the
// form again on the server for them.

/** @typedef {import("../../../../types/app").LabelFormFill} LabelFormFill */

/**
 * What a choice of labels shows: each choice's note about labels already bought, with its
 * confirmation, and what the buy button says for it, by choice.
 * @typedef {object} Shown
 * @property {HTMLInputElement[]} choices The labels-to-buy radios.
 * @property {HTMLInputElement} shown The service the package was last filled for.
 * @property {Map<string, HTMLFieldSetElement>} notes
 * @property {Map<string, HTMLSpanElement>} says
 */

/** @param {Event} event @param {HTMLFormElement} form @param {Shown} s @param {LabelFormFill} fill */
export function changed(event, form, s, fill) {
  const control = event.target;
  if (control instanceof HTMLInputElement && s.choices.includes(control)) {
    chose(control.value, s);
  } else if (control instanceof HTMLSelectElement && control.name === fill.service) {
    filled(form, control.value, s.shown, fill);
  }
}

/** The note, its confirmation and the buy button's text for `choice`, and no other's. @param {string} choice @param {Shown} s */
function chose(choice, s) {
  for (const [key, note] of s.notes) {
    note.hidden = key !== choice;
    note.disabled = key !== choice;
  }
  for (const [key, text] of s.says) text.hidden = key !== choice;
}

/**
 * The package `service` gives the order, as the server draws it for a new service: a choice of
 * the service the package was filled for changes nothing.
 * @param {HTMLFormElement} form @param {string} service @param {HTMLInputElement} shown @param {LabelFormFill} fill
 */
function filled(form, service, shown, fill) {
  const drawn = fill.packages.find((p) => p.service === service);
  if (!drawn || shown.value === service) return;
  for (const { name, value } of drawn.fields) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = value;
  }
  shown.value = service;
}
