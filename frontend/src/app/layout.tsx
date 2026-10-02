import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/Toast';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '知识库管理平台',
    template: '%s · 知识库管理平台',
  },
  description:
    '知识多源维护 · 四维细粒度权限鉴权 · AI 鉴权检索问答 · 运营数据看板 · 知识自动沉淀',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#4f46e5',
};

/**
 * 根布局：挂载登录态 Provider 与全局 Toast。
 * 控制台外壳（侧栏 / 顶栏）在 src/app/(console)/layout.tsx 中实现。
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-slate-50 font-sans text-slate-800 antialiased">
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
