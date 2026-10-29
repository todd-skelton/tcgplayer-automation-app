// SubmitsOnChange (configuration_screen.rs): a form that is sent whenever a control in it changes,
// as the React app saved a setting or read a report again, by submitting the control's form.

/**
 * @param {Event} event
 */
export function submit(event) {
  const control = event.target;
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
    control.form?.requestSubmit();
  }
}
