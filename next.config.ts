import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /judge reads the committed bench outputs at request time (lib/judge.ts); ship them with that function
  outputFileTracingIncludes: { "/judge": ["./bench/*.json"] },
  // the story page and the pitch deck are static files in public/ (their numbers are written by scripts/site.py from
  // bench/*.json and docs/rigor.json); these give them clean URLs next to the app
  async rewrites() {
    return [
      { source: "/about", destination: "/about.html" },
      { source: "/pitch", destination: "/pitch.html" },
    ];
  },
};

export default nextConfig;
