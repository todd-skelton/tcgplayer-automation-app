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
] satisfies RouteConfig;
