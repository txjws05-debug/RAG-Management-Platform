import type { NextConfig } from 'next';

/**
 * Next.js 配置。
 *
 * - output: 'standalone'  —— 生产镜像只复制 .next/standalone + .next/static，
 *   由 `node server.js` 启动，配合 infra/nginx 反向代理到 web:3000。
 * - 浏览器可见的 API 前缀由 NEXT_PUBLIC_API_BASE 注入（构建期），默认走 Nginx 同源 /api，
 *   避免跨端口 Cookie / CORS 问题；鉴权仍使用 localStorage + Authorization 头。
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: {
    // 类型错误必须让构建失败：npx tsc --noEmit 与构建保持一致
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
