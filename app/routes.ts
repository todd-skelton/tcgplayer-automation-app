import { type RouteConfig, index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  {
    path: "/pricer",
    file: "routes/pricer.tsx",
  },
  {
    path: "/seller-pricer",
    file: "routes/seller-pricer.tsx",
  },
  {
    path: "/inventory-manager",
    file: "routes/inventory-manager.tsx",
  },
  {
    path: "/pending-inventory-pricer",
    file: "routes/pending-inventory-pricer.tsx",
  },
  {
    path: "/api/suggested-price",
    file: "routes/api.suggested-price.tsx",
  },
  {
    path: "/api/seller-inventory",
    file: "routes/api.seller-inventory.tsx",
  },
  {
    path: "/api/price-points",
    file: "routes/api.price-points.tsx",
  },
  {
    path: "/api/validate-skus",
    file: "routes/api.validate-skus.tsx",
  },
  {
    path: "/api/inventory/product-lines",
    file: "routes/api.inventory-product-lines.tsx",
  },
  {
    path: "/api/inventory/sets",
    file: "routes/api.inventory-sets.tsx",
  },
  {
    path: "/api/inventory-skus",
    file: "routes/api.inventory-skus.tsx",
  },
  {
    path: "/api/inventory/skus-by-set",
    file: "routes/api.inventory-skus-by-set.tsx",
  },
  {
    path: "/api/inventory/current",
    file: "routes/api.inventory-current.tsx",
  },
  {
    path: "/api/pending-inventory",
    file: "routes/api.pending-inventory.tsx",
  },
] satisfies RouteConfig;
