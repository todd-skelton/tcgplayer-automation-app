/**
 * Where inventory entry had focus. Grid rows can remount while quantities
 * change, so focus is found again by its data-inventory-focus-id first and by
 * the original element only when it has none.
 */
export interface EntryFocus {
  focusId: string | null;
  element: HTMLElement;
  selection: {
    start: number | null;
    end: number | null;
    direction: "forward" | "backward" | "none" | null;
  } | null;
}

export function captureEntryFocus(target: EventTarget | null): EntryFocus | null {
  if (!(target instanceof HTMLElement) || target === document.body) return null;
  return {
    focusId: target.dataset.inventoryFocusId ?? null,
    element: target,
    selection:
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? { start: target.selectionStart, end: target.selectionEnd, direction: target.selectionDirection }
        : null,
  };
}

function findEntryElement(focus: EntryFocus): HTMLElement | null {
  const byId =
    focus.focusId === null
      ? null
      : Array.from(document.querySelectorAll<HTMLElement>("[data-inventory-focus-id]")).find(
          (element) => element.dataset.inventoryFocusId === focus.focusId,
        ) ?? null;
  const element = byId ?? focus.element;
  return element.isConnected ? element : null;
}

/** Focuses the captured place again, restoring its text selection only when asked. */
export function restoreEntryFocus(focus: EntryFocus | null, { withSelection = false } = {}): void {
  if (!focus) return;
  const element = findEntryElement(focus);
  // Inputs inside a disabled fieldset match :disabled without their own disabled property.
  if (!element || element.matches(":disabled")) return;
  element.focus({ preventScroll: true });
  if (!withSelection || !focus.selection) return;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
  const length = element.value.length;
  const start = Math.max(0, Math.min(focus.selection.start ?? 0, length));
  const end = Math.max(0, Math.min(focus.selection.end ?? start, length));
  element.setSelectionRange(start, end, focus.selection.direction ?? "none");
}
