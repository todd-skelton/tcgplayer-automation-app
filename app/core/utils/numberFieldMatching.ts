/**
 * Utility functions for matching against number fields with slash-separated values
 */

/**
 * Normalizes a number string by removing leading zeros
 * Examples: "003" -> "3", "0001" -> "1", "10" -> "10"
 */
function normalizeNumber(numberStr: string): string {
  // Handle empty strings
  if (!numberStr) {
    return numberStr;
  }

  // Convert to number and back to string to remove leading zeros
  // This handles cases like "003" -> 3 -> "3"
  const num = parseInt(numberStr, 10);

  // If parsing fails (NaN), return original string
  if (isNaN(num)) {
    return numberStr;
  }

  return num.toString();
}

/**
 * Matches a query against a number field following these rules:
 * 1. If query has no slash: match against content before the first slash (or entire field if no slash)
 *    - Numbers are normalized to ignore leading zeros (e.g., "3" matches "003", "03", etc.)
 * 2. If query has slash: match against entire field with normalized numbers
 *    - Both parts are normalized independently (e.g., "3/120" matches "003/120")
 *
 * Examples:
 * - Query "3" matches "003/120", "03/120", "3/120"
 * - Query "003" matches "3/120", "03/120", "003/120"
 * - Query "3/120" matches "003/120", "03/120"
 * - Query "137" matches "137" (field with no slash)
 */
export function matchesNumberField(
  query: string,
  fieldValue: string | null | undefined
): boolean {
  // Handle null/undefined field values
  if (!fieldValue) {
    return false;
  }

  // Remove whitespace from both query and field
  const cleanQuery = query.trim();
  const cleanField = fieldValue.trim();

  // If query is empty, no match
  if (!cleanQuery) {
    return false;
  }

  // If query contains a slash, match against the entire field with normalized numbers
  if (cleanQuery.includes("/")) {
    const queryParts = cleanQuery.split("/");
    const fieldParts = cleanField.split("/");

    // Both must have the same number of parts
    if (queryParts.length !== fieldParts.length) {
      return false;
    }

    // Compare each part with normalization
    for (let i = 0; i < queryParts.length; i++) {
      const normalizedQueryPart = normalizeNumber(queryParts[i]);
      const normalizedFieldPart = normalizeNumber(fieldParts[i]);

      if (normalizedQueryPart !== normalizedFieldPart) {
        return false;
      }
    }

    return true;
  }

  // If query has no slash, match against the part before the first slash in the field
  // (or the entire field if it has no slash) with number normalization
  const fieldBeforeSlash = cleanField.split("/")[0];
  const normalizedQuery = normalizeNumber(cleanQuery);
  const normalizedField = normalizeNumber(fieldBeforeSlash);

  return normalizedQuery === normalizedField;
}
