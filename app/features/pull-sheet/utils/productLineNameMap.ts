const PULL_SHEET_PRODUCT_LINE_NAME_ALIASES: Record<string, string> = {
  magic: "Magic: The Gathering",
};

export function mapPullSheetProductLineName(productLineName: string): string {
  const normalizedName = productLineName.trim();
  if (!normalizedName) {
    return normalizedName;
  }

  return (
    PULL_SHEET_PRODUCT_LINE_NAME_ALIASES[normalizedName.toLowerCase()] ??
    normalizedName
  );
}
