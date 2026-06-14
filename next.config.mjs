/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mastra pulls in optional server-only deps (telemetry, native loaders) that
  // it loads lazily. Mark the core as external for server bundles so Next's
  // bundler doesn't try to trace/inline those optional paths.
  serverExternalPackages: ["@mastra/core"],
};

export default nextConfig;
