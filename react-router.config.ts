import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // React Router rejects form submissions when the browser `Origin` differs from
  // the origin the server reconstructs from the request. Tailscale Serve
  // terminates HTTPS at https://<machine>.<tailnet>.ts.net and proxies to
  // http://localhost:3001, so every save from a tailnet URL would otherwise fail
  // with "Bad Request" before the route action runs.
  allowedActionOrigins: ["**.ts.net"],
} satisfies Config;
