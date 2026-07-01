// @ts-check

/**
 * Next.js 15 configuration for the DevCortex fixture app.
 *
 * Kept intentionally small and realistic — this project is committed test data
 * that DevCortex scans and gates against; it is never installed or built.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: true,
  },
  env: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  },
};

export default nextConfig;
