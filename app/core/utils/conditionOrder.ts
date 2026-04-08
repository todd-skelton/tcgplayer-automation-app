import type { Condition } from "../../integrations/tcgplayer/types/Condition";

export type InventorySelectableCondition = Exclude<Condition, "Unopened">;

export const INVENTORY_CONDITION_ORDER: InventorySelectableCondition[] = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
];

export const DISPLAY_CONDITION_ORDER: Condition[] = [
  ...INVENTORY_CONDITION_ORDER,
  "Unopened",
];

const CONDITION_RANK = new Map(
  DISPLAY_CONDITION_ORDER.map((condition, index) => [condition, index] as const),
);

export function getConditionSortRank(condition: Condition): number {
  return CONDITION_RANK.get(condition) ?? Number.MAX_SAFE_INTEGER;
}

export function getNextInventoryCondition(
  condition: InventorySelectableCondition,
): InventorySelectableCondition {
  const currentIndex = INVENTORY_CONDITION_ORDER.indexOf(condition);

  if (currentIndex === -1) {
    return INVENTORY_CONDITION_ORDER[0];
  }

  return INVENTORY_CONDITION_ORDER[
    (currentIndex + 1) % INVENTORY_CONDITION_ORDER.length
  ];
}

export function getPreviousInventoryCondition(
  condition: InventorySelectableCondition,
): InventorySelectableCondition {
  const currentIndex = INVENTORY_CONDITION_ORDER.indexOf(condition);

  if (currentIndex === -1) {
    return INVENTORY_CONDITION_ORDER[INVENTORY_CONDITION_ORDER.length - 1];
  }

  return INVENTORY_CONDITION_ORDER[
    (currentIndex - 1 + INVENTORY_CONDITION_ORDER.length) %
      INVENTORY_CONDITION_ORDER.length
  ];
}
