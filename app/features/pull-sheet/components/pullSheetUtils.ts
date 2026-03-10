export function getConditionChipColor(
  condition: string
):
  | "default"
  | "primary"
  | "secondary"
  | "error"
  | "info"
  | "success"
  | "warning" {
  const normalized = condition.toLowerCase();
  if (normalized.includes("near mint")) return "default";
  if (normalized.includes("lightly played")) return "info";
  if (normalized.includes("moderately played")) return "success";
  if (normalized.includes("heavily played")) return "warning";
  if (normalized.includes("damaged")) return "error";
  return "default";
}

export function getReleaseYear(
  releaseDate?: string | null
): string | undefined {
  if (!releaseDate) return undefined;

  const parsedDate = new Date(releaseDate);
  if (Number.isNaN(parsedDate.getTime())) return undefined;

  return String(parsedDate.getFullYear());
}

export function getPullSheetDisplayName(
  productName: string,
  cardNumber?: string | null
): string {
  if (!cardNumber) return productName;

  if (productName.toLowerCase().includes(cardNumber.toLowerCase())) {
    return productName;
  }

  return `${productName} - ${cardNumber}`;
}

export function getConditionBorderColor(condition: string): string {
  const normalized = condition.toLowerCase();
  if (normalized.includes("near mint")) return "#9e9e9e";
  if (normalized.includes("lightly played")) return "#2196f3";
  if (normalized.includes("moderately played")) return "#4caf50";
  if (normalized.includes("heavily played")) return "#ff9800";
  if (normalized.includes("damaged")) return "#f44336";
  return "#9e9e9e";
}

export function getConditionBackdropColor(condition: string): string {
  const normalized = condition.toLowerCase();
  if (normalized.includes("near mint")) return "rgba(24,24,24,0.82)";
  if (normalized.includes("lightly played")) return "rgba(12,61,114,0.84)";
  if (normalized.includes("moderately played")) return "rgba(27,94,32,0.84)";
  if (normalized.includes("heavily played")) return "rgba(130,66,0,0.86)";
  if (normalized.includes("damaged")) return "rgba(127,18,18,0.88)";
  return "rgba(24,24,24,0.82)";
}

export function getConditionOverlay(condition: string): string {
  const normalized = condition.toLowerCase();
  if (normalized.includes("near mint")) return "none";
  if (normalized.includes("lightly played"))
    return "linear-gradient(135deg, rgba(33,150,243,0.08) 0%, transparent 100%)";
  if (normalized.includes("moderately played"))
    return "linear-gradient(135deg, rgba(76,175,80,0.12) 0%, transparent 100%)";
  if (normalized.includes("heavily played"))
    return "linear-gradient(135deg, rgba(255,152,0,0.16) 0%, transparent 100%)";
  if (normalized.includes("damaged"))
    return "linear-gradient(135deg, rgba(244,67,54,0.18) 0%, transparent 100%)";
  return "none";
}

export function getVariantLabel(variant: string): string {
  if (variant.toLowerCase().includes("holofoil") && variant.toLowerCase().includes("reverse")) {
    return "Reverse Holo";
  }
  if (variant.toLowerCase().includes("holofoil")) return "Holo";
  if (variant.toLowerCase().includes("1st edition")) return "1st Ed";
  return variant;
}

export function getVariantGlow(variant: string): string {
  if (!variant) return "none";
  const v = variant.toLowerCase();
  if (v.includes("holofoil") && v.includes("reverse")) {
    return "0 0 8px rgba(148, 103, 189, 0.5)";
  }
  if (v.includes("holofoil")) {
    return "0 0 8px rgba(255, 215, 0, 0.5)";
  }
  return "none";
}

export function getTcgPlayerImageUrl(
  productId: number,
  size: string = "200x200"
): string {
  return `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_${size}.jpg`;
}

export function getImageFilter(condition: string): string {
  const normalized = condition.toLowerCase();
  if (normalized.includes("near mint")) return "none";
  if (normalized.includes("lightly played")) return "brightness(0.95)";
  if (normalized.includes("moderately played"))
    return "brightness(0.88) saturate(0.9)";
  if (normalized.includes("heavily played"))
    return "brightness(0.8) saturate(0.8) contrast(0.95)";
  if (normalized.includes("damaged"))
    return "brightness(0.7) saturate(0.7) contrast(0.9)";
  return "none";
}
