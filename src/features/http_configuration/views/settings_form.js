// @ts-check
// SettingsForm (settings_screen.rs): shows or hides the auth cookie as it is typed.

/** @param {HTMLInputElement} toggle @param {HTMLInputElement} cookie */
export function reveal(toggle, cookie) {
  cookie.type = toggle.checked ? "text" : "password";
}
