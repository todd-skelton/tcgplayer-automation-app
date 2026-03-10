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

export interface PullSheetVariantVisuals {
  hasVariant: boolean;
  isHolo: boolean;
  isReverseHolo: boolean;
  isFirstEdition: boolean;
  label: string | null;
  glow: string;
  effectType: "none" | "holo" | "reverse-holo";
  ambientBackground: string;
  shimmerGradient: string;
  shimmerBlendMode:
    | "normal"
    | "screen"
    | "overlay"
    | "soft-light"
    | "color-dodge";
  shimmerMaskImage: string | null;
  effectBorderColor: string;
  effectOpacity: number;
  badgeText: string | null;
  badgeBackground: string;
  badgeGlow: string;
  chipBorderColor: string;
  chipTextColor: string;
  chipFontStyle: "normal" | "italic";
  chipFontWeight: number;
}

function normalizeVariant(variant?: string | null): string {
  return variant?.trim().toLowerCase() ?? "";
}

export function getVariantVisuals(
  variant?: string | null
): PullSheetVariantVisuals {
  const normalized = normalizeVariant(variant);
  const isReverseHolo =
    normalized.includes("reverse") &&
    (normalized.includes("holo") || normalized.includes("foil"));
  const isHolo =
    !isReverseHolo &&
    (normalized.includes("holo") || normalized.includes("foil"));
  const isFirstEdition =
    normalized.includes("1st edition") || normalized.includes("first edition");
  const isUnlimited = normalized.includes("unlimited");
  const hasVariant = Boolean(normalized) && normalized !== "normal";

  const labelParts: string[] = [];
  if (isFirstEdition) labelParts.push("1st Ed");
  if (isUnlimited && !isFirstEdition) labelParts.push("Unlimited");
  if (isReverseHolo) {
    labelParts.push("Reverse Holo");
  } else if (isHolo) {
    labelParts.push("Holo");
  }

  let label: string | null = null;
  if (labelParts.length > 0) {
    label = labelParts.join(" ");
  } else if (hasVariant) {
    label = variant ?? null;
  }

  if (isReverseHolo) {
    return {
      hasVariant,
      isHolo: false,
      isReverseHolo: true,
      isFirstEdition,
      label,
      glow:
        "0 0 0 1px rgba(183, 148, 244, 0.55), 0 0 16px rgba(79, 70, 229, 0.28)",
      effectType: "reverse-holo",
      ambientBackground: [
        "radial-gradient(circle at 18% 82%, rgba(255,255,255,0.16), transparent 30%)",
        "linear-gradient(300deg, rgba(255, 99, 132, 0.1), rgba(124, 58, 237, 0.09) 38%, rgba(56, 189, 248, 0.1) 70%, rgba(250, 204, 21, 0.08) 100%)",
      ].join(", "),
      shimmerGradient: [
        "linear-gradient(135deg, transparent 26%, rgba(255,255,255,0.05) 34%, rgba(255,255,255,0.76) 45%, rgba(168, 85, 247, 0.28) 50%, rgba(56, 189, 248, 0.24) 56%, rgba(250, 204, 21, 0.26) 62%, rgba(255,255,255,0.68) 70%, transparent 78%)",
        "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 50%, transparent 100%)",
      ].join(", "),
      shimmerBlendMode: "color-dodge",
      shimmerMaskImage: null,
      effectBorderColor: "transparent",
      effectOpacity: 0.9,
      badgeText: isFirstEdition ? "1st Ed" : null,
      badgeBackground:
        "linear-gradient(135deg, rgba(67, 56, 202, 0.96), rgba(124, 58, 237, 0.92))",
      badgeGlow: "0 0 12px rgba(129, 140, 248, 0.35)",
      chipBorderColor: "#c4b5fd",
      chipTextColor: "#ede9fe",
      chipFontStyle: "italic",
      chipFontWeight: isFirstEdition ? 700 : 500,
    };
  }

  if (isHolo) {
    return {
      hasVariant,
      isHolo: true,
      isReverseHolo: false,
      isFirstEdition,
      label,
      glow:
        "0 0 0 1px rgba(250, 204, 21, 0.45), 0 0 16px rgba(234, 179, 8, 0.24)",
      effectType: "holo",
      ambientBackground: [
        "radial-gradient(circle at 82% 18%, rgba(255,255,255,0.18), transparent 30%)",
        "linear-gradient(120deg, rgba(255, 99, 132, 0.08), rgba(250, 204, 21, 0.08) 48%, rgba(34, 211, 238, 0.08) 100%)",
      ].join(", "),
      shimmerGradient: [
        "linear-gradient(135deg, transparent 26%, rgba(255,255,255,0.05) 34%, rgba(255,255,255,0.75) 45%, rgba(255, 99, 132, 0.28) 50%, rgba(250, 204, 21, 0.24) 56%, rgba(34, 211, 238, 0.28) 62%, rgba(255,255,255,0.68) 70%, transparent 78%)",
        "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 50%, transparent 100%)",
      ].join(", "),
      shimmerBlendMode: "color-dodge",
      shimmerMaskImage: null,
      effectBorderColor: "rgba(250, 204, 21, 0.28)",
      effectOpacity: 0.85,
      badgeText: isFirstEdition ? "1st Ed" : null,
      badgeBackground:
        "linear-gradient(135deg, rgba(180, 83, 9, 0.96), rgba(245, 158, 11, 0.92))",
      badgeGlow: "0 0 12px rgba(245, 158, 11, 0.35)",
      chipBorderColor: "#fcd34d",
      chipTextColor: "#fef08a",
      chipFontStyle: "normal",
      chipFontWeight: isFirstEdition ? 700 : 500,
    };
  }

  return {
    hasVariant,
    isHolo: false,
    isReverseHolo: false,
    isFirstEdition,
    label,
    glow: "none",
    effectType: "none",
    ambientBackground:
      isFirstEdition
        ? "radial-gradient(circle at 14% 12%, rgba(251, 191, 36, 0.22), transparent 24%)"
        : "none",
    shimmerGradient: "none",
    shimmerBlendMode: "normal",
    shimmerMaskImage: null,
    effectBorderColor: "transparent",
    effectOpacity: 0,
    badgeText: isFirstEdition ? "1st Ed" : null,
    badgeBackground:
      "linear-gradient(135deg, rgba(120, 53, 15, 0.96), rgba(180, 83, 9, 0.92))",
    badgeGlow: "0 0 12px rgba(217, 119, 6, 0.25)",
    chipBorderColor: "rgba(255,255,255,0.45)",
    chipTextColor: "rgba(255,255,255,0.92)",
    chipFontStyle: "normal",
    chipFontWeight: isFirstEdition ? 700 : 500,
  };
}

export function getVariantLabel(variant: string): string {
  return getVariantVisuals(variant).label ?? variant;
}

export function getVariantGlow(variant: string): string {
  return getVariantVisuals(variant).glow;
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
