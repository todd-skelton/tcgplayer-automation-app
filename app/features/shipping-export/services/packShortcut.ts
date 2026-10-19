/** What a key press on the Pack step asks for, if anything. */
export type PackShortcut = "previous" | "next" | "toggle-packed";

/** The focused element, reduced to what decides whether a shortcut applies. */
export interface PackKeyTarget {
  tagName: string;
  /** The input type, for inputs. */
  type?: string;
  role: string | null;
  isContentEditable: boolean;
}

/** The parts of a key press the Pack step reads. */
export interface PackKeyPress {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  /** Null when the page itself has focus. */
  target: PackKeyTarget | null;
}

const CLICKABLE_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset"]);
const CONTROL_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
const CONTROL_ROLES = new Set(["button", "checkbox", "menuitem", "option", "tab", "switch", "radio"]);

function takesTyping(target: PackKeyTarget): boolean {
  if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
    return true;
  }
  return target.tagName === "INPUT" && !CLICKABLE_INPUT_TYPES.has(target.type ?? "text");
}

/** Whether Space already means "activate" for the focused element. */
function isControl(target: PackKeyTarget): boolean {
  return (
    CONTROL_TAGS.has(target.tagName) ||
    target.tagName === "INPUT" ||
    (target.role !== null && CONTROL_ROLES.has(target.role))
  );
}

/**
 * Space marks the current shipment packed and the arrows move between
 * shipments. Keys typed into a field stay with the field, and Space on a
 * focused control activates that control instead.
 */
export function packShortcutFor(press: PackKeyPress): PackShortcut | null {
  if (press.defaultPrevented || press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) {
    return null;
  }
  if (press.target && takesTyping(press.target)) {
    return null;
  }
  if (press.key === "ArrowLeft") return "previous";
  if (press.key === "ArrowRight") return "next";
  if (press.key === " ") {
    return press.target && isControl(press.target) ? null : "toggle-packed";
  }
  return null;
}
