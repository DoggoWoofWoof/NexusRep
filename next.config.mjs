/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Typed Link hrefs so navigation between lifecycle routes is checked at build.
  typedRoutes: true,
  // Keep the local embedding model (Transformers.js + onnxruntime) out of the
  // bundle — it's loaded server-side at runtime via dynamic import.
  // pdf-parse wraps pdf.js, which loads a worker file at runtime; bundling it into the server
  // chunks breaks that resolution ("Cannot find module …/pdf.worker.mjs"). Externalize so it's
  // required from node_modules where the worker resolves. (Same reason as the two above.)
  serverExternalPackages: ["@xenova/transformers", "@electric-sql/pglite", "pdf-parse"],
  // In DEV, tell the browser never to cache — after a dev-server restart a stale tab
  // otherwise serves cached HTML/chunks (the "needs a hard refresh" problem). With this,
  // a normal reload always fetches fresh. Production keeps Next's default caching.
  async headers() {
    if (process.env.NODE_ENV === "production") return [];
    return [{ source: "/:path*", headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }] }];
  },
};

export default nextConfig;
