import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker runtime stage.
  output: "standalone",
  // Same-origin API: the browser always calls /api/*; Next proxies to the
  // NestJS API (dev: localhost, Docker: internal network). In production the
  // reverse proxy handles /api before Next ever sees it — this rewrite is the
  // dev/direct-access fallback, so behavior is identical everywhere.
  async rewrites() {
    const api = process.env.API_URL ?? "http://localhost:3001";
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
};

export default nextConfig;
