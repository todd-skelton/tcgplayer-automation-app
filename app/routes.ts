import { type RouteConfig, index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
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
    path: "/api/pending-inventory",
    file: "features/pending-inventory/routes/api.pending-inventory.ts",
  },
] satisfies RouteConfig;
