'use client';

/**
 * 控制台外壳：响应式布局。
 *
 * - `lg` 及以上：左侧固定侧栏（可折叠为窄条）+ 顶栏；
 * - `lg` 以下（手机 / 平板）：侧栏变为抽屉，由顶栏汉堡按钮唤出，带遮罩，
 *   路由变化时自动关闭，抽屉本身可滚动且避开安全区域。
 *
 * 注意：这里曾经依赖 globals.css 中的 `.console-shell { min-width: 1280px }`，
 * 那让窄屏只能横向滚动。现已完全移除，改为真正的响应式。
 *
 * 菜单级鉴权：菜单项按当前用户 permissions 过滤，无权限的菜单不渲染；
 * 路由级鉴权由 <RequireAuth> 兜底，未登录直接跳转 /login。
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon } from '@/components/Icons';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button, cn } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import { RequireAuth, useAuth } from '@/lib/auth';
import { useHydrated } from '@/lib/useHydrated';
import { MENU_ITEMS, visibleMenus, type MenuItem } from '@/lib/permissions';

const SIDEBAR_KEY = 'kb_sidebar_collapsed';

/** 侧栏内容（桌面固定侧栏与移动抽屉共用同一份实现）。 */
function SidebarContent({
  collapsed,
  onNavigate,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}) {
  const { user } = useAuth();
  const pathname = usePathname();
  const menus = visibleMenus(user);

  return (
    <>
      {/* 品牌 */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2 border-b border-line px-4',
          collapsed && 'justify-center px-2',
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white">
          <Icon name="knowledge" className="h-4 w-4" />
        </span>
        {!collapsed ? (
          <span className="truncate text-sm font-semibold text-strong">知识库管理平台</span>
        ) : null}
      </div>

      {/* 菜单（已按权限过滤） */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {menus.length === 0 ? (
          <p
            className={cn(
              'px-2 text-[11px] leading-relaxed text-faint',
              collapsed && 'text-center',
            )}
          >
            {collapsed ? '无权限' : '当前账号未被分配任何菜单权限，请联系系统管理员。'}
          </p>
        ) : null}

        {menus.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                'min-h-11 sm:min-h-0',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-brand-soft text-brand-ink'
                  : 'text-body hover:bg-muted-surface hover:text-strong',
              )}
            >
              <Icon name={item.icon} className="h-4 w-4 shrink-0" />
              {!collapsed ? <span className="truncate">{item.label}</span> : null}
            </Link>
          );
        })}
      </nav>

      {/* 折叠开关（仅桌面；移动抽屉里不需要） */}
      {onToggleCollapse ? (
        <div className="hidden border-t border-line p-2 lg:block">
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? '展开菜单' : '收起菜单'}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-muted',
              'transition-colors hover:bg-muted-surface hover:text-body',
              collapsed && 'justify-center px-0',
            )}
          >
            <Icon name="menu" className="h-4 w-4 shrink-0" />
            {!collapsed ? <span>收起菜单</span> : null}
          </button>
        </div>
      ) : null}
    </>
  );
}

function ConsoleShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const toast = useToast();
  const pathname = usePathname();
  const hydrated = useHydrated();

  const [collapsed, setCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // 记住折叠状态（必须等水合完成再读 localStorage，否则服务端与客户端首帧不一致）
  useEffect(() => {
    if (!hydrated) return;
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, [hydrated]);

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

  // 路由变化时关闭移动抽屉（React 官方"props 变化时调整 state"的写法，避免额外 effect）
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setDrawerOpen(false);
  }

  // 抽屉打开时：锁定 body 滚动 + 支持 Esc 关闭
  useEffect(() => {
    if (!drawerOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen]);

  // 抽屉打开时把焦点移入，便于键盘与读屏用户
  useEffect(() => {
    if (drawerOpen) drawerRef.current?.focus();
  }, [drawerOpen]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      toast.error('退出登录失败，请重试');
      setLoggingOut(false);
    }
  };

  const menus = visibleMenus(user);
  const current: MenuItem | undefined = menus.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );

  const displayName = user?.display_name || user?.username || '';
  const initial = displayName.trim().slice(0, 1) || '用';
  const roles = user?.roles ?? [];

  return (
    <div className="flex min-h-dvh bg-subtle">
      {/* ---------------- 桌面固定侧栏 ---------------- */}
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-canvas',
          'transition-[width] duration-200 lg:flex',
          collapsed ? 'w-[72px]' : 'w-[240px]',
        )}
      >
        <SidebarContent collapsed={collapsed} onToggleCollapse={toggleCollapsed} />
      </aside>

      {/* ---------------- 移动端抽屉 ---------------- */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          {/* 遮罩：点击关闭 */}
          <button
            type="button"
            aria-label="关闭菜单"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          {/* 抽屉本体 */}
          <div
            ref={drawerRef}
            tabIndex={-1}
            className="absolute left-0 top-0 flex h-full w-[264px] max-w-[82vw] flex-col bg-canvas shadow-xl outline-none"
          >
            <SidebarContent collapsed={false} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      ) : null}

      {/* ---------------- 主区域 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line bg-canvas/95 px-3 backdrop-blur sm:gap-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {/* 汉堡按钮：仅移动端 */}
            {/* 汉堡按钮：仅移动端。图标 20px 时靠 p-3 把可点区撑到约 44px */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开菜单"
              className="-ml-2 rounded-lg p-3 text-muted transition-colors hover:bg-muted-surface hover:text-body sm:p-2 lg:hidden"
            >
              <Icon name="menu" className="h-5 w-5" />
            </button>

            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-strong">
                {current?.label ?? '控制台'}
              </h1>
              <p className="hidden truncate text-[11px] text-faint sm:block">
                {current?.description ?? '知识库管理平台'}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {/* 当前用户：窄屏只留头像 */}
            <div className="hidden items-center gap-2.5 rounded-lg border border-line bg-canvas px-2.5 py-1.5 md:flex">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">
                {initial}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-body">{displayName}</p>
                <p className="truncate text-[11px] text-faint">
                  {user?.department?.name ?? '未分配部门'}
                  {user?.is_superuser ? ' · 超级管理员' : ''}
                </p>
              </div>
            </div>

            {/* 角色标签：仅宽屏展示 */}
            <div className="hidden max-w-[260px] flex-wrap items-center justify-end gap-1 xl:flex">
              {roles.slice(0, 3).map((role) => (
                <span
                  key={role.id}
                  title={role.code}
                  className="rounded-md border border-line bg-subtle px-1.5 py-0.5 text-[11px] text-muted"
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
                  className="rounded-md border border-line bg-subtle px-1.5 py-0.5 text-[11px] text-muted"
                >
                  +{roles.length - 3}
                </span>
              ) : null}
              {roles.length === 0 ? (
                <span className="text-[11px] text-faint">无角色</span>
              ) : null}
            </div>

            <ThemeToggle />

            <Button
              size="sm"
              variant="outline"
              icon="logout"
              loading={loggingOut}
              onClick={handleLogout}
            >
              {/* 窄屏只留图标，避免挤压标题 */}
              <span className="hidden sm:inline">退出登录</span>
            </Button>
          </div>
        </header>

        {/* 页面内容：窄屏收紧内边距 */}
        <main className="min-w-0 flex-1 p-3 pb-safe sm:p-5">{children}</main>

        <footer className="px-3 pb-4 text-[11px] text-faint sm:px-5">
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
