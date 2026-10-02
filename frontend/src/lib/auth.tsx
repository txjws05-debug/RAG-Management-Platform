'use client';

/**
 * 登录态管理：AuthProvider / useAuth / RequireAuth。
 *
 * - token 存 localStorage（key = kb_token），并在启动时调用 `GET /auth/me` 校验有效性
 * - 校验失败（401 / token 过期）自动清除本地 token，回到未登录态
 * - 不依赖后端下发的 HttpOnly Cookie，避免跨端口 / 跨域场景登录态丢失
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';

import {
  authApi,
  clearToken,
  errorMessage,
  getToken,
  setToken,
  type UserProfile,
} from '@/lib/api';
import { hasAnyPermission, hasPermission } from '@/lib/permissions';

interface AuthContextValue {
  /** 当前登录用户；null 表示未登录或校验中。 */
  user: UserProfile | null;
  token: string | null;
  /** 启动校验中（此时不要做任何跳转判断）。 */
  loading: boolean;
  login: (username: string, password: string) => Promise<UserProfile>;
  logout: () => Promise<void>;
  /** 主动刷新用户信息（权限变更后可用）。 */
  refresh: () => Promise<UserProfile | null>;
  /** 操作级鉴权快捷方法。 */
  can: (code: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function InlineSpinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4z" />
    </svg>
  );
}

/** 全屏加载占位（登录态校验、跳转过渡时使用）。 */
export function FullPageLoading({ text = '正在加载…' }: { text?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 text-slate-500">
      <InlineSpinner className="h-6 w-6 text-indigo-500" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** 启动校验：有 token 就调 /auth/me 确认是否仍然有效。 */
  useEffect(() => {
    let alive = true;
    const bootstrap = async () => {
      const stored = getToken();
      if (!stored) {
        if (alive) setLoading(false);
        return;
      }
      setTokenState(stored);
      try {
        const profile = await authApi.me();
        if (!alive) return;
        setUser(profile);
      } catch {
        // token 过期 / 被吊销 / 后端不可用：一律回到未登录态
        clearToken();
        if (!alive) return;
        setTokenState(null);
        setUser(null);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void bootstrap();
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<UserProfile> => {
    const result = await authApi.login(username.trim(), password);
    setToken(result.access_token);
    setTokenState(result.access_token);
    setUser(result.user);
    setLoading(false);
    return result.user;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } catch {
      // 后端不可达也要允许本地退出
    } finally {
      clearToken();
      setTokenState(null);
      setUser(null);
      router.replace('/login');
    }
  }, [router]);

  const refresh = useCallback(async (): Promise<UserProfile | null> => {
    if (!getToken()) {
      setUser(null);
      return null;
    }
    try {
      const profile = await authApi.me();
      setUser(profile);
      return profile;
    } catch (err) {
      clearToken();
      setTokenState(null);
      setUser(null);
      throw err;
    }
  }, []);

  const can = useCallback((code: string) => hasPermission(user, code), [user]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, loading, login, logout, refresh, can }),
    [user, token, loading, login, logout, refresh, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 读取登录态；必须在 <AuthProvider> 内部使用。 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}

/** 权限不足时的居中提示面板。 */
function ForbiddenPanel({ text }: { text: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl border border-amber-200 bg-amber-50 px-5 py-6 text-center"
      >
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-600">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
            <path d="M12 9v4" strokeLinecap="round" />
            <path d="M12 17h.01" strokeLinecap="round" />
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-amber-800">访问受限</p>
        <p className="mt-1 text-xs leading-relaxed text-amber-700">{text}</p>
      </div>
    </div>
  );
}

export interface RequireAuthProps {
  children: ReactNode;
  /** 需要的单个权限码。 */
  permission?: string;
  /** 需要的权限码（满足任一即可）。 */
  anyOf?: readonly string[];
  /** 权限不足时自定义展示。 */
  fallback?: ReactNode;
}

/**
 * 路由级登录 / 权限守卫。
 * 未登录 → 跳转 /login；权限不足 → 渲染安全提示，绝不渲染受保护内容。
 */
export function RequireAuth({ children, permission, anyOf, fallback }: RequireAuthProps) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading) return <FullPageLoading text="正在校验登录态…" />;
  if (!user) return <FullPageLoading text="未登录，正在跳转登录页…" />;

  const allowed = permission
    ? hasPermission(user, permission)
    : anyOf && anyOf.length > 0
      ? hasAnyPermission(user, anyOf)
      : true;

  if (!allowed) {
    if (fallback) return <>{fallback}</>;
    const need = permission ?? (anyOf ?? []).join(' / ');
    return <ForbiddenPanel text={`当前账号（${user.display_name}）缺少访问该页面所需的权限：${need}。请联系系统管理员为您所属角色分配相应权限。`} />;
  }

  return <>{children}</>;
}

/** 统一的登录后跳转目标。 */
export function loginRedirectTarget(): string {
  return '/dashboard';
}

/** 便捷：把任意异常转成登录页可展示的文案。 */
export function loginErrorText(err: unknown): string {
  return errorMessage(err, '登录失败，请稍后重试');
}
