'use client';

/**
 * 根路径入口：按登录态分流。
 * - 已登录 → /dashboard
 * - 未登录 → /login
 *
 * 登录态存在 localStorage，无法在服务端判定，因此这里做客户端重定向。
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { FullPageLoading, useAuth } from '@/lib/auth';

export default function RootEntryPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/dashboard' : '/login');
  }, [loading, user, router]);

  return (
    <FullPageLoading text={loading ? '正在校验登录态…' : '正在跳转…'} />
  );
}
