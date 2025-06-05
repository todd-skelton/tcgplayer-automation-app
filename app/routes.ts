import { type RouteConfig, index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  {
    path: "/pricer",
    file: "routes/pricer.tsx",
  },
] satisfies RouteConfig;
