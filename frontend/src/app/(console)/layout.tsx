'use client';

/**
 * 控制台外壳：左侧可折叠菜单 + 顶栏（当前用户 / 部门 / 角色 / 退出登录）。
 *
 * 菜单级鉴权：菜单项按当前用户 permissions 过滤，无权限的菜单不渲染；
 * 路由级鉴权由 <RequireAuth> 兜底，未登录直接跳转 /login。
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { Icon } from '@/components/Icons';
import { Button, cn } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import { RequireAuth, useAuth } from '@/lib/auth';
import { MENU_ITEMS, visibleMenus, type MenuItem } from '@/lib/permissions';

const SIDEBAR_KEY = 'kb_sidebar_collapsed';

function ConsoleShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const toast = useToast();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // 记住折叠状态
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const menus = visibleMenus(user);
  const current: MenuItem | undefined = menus.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      toast.error('退出登录失败，请重试');
      setLoggingOut(false);
    }
  };

  const displayName = user?.display_name || user?.username || '';
  const initial = displayName.trim().slice(0, 1) || '用';
  const roles = user?.roles ?? [];

  return (
    <div className="console-shell flex min-h-screen bg-slate-50">
      {/* ---------------- 侧栏 ---------------- */}
      <aside
        className={cn(
          'sticky top-0 flex h-screen shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-200',
          collapsed ? 'w-[72px]' : 'w-[240px]',
        )}
      >
        {/* 品牌 */}
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Icon name="knowledge" className="h-4 w-4" />
          </span>
          {!collapsed ? (
            <span className="truncate text-sm font-semibold text-slate-800">知识库管理平台</span>
          ) : null}
        </div>

        {/* 菜单（已按权限过滤） */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
          {menus.length === 0 ? (
            <p className={cn('px-2 text-[11px] leading-relaxed text-slate-400', collapsed && 'text-center')}>
              {collapsed ? '无权限' : '当前账号未被分配任何菜单权限，请联系系统管理员。'}
            </p>
          ) : null}

          {menus.map((item) => {
            const active = current?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-800',
                )}
              >
                <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                {!collapsed ? <span className="truncate">{item.label}</span> : null}
              </Link>
            );
          })}
        </nav>

        {/* 折叠开关 */}
        <div className="border-t border-slate-100 p-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? '展开菜单' : '收起菜单'}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700',
              collapsed && 'justify-center px-0',
            )}
          >
            <Icon name="menu" className="h-4 w-4 shrink-0" />
            {!collapsed ? <span>收起菜单</span> : null}
          </button>
        </div>
      </aside>

      {/* ---------------- 主区域 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-5 backdrop-blur">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-slate-800">
              {current?.label ?? '控制台'}
            </h1>
            <p className="truncate text-[11px] text-slate-400">
              {current?.description ?? '知识库管理平台'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {/* 当前用户 */}
            <div className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
                {initial}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-slate-700">{displayName}</p>
                <p className="truncate text-[11px] text-slate-400">
                  {user?.department?.name ?? '未分配部门'}
                  {user?.is_superuser ? ' · 超级管理员' : ''}
                </p>
              </div>
            </div>

            {/* 角色 */}
            <div className="flex max-w-[260px] flex-wrap items-center justify-end gap-1">
              {roles.slice(0, 3).map((role) => (
                <span
                  key={role.id}
                  title={role.code}
                  className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600"
                >
                  {role.name}
                </span>
              ))}
              {roles.length > 3 ? (
                <span
                  title={roles
                    .slice(3)
                    .map((role) => role.name)
                    .join('、')}
                  className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500"
                >
                  +{roles.length - 3}
                </span>
              ) : null}
              {roles.length === 0 ? (
                <span className="text-[11px] text-slate-400">无角色</span>
              ) : null}
            </div>

            <Button
              size="sm"
              variant="outline"
              icon="logout"
              loading={loggingOut}
              onClick={handleLogout}
            >
              退出登录
            </Button>
          </div>
        </header>

        {/* 页面内容 */}
        <main className="min-w-0 flex-1 p-5">{children}</main>

        <footer className="px-5 pb-4 text-[11px] text-slate-400">
          知识库管理平台 · 权限码 {user?.permissions.length ?? 0} 项
          {menus.length < MENU_ITEMS.length
            ? ` · 已按权限隐藏 ${MENU_ITEMS.length - menus.length} 个菜单`
            : ''}
        </footer>
      </div>
    </div>
  );
}

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <ConsoleShell>{children}</ConsoleShell>
    </RequireAuth>
  );
}
