import { type RouteConfig, index } from "@react-router/dev/routes";

export default [
  index("routes/dashboard.tsx"),
  {
    path: "/pricer",
    file: "features/pricing/routes/pricer.tsx",
  },
  {
    path: "/seller-pricer",
    file: "features/seller-management/routes/seller-pricer.tsx",
  },
  {
    path: "/inventory-manager",
    file: "features/inventory-management/routes/inventory-manager.tsx",
  },
  {
    path: "/pending-inventory-pricer",
    file: "features/pending-inventory/routes/pending-inventory-pricer.tsx",
  },
  {
    path: "/configuration",
    file: "features/pricing/routes/configuration.tsx",
  },
  {
    path: "/http-configuration",
    file: "routes/http-configuration.tsx",
  },
  {
    path: "/shipping-configuration",
    file: "features/shipping-export/routes/shipping-configuration.tsx",
  },
  {
    path: "/data-management",
    file: "routes/home.tsx",
  },
  {
    path: "/api/suggested-price",
    file: "features/pricing/routes/api.suggested-price.tsx",
  },
  {
    path: "/api/seller-inventory",
    file: "features/seller-management/routes/api.seller-inventory.ts",
  },
  {
    path: "/api/price-points",
    file: "features/pricing/routes/api.price-points.ts",
  },
  {
    path: "/api/validate-skus",
    file: "features/pricing/routes/api.validate-skus.ts",
  },
  {
    path: "/api/pricing-config",
    file: "features/pricing/routes/api.pricing-config.ts",
  },
  {
    path: "/api/convert-to-pricer-sku",
    file: "features/file-upload/routes/api.convert-to-pricer-sku.ts",
  },
  {
    path: "/api/inventory/product-lines",
    file: "features/inventory-management/routes/api.inventory-product-lines.ts",
  },
  {
    path: "/api/inventory/sets",
    file: "features/inventory-management/routes/api.inventory-sets.ts",
  },
  {
    path: "/api/inventory/skus",
    file: "features/inventory-management/routes/api.inventory-skus.ts",
  },
  {
    path: "/api/inventory/skus-by-set",
    file: "features/inventory-management/routes/api.inventory-skus-by-set.ts",
  },
  {
    path: "/api/inventory/skus-by-card-number",
    file: "features/inventory-management/routes/api.inventory-skus-by-card-number.ts",
  },
  {
    path: "/api/inventory-batches",
    file: "features/pending-inventory/routes/api.inventory-batches.ts",
  },
  {
    path: "/api/inventory-batches/import-seller",
    file: "features/pending-inventory/routes/api.inventory-batches-import-seller.ts",
  },
  {
    path: "/api/inventory-batches/import-csv",
    file: "features/pending-inventory/routes/api.inventory-batches-import-csv.ts",
  },
  {
    path: "/api/inventory-batches/:batchNumber",
    file: "features/pending-inventory/routes/api.inventory-batch.ts",
  },
  {
    path: "/api/inventory-batches/:batchNumber/items",
    file: "features/pending-inventory/routes/api.inventory-batch-items.ts",
  },
  {
    path: "/api/inventory-batches/:batchNumber/results",
    file: "features/pending-inventory/routes/api.inventory-batch-results.ts",
  },
  {
    path: "/api/inventory-batches/:batchNumber/pricing-jobs",
    file: "features/pending-inventory/routes/api.inventory-batch-pricing-jobs.ts",
  },
  {
    path: "/api/inventory-batches/:batchNumber/pricing-stream",
    file: "features/pending-inventory/routes/api.inventory-batch-pricing-stream.ts",
  },
  {
    path: "/api/pending-inventory",
    file: "features/pending-inventory/routes/api.pending-inventory.ts",
  },
  {
    path: "/pull-sheet",
    file: "features/pull-sheet/routes/pull-sheet.tsx",
  },
  {
    path: "/shipping-export",
    file: "features/shipping-export/routes/shipping-export.tsx",
  },
  {
    path: "/api/shipping-export/postages",
    file: "features/shipping-export/routes/api.shipping-export-postages.ts",
  },
  {
    path: "/api/shipping-export/batch-labels",
    file: "features/shipping-export/routes/api.shipping-export-batch-labels.ts",
  },
  {
    path: "/api/shipping-export/postage-lookups",
    file: "features/shipping-export/routes/api.shipping-export-postage-lookups.ts",
  },
  {
    path: "/api/pull-sheet-lookup",
    file: "features/pull-sheet/routes/api.pull-sheet-lookup.ts",
  },
] satisfies RouteConfig;

