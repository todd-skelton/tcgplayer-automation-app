import type { SuggestedPriceResult } from "../types/pricing";

export const getSuggestedPrice = async (
  tcgplayerId: string,
  percentile: number
): Promise<SuggestedPriceResult> => {
  try {
    const response = await fetch("/api/suggested-price", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tcgplayerId, percentile }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error: any) {
    console.error("Error getting suggested price:", error);
    return {
      error: error?.message || "Failed to get suggested price",
      suggestedPrice: null,
    };
  }
};
