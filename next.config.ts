import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /judge reads the committed bench outputs at request time (lib/judge.ts); ship them with that function
  outputFileTracingIncludes: { "/judge": ["./bench/*.json"] },
};

export default nextConfig;
