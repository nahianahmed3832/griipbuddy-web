/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  experimental: { cpus: 1 },
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'd11ml80zmgyrxk.cloudfront.net', pathname: '/uploads/*', search: '' }],
  },
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};

export default nextConfig;
