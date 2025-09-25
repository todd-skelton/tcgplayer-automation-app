/**
 * Utility functions for matching against number fields with slash-separated values
 */

/**
 * Matches a query against a number field following these rules:
 * 1. If query has no slash: match exact against content before the first slash (or entire field if no slash)
 * 2. If query has slash: match exact against entire field
 *
 * Examples:
 * - Query "137" matches "137/120" but not "001/137"
 * - Query "001/132" matches "001/132" only
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

  // If query contains a slash, match against the entire field exactly
  if (cleanQuery.includes("/")) {
    return cleanQuery === cleanField;
  }

  // If query has no slash, match against the part before the first slash in the field
  // (or the entire field if it has no slash)
  const fieldBeforeSlash = cleanField.split("/")[0];
  return cleanQuery === fieldBeforeSlash;
}
