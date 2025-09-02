import { describe, it, expect, beforeEach } from "vitest";
import { PurePricingService } from "../services/purePricingService";
import type { SkuPricingData, PurePricingConfig } from "../types/pricingData";

describe("PurePricingService", () => {
  let pricingService: PurePricingService;

  beforeEach(() => {
    pricingService = new PurePricingService();
  });

  describe("calculateSingleSkuPrice", () => {
    it("should calculate price with sufficient sales data", () => {
      const mockSkuData: SkuPricingData = {
        sku: {
          id: 12345,
          productId: 100,
          productLineId: 1,
          condition: "Near Mint",
          language: "English",
          variant: "Normal",
          quantity: 1,
        },
        sales: [
          {
            purchasePrice: 10.0,
            quantity: 1,
            orderDate: "2024-01-01T00:00:00Z",
            condition: "Near Mint",
          },
          {
            purchasePrice: 12.0,
            quantity: 1,
            orderDate: "2024-01-02T00:00:00Z",
            condition: "Near Mint",
          },
          {
            purchasePrice: 11.0,
            quantity: 2,
            orderDate: "2024-01-03T00:00:00Z",
            condition: "Near Mint",
          },
        ] as any[],
        categoryFilter: {
          categoryId: 1,
          languages: [{ id: 1, name: "English" }],
          variants: [{ id: 1, name: "Normal" }],
        },
        pricePoint: {
          skuId: 12345,
          marketPrice: 15.0,
          lowestPrice: 8.0,
          highestPrice: 20.0,
          priceCount: 10,
          calculatedAt: "2024-01-01T00:00:00Z",
        },
      };

      const config: PurePricingConfig = {
        percentile: 80,
        enableSupplyAnalysis: false,
      };

      const result = pricingService["calculateSingleSkuPrice"](
        mockSkuData,
        config
      );

      expect(result.sku).toBe(12345);
      expect(result.suggestedPrice).toBeGreaterThan(0);
      expect(result.price).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
      expect(result.percentiles).toHaveLength(10); // 9 standard + 1 custom
    });

    it("should return error with insufficient sales data", () => {
      const mockSkuData: SkuPricingData = {
        sku: {
          id: 12345,
          productId: 100,
          productLineId: 1,
          condition: "Near Mint",
          language: "English",
          variant: "Normal",
        },
        sales: [
          {
            purchasePrice: 10.0,
            quantity: 1,
            orderDate: "2024-01-01T00:00:00Z",
            condition: "Near Mint",
          },
        ] as any[], // Only one sale
        categoryFilter: {
          categoryId: 1,
          languages: [{ id: 1, name: "English" }],
          variants: [{ id: 1, name: "Normal" }],
        },
      };

      const config: PurePricingConfig = {
        percentile: 80,
        enableSupplyAnalysis: false,
      };

      const result = pricingService["calculateSingleSkuPrice"](
        mockSkuData,
        config
      );

      expect(result.sku).toBe(12345);
      expect(result.errors).toContain("Insufficient sales data for pricing");
      expect(result.suggestedPrice).toBeUndefined();
    });

    it("should apply price bounds correctly", () => {
      const mockSkuData: SkuPricingData = {
        sku: {
          id: 12345,
          productId: 100,
          productLineId: 1,
          condition: "Near Mint",
          language: "English",
          variant: "Normal",
        },
        sales: [
          {
            purchasePrice: 1.0, // Very low price
            quantity: 1,
            orderDate: "2024-01-01T00:00:00Z",
            condition: "Near Mint",
          },
          {
            purchasePrice: 1.5,
            quantity: 1,
            orderDate: "2024-01-02T00:00:00Z",
            condition: "Near Mint",
          },
        ] as any[],
        categoryFilter: {
          categoryId: 1,
          languages: [{ id: 1, name: "English" }],
          variants: [{ id: 1, name: "Normal" }],
        },
        pricePoint: {
          skuId: 12345,
          marketPrice: 15.0, // Much higher market price
          lowestPrice: 8.0,
          highestPrice: 20.0,
          priceCount: 10,
          calculatedAt: "2024-01-01T00:00:00Z",
        },
      };

      const config: PurePricingConfig = {
        percentile: 80,
        enableSupplyAnalysis: false,
      };

      const result = pricingService["calculateSingleSkuPrice"](
        mockSkuData,
        config
      );

      expect(result.price).toBeGreaterThan(result.suggestedPrice!);
      expect(result.warnings).toContain(
        "Suggested price below minimum. Using minimum price."
      );
    });

    it("should handle cross-condition analysis with Zipf model", () => {
      const mockSkuData: SkuPricingData = {
        sku: {
          id: 12345,
          productId: 100,
          productLineId: 1,
          condition: "Near Mint",
          language: "English",
          variant: "Normal",
        },
        sales: [
          // Mix of conditions
          {
            purchasePrice: 10.0,
            quantity: 1,
            orderDate: "2024-01-01T00:00:00Z",
            condition: "Near Mint",
          },
          {
            purchasePrice: 8.0,
            quantity: 1,
            orderDate: "2024-01-02T00:00:00Z",
            condition: "Lightly Played",
          },
          {
            purchasePrice: 6.0,
            quantity: 1,
            orderDate: "2024-01-03T00:00:00Z",
            condition: "Moderately Played",
          },
        ] as any[],
        categoryFilter: {
          categoryId: 1,
          languages: [{ id: 1, name: "English" }],
          variants: [{ id: 1, name: "Normal" }],
        },
      };

      const config: PurePricingConfig = {
        percentile: 80,
        enableSupplyAnalysis: false,
      };

      const result = pricingService["calculateSingleSkuPrice"](
        mockSkuData,
        config
      );

      expect(result.usedCrossConditionAnalysis).toBe(true);
      expect(result.conditionMultipliers).toBeInstanceOf(Map);
      expect(result.conditionMultipliers!.size).toBeGreaterThan(0);
    });
  });

  describe("calculateBatchPrices", () => {
    it("should process multiple SKUs and provide aggregate statistics", () => {
      const batchData = {
        skusData: [
          {
            sku: {
              id: 1,
              productId: 100,
              productLineId: 1,
              condition: "Near Mint",
              language: "English",
              variant: "Normal",
              quantity: 2,
            },
            sales: [
              {
                purchasePrice: 10.0,
                quantity: 1,
                orderDate: "2024-01-01T00:00:00Z",
                condition: "Near Mint",
              },
              {
                purchasePrice: 12.0,
                quantity: 1,
                orderDate: "2024-01-02T00:00:00Z",
                condition: "Near Mint",
              },
            ] as any[],
            categoryFilter: { categoryId: 1, languages: [], variants: [] },
          },
          {
            sku: {
              id: 2,
              productId: 200,
              productLineId: 2,
              condition: "Near Mint",
              language: "English",
              variant: "Normal",
              quantity: 1,
            },
            sales: [
              {
                purchasePrice: 5.0,
                quantity: 1,
                orderDate: "2024-01-01T00:00:00Z",
                condition: "Near Mint",
              },
              {
                purchasePrice: 7.0,
                quantity: 1,
                orderDate: "2024-01-02T00:00:00Z",
                condition: "Near Mint",
              },
            ] as any[],
            categoryFilter: { categoryId: 2, languages: [], variants: [] },
          },
        ] as SkuPricingData[],
        config: {
          percentile: 80,
          enableSupplyAnalysis: false,
        } as PurePricingConfig,
      };

      const result = pricingService.calculateBatchPrices(batchData);

      expect(result.results).toHaveLength(2);
      expect(result.stats.processed).toBe(2);
      expect(result.stats.errors).toBe(0);
      expect(result.aggregatedPercentiles.marketPrice).toBeDefined();
      expect(Object.keys(result.aggregatedPercentiles.marketPrice)).toContain(
        "80th"
      );
    });

    it("should handle mixed success and failure cases", () => {
      const batchData = {
        skusData: [
          {
            sku: {
              id: 1,
              productId: 100,
              productLineId: 1,
              condition: "Near Mint",
              language: "English",
              variant: "Normal",
            },
            sales: [
              {
                purchasePrice: 10.0,
                quantity: 1,
                orderDate: "2024-01-01T00:00:00Z",
                condition: "Near Mint",
              },
              {
                purchasePrice: 12.0,
                quantity: 1,
                orderDate: "2024-01-02T00:00:00Z",
                condition: "Near Mint",
              },
            ] as any[],
            categoryFilter: { categoryId: 1, languages: [], variants: [] },
          },
          {
            sku: {
              id: 2,
              productId: 200,
              productLineId: 2,
              condition: "Near Mint",
              language: "English",
              variant: "Normal",
            },
            sales: [], // No sales data - should fail
            categoryFilter: { categoryId: 2, languages: [], variants: [] },
          },
        ] as SkuPricingData[],
        config: {
          percentile: 80,
          enableSupplyAnalysis: false,
        } as PurePricingConfig,
      };

      const result = pricingService.calculateBatchPrices(batchData);

      expect(result.results).toHaveLength(2);
      expect(result.stats.processed).toBe(1);
      expect(result.stats.errors).toBe(1);
      expect(result.results[0].errors).toHaveLength(0);
      expect(result.results[1].errors).toContain(
        "Insufficient sales data for pricing"
      );
    });
  });
});
