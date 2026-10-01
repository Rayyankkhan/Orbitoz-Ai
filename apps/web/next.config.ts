import type { NextConfig } from 'next';

/**
 * `transpilePackages` matters in a monorepo: Next does not compile workspace
 * packages by default, so shared-types' TypeScript would be handed to the
 * browser unbuilt.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@orbitoz/shared-types'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
