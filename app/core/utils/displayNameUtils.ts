/**
 * Utility functions for creating consistent display names across the application
 */

/**
 * Creates a display name with card number, rarity, and language
 * This matches the format used in the InventoryEntryTable component
 */
export const createDisplayName = (
  productName: string,
  cardNumber?: string | null,
  rarityName?: string,
  variant?: string,
  language?: string
): string => {
  const parts = [productName];

  if (cardNumber && !productName.includes(cardNumber)) {
    parts.push(cardNumber);
  }

  if (rarityName) {
    parts.push(rarityName);
  }

  if (language && language !== "English") {
    parts.push(language);
  }

  return parts.join(" - ");
};
