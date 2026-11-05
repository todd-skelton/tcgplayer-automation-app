// @ts-check
// Layout (layout.rs): the toaster says when a data-patch submit got no answer the runtime could
// draw. The runtime dispatches `corten:error` on the form and leaves the page as it was; the kit's
// Toaster shows `corten:notice` but not this (corten#903). The message replaces the toast the way
// toaster.js replaces it for a notice, so the toaster's timer and close button follow it.

/** @param {number} status */
const said = (status) =>
  status === 0
    ? "The request did not go through. Check the connection, then send it again."
    : status >= 500
      ? `The server did not answer (status ${status}). Check whether the change was saved before sending it again.`
      : `The request failed (status ${status}).`;

/** @param {AbortSignal} signal */
export function connect(signal) {
  document.addEventListener(
    "corten:error",
    (event) => {
      const toast = document.getElementById("ui-toast");
      if (!toast) return;
      const next = /** @type {HTMLElement} */ (toast.cloneNode(false));
      next.hidden = false;
      // In a child, so a later notice (toaster.js copies the toast without its children) is not drawn as a failure.
      const message = document.createElement("span");
      message.dataset.tone = "failed";
      message.textContent = said(/** @type {CustomEvent<{ status: number }>} */ (event).detail.status);
      next.append(message);
      toast.replaceWith(next);
    },
    { signal },
  );
}
