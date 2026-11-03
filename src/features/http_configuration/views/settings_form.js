// @ts-check
// SettingsForm (settings_screen.rs): the button inside the auth cookie's box shows or hides it.
// Its name stays "Show"; aria-pressed says whether the cookie is shown.

/** @param {HTMLButtonElement} toggle @param {HTMLInputElement} cookie */
export function reveal(toggle, cookie) {
  const shown = cookie.type === "password";
  cookie.type = shown ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(shown));
}
