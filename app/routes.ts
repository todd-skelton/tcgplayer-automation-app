import { type RouteConfig, index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  {
    path: "/pricer",
    file: "routes/pricer.tsx",
  },
  {
    path: "/api/suggested-price",
    file: "routes/api.suggested-price.tsx",
  },
] satisfies RouteConfig;
