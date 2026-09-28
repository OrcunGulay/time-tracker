/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // API adresi tarayici tarafinda kullanilir; sunucu tarafi proxy gerekmez.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
