// SubmitsOnChange (parts.rs): a form that is sent whenever a control in it changes, so a setting
// is saved, a report read again or a batch picked by submitting the control's form.

/**
 * @param {Event} event
 */
export function submit(event) {
  const control = event.target;
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
    control.form?.requestSubmit();
  }
}
