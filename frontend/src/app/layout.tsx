import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { AuthProvider } from '@/lib/auth';
import { ThemeProvider, ThemeScript } from '@/lib/theme';
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
  // 允许用户缩放：禁用缩放会伤害可访问性，且在 iOS 上会破坏输入框聚焦体验
  maximumScale: 5,
  // 顶栏是 sticky 的，主题色需同时适配亮暗两套
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111827' },
  ],
};

/**
 * 根布局：挂载主题 Provider、登录态 Provider 与全局 Toast。
 * 控制台外壳（侧栏 / 顶栏）在 src/app/(console)/layout.tsx 中实现。
 *
 * `suppressHydrationWarning`：ThemeScript 会在 HTML 解析阶段就设置 data-theme，
 * 等 React 水合时该属性已被修正，服务端渲染出的值不应获胜。
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-subtle font-sans text-strong antialiased">
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>{children}</ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
