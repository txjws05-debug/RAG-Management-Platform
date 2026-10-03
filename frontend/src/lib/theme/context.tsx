'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useHydrated } from '@/lib/useHydrated';

/**
 * 主题处理（遵循设计规范：颜色以角色命名，主题由 `data-theme` 单一来源驱动）。
 *
 * `<html>` 上的 `data-theme` 是唯一真相来源，因此「首帧前由内联脚本设定的主题」与
 * 「React 认为的主题」不可能不一致。本 Provider 反过来读这个属性，而不是另外维护
 * 一份副本，它只负责决定"应该是什么"。
 *
 * 解析顺序：
 *   1. 用户的显式选择（存于 localStorage）；
 *   2. 否则跟随浏览器的 `prefers-color-scheme`，并在其变化时实时跟随。
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'kb.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

type ThemeValue = {
  /** 当前生效的主题。 */
  theme: Theme;
  /** 是否正在跟随系统（用户尚未显式选择过）。 */
  followsSystem: boolean;
  setTheme: (theme: Theme) => void;
  /** 清除显式选择，回到跟随系统。 */
  useSystemTheme: () => void;
  /**
   * 用服务端保存的偏好覆盖本地（登录后调用）。
   *
   * 若本地已有显式选择，则**不动**它 —— 用户在明确选过之后不希望被服务端改回去。
   * 只有当本地从未选择过时，才应用服务端的值，从而实现「换设备后偏好还在」。
   * 返回值表示是否实际应用了服务端偏好。
   */
  applyServerPreference: (preference: Theme | 'system' | null | undefined) => boolean;
  /** 浏览器水合是否完成；未完成前不要渲染依赖主题的交互控件。 */
  hydrated: boolean;
};

const ThemeContext = createContext<ThemeValue | null>(null);

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** 读取存储的显式选择；从未选择过则返回 null。 */
function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * 从 DOM 反读当前实际生效的主题。
 *
 * ThemeScript 已经把它设好了，因此反读属性可以保证与"已绘制的页面"完全同步，
 * 包括"跟随系统"这一情形 —— 那种情况下本组件根本不需要自己算出结果。
 */
function appliedTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * 把显式选择写入服务端，使偏好跨设备一致。
 *
 * 这里刻意吞掉错误：主题是纯界面偏好，写服务端失败（离线、token 过期）不应干扰用户，
 * 本地 localStorage 那份已经生效。
 */
async function persistToServer(preference: Theme | 'system'): Promise<void> {
  try {
    const { authApi, getToken } = await import('@/lib/api');
    // 未登录时没有可写入的账号，等待登录后的 applyServerPreference 流程
    if (!getToken()) return;
    await authApi.savePreferences(preference);
  } catch {
    /* 忽略：本地偏好已生效 */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  const [, forceRender] = useState(0);

  const theme: Theme = hydrated ? appliedTheme() : 'light';
  const followsSystem = hydrated && readStoredTheme() === null;

  // 未显式选择时跟随系统，这样切换系统主题（或 devtools 模拟）能实时生效，
  // 而不是只在页面加载那一刻读一次。
  useEffect(() => {
    if (!followsSystem) return;

    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      applyTheme(media.matches ? 'dark' : 'light');
      forceRender((n) => n + 1);
    };

    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [followsSystem]);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 隐私模式下存储可能不可用；本次会话内属性仍然生效。 */
    }
    forceRender((n) => n + 1);
    // 同时写入服务端，使偏好跨设备保持。失败不影响本地体验，因此静默处理。
    void persistToServer(next);
  }, []);

  const useSystemTheme = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 同上。 */
    }
    applyTheme(systemTheme());
    forceRender((n) => n + 1);
    void persistToServer('system');
  }, []);

  const applyServerPreference = useCallback(
    (preference: Theme | 'system' | null | undefined): boolean => {
      if (!preference) return false;
      // 本地已有显式选择时尊重本地：用户明确选过之后不应被服务端覆盖
      if (readStoredTheme() !== null) return false;

      if (preference === 'system') {
        applyTheme(systemTheme());
      } else {
        applyTheme(preference);
      }
      forceRender((n) => n + 1);
      return true;
    },
    [],
  );

  const value = useMemo<ThemeValue>(
    () => ({ theme, followsSystem, setTheme, useSystemTheme, applyServerPreference, hydrated }),
    [theme, followsSystem, setTheme, useSystemTheme, applyServerPreference, hydrated],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用');
  }
  return ctx;
}

/**
 * 在首帧绘制之前应用主题，避免暗色模式下的白色闪屏。
 *
 * 这里刻意使用 `<head>` 中的普通内联 `<script>`，而不是 next/script：
 * `strategy="beforeInteractive"` 会把脚本体交给 Next 自己的 loader 排队，
 * 实测要等到首帧之后才执行，结果是每次加载都能看见一次浅色闪屏。
 * 同步内联脚本会阻塞解析，因此属性在任何内容被绘制之前就已设好。
 *
 * 它按与 Provider 相同的顺序读取同样的两个来源，所以两者永远一致；
 * `<html>` 上的 `suppressHydrationWarning` 让 React 保留这个属性而不报警。
 */
export function ThemeScript() {
  const script = `(function(){try{var s=localStorage.getItem(${JSON.stringify(
    STORAGE_KEY,
  )});var m=window.matchMedia(${JSON.stringify(
    DARK_QUERY,
  )}).matches;document.documentElement.setAttribute("data-theme",(s==="dark"||s==="light")?s:(m?"dark":"light"))}catch(e){try{document.documentElement.setAttribute("data-theme",window.matchMedia(${JSON.stringify(
    DARK_QUERY,
  )}).matches?"dark":"light")}catch(e2){}}})()`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
