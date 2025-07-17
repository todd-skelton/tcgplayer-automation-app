import type { Condition } from "../tcgplayer/types/Condition";

/**
 * Maps card conditions to Material-UI color variants
 * Near Mint: default (gray)
 * Lightly Played: info (blue)
 * Moderately Played: success (green)
 * Heavily Played: warning (orange)
 * Damaged: error (red)
 */
export function getConditionColor(
  condition: Condition
):
  | "default"
  | "primary"
  | "secondary"
  | "error"
  | "info"
  | "success"
  | "warning" {
  switch (condition) {
    case "Near Mint":
      return "default";
    case "Lightly Played":
      return "info";
    case "Moderately Played":
      return "success";
    case "Heavily Played":
      return "warning";
    case "Damaged":
      return "error";
    default:
      return "default";
  }
}
