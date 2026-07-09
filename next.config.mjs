/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Typed Link hrefs so navigation between lifecycle routes is checked at build.
  typedRoutes: true,
  // Keep the local embedding model (Transformers.js + onnxruntime) out of the
  // bundle — it's loaded server-side at runtime via dynamic import.
  serverExternalPackages: ["@xenova/transformers", "@electric-sql/pglite"],
  // In DEV, tell the browser never to cache — after a dev-server restart a stale tab
  // otherwise serves cached HTML/chunks (the "needs a hard refresh" problem). With this,
  // a normal reload always fetches fresh. Production keeps Next's default caching.
  async headers() {
    if (process.env.NODE_ENV === "production") return [];
    return [{ source: "/:path*", headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }] }];
  },
};

export default nextConfig;
