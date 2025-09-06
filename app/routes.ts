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
    path: "/api/suggested-price",
    file: "features/pricing/routes/api.suggested-price.tsx",
  },
  {
    path: "/api/seller-inventory",
    file: "features/seller-management/routes/api.seller-inventory.tsx",
  },
  {
    path: "/api/price-points",
    file: "features/pricing/routes/api.price-points.tsx",
  },
  {
    path: "/api/validate-skus",
    file: "features/pricing/routes/api.validate-skus.tsx",
  },
  {
    path: "/api/convert-to-pricer-sku",
    file: "features/file-upload/routes/api.convert-to-pricer-sku.tsx",
  },
  {
    path: "/api/inventory/product-lines",
    file: "features/inventory-management/routes/api.inventory-product-lines.tsx",
  },
  {
    path: "/api/inventory/sets",
    file: "features/inventory-management/routes/api.inventory-sets.tsx",
  },
  {
    path: "/api/inventory/skus",
    file: "features/inventory-management/routes/api.inventory-skus.tsx",
  },
  {
    path: "/api/inventory/skus-by-set",
    file: "features/inventory-management/routes/api.inventory-skus-by-set.tsx",
  },
  {
    path: "/api/inventory/current",
    file: "features/inventory-management/routes/api.inventory-current.tsx",
  },
  {
    path: "/api/pending-inventory",
    file: "features/pending-inventory/routes/api.pending-inventory.tsx",
  },
] satisfies RouteConfig;
