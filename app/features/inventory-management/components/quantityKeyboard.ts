import type { GridRowId } from "@mui/x-data-grid";

export type QuantityNavigationDirection = "previous" | "next";

export type QuantityKeyboardAction =
  | { type: "change-condition"; direction: QuantityNavigationDirection }
  | { type: "move-focus"; direction: QuantityNavigationDirection }
  | { type: "adjust-quantity"; amount: number }
  | { type: "submit"; incrementQuantity: boolean }
  | { type: "none" };

interface QuantityKeyboardInput {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  untouchedSinceFocus: boolean;
}

export const getQuantityKeyboardAction = ({
  key,
  code,
  ctrlKey,
  altKey,
  metaKey,
  untouchedSinceFocus,
}: QuantityKeyboardInput): QuantityKeyboardAction => {
  if (ctrlKey && !altKey && !metaKey && key === "ArrowUp") {
    return { type: "change-condition", direction: "previous" };
  }

  if (ctrlKey && !altKey && !metaKey && key === "ArrowDown") {
    return { type: "change-condition", direction: "next" };
  }

  if (!ctrlKey && !altKey && !metaKey && key === "ArrowUp") {
    return { type: "move-focus", direction: "previous" };
  }

  if (!ctrlKey && !altKey && !metaKey && key === "ArrowDown") {
    return { type: "move-focus", direction: "next" };
  }

  if (!ctrlKey && !altKey && !metaKey && key === "Enter") {
    return { type: "submit", incrementQuantity: untouchedSinceFocus };
  }

  if (
    !ctrlKey &&
    !altKey &&
    !metaKey &&
    (key === "+" || key === "=" || code === "NumpadAdd")
  ) {
    return { type: "adjust-quantity", amount: 1 };
  }

  if (
    !ctrlKey &&
    !altKey &&
    !metaKey &&
    (key === "-" || key === "_" || code === "NumpadSubtract")
  ) {
    return { type: "adjust-quantity", amount: -1 };
  }

  return { type: "none" };
};

export const getAdjacentVisibleQuantityRowId = (
  rowIds: GridRowId[],
  currentRowId: GridRowId,
  direction: QuantityNavigationDirection,
): GridRowId | null => {
  const currentIndex = rowIds.findIndex((rowId) => rowId === currentRowId);
  if (currentIndex === -1) {
    return null;
  }

  const targetIndex = direction === "previous" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= rowIds.length) {
    return null;
  }

  return rowIds[targetIndex] ?? null;
};
