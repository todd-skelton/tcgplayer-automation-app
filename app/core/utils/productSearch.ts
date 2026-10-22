import { matchesNumberField } from "./numberFieldMatching";

/** What a product search looks at: the card number and the name shown for it. */
export interface SearchableProduct {
  cardNumber?: string | null;
  displayName: string;
}

/**
 * Narrows products to a search the same way in every feature: a query that
 * matches card numbers finds those cards, and any other query finds products
 * whose display name contains it.
 */
export function searchProducts<T extends SearchableProduct>(
  products: readonly T[],
  query: string,
): T[] {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return [...products];
  }

  const cardNumberMatches = products.filter((product) =>
    matchesNumberField(trimmedQuery, product.cardNumber),
  );

  if (cardNumberMatches.length > 0) {
    return cardNumberMatches;
  }

  const lowerCaseQuery = trimmedQuery.toLocaleLowerCase();

  return products.filter((product) =>
    product.displayName.toLocaleLowerCase().includes(lowerCaseQuery),
  );
}
