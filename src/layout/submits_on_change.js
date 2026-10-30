// SubmitsOnChange (parts.rs): a form that is sent whenever a control in it changes, as the React
// app saved a setting, read a report again or picked a batch, by submitting the control's form.

/**
 * @param {Event} event
 */
export function submit(event) {
  const control = event.target;
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
    control.form?.requestSubmit();
  }
}
