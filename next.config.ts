import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the bottom-left dev indicator badge for clean full-screen mobile previews
  devIndicators: false,
  // The sandbox live preview reaches `next dev` through a foreign origin
  // (https://{port}-{sandboxId}.e2b.app). Next blocks the dev client (HMR)
  // cross-origin by default, which leaves the page unhydrated and inert —
  // allowlist the preview host family so the preview stays interactive.
  // Dev-only: ignored by production builds.
  allowedDevOrigins: ["*.e2b.app"],
};

export default nextConfig;
