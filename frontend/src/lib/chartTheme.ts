'use client';

import { useMemo } from 'react';

import { useTheme } from '@/lib/theme';

/**
 * ECharts 的主题桥接层。
 *
 * 问题的本质：ECharts 把颜色画进 canvas，**读不到 CSS 变量**。
 * 而设计规范要求颜色以语义角色命名、由 `data-theme` 驱动。
 * 于是会产生一个缺口：`axisLine: { color: 'var(--color-line)' }` 这种写法 ECharts 无法解析，
 * 硬编码 `#e2e8f0` 又会让暗色主题下的图表停留在亮色配色（轴线过亮、标签过暗）。
 *
 * 解决方式：让调用方继续写语义角色名，由这里在**渲染时**从 document
 * 读取对应 CSS 变量的实际值再交给 ECharts。这样：
 *   - 图表配置依然按语义命名，不散落十六进制值；
 *   - 暗色主题下取到的是暗色值，图表与页面一起切换；
 *   - 主题变化时由 `useChartTheme()` 触发重渲染，图表立即跟上。
 *
 * 注意：品牌色与状态色**不列为 token**，它们是固定色。
 * 规范明确要求不要为主题去调亮品牌色 —— `bg-indigo-600 text-white` 是一对搭档，
 * 只动其中一半就会得到浅蓝底白字。所以图表里的系列颜色保持原样。
 */

/** 图表可以引用的语义颜色角色 → globals.css 中的 CSS 变量名。 */
export const CHART_TOKENS = {
  /** 轴线、刻度线、分隔线 */
  axis: '--color-line',
  /** 网格分割线（比轴线更浅） */
  split: '--color-line',
  /** 轴标签、图例文字 */
  label: '--color-muted',
  /** 次级标注（条形图数值标签等） */
  faint: '--color-faint',
  /** 强调文字 */
  strong: '--color-strong',
  /** 卡片/画布底色（饼图描边需要与底色一致才显得干净） */
  canvas: '--color-canvas',
  /** 内陷面板底色 */
  subtle: '--color-subtle',
  /** 品牌色（固定，仅作语义别名，方便统一改） */
  brand: '--color-brand',
  /** 品牌浅底 */
  brandSoft: '--color-brand-soft',
} as const;

export type ChartToken = keyof typeof CHART_TOKENS;

/** 亮色下的回退值：首帧或 SSR 期间读不到 CSS 变量时使用，避免图表空白。 */
const FALLBACK: Record<ChartToken, string> = {
  axis: '#e2e8f0',
  split: '#e2e8f0',
  label: '#64748b',
  faint: '#94a3b8',
  strong: '#0f172a',
  canvas: '#ffffff',
  subtle: '#f8fafc',
  brand: '#4f46e5',
  brandSoft: '#eef2ff',
};

/**
 * 读取当前主题下某个语义角色的实际颜色值。
 *
 * 走 `getComputedStyle` 而不是自己判断 data-theme 再查表：
 * 颜色的唯一来源始终是 CSS，这里不重复维护一套色值。
 */
export function readChartToken(token: ChartToken): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return FALLBACK[token];
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(CHART_TOKENS[token])
    .trim();
  return raw || FALLBACK[token];
}

export interface ChartPalette {
  axis: string;
  split: string;
  label: string;
  faint: string;
  strong: string;
  canvas: string;
  subtle: string;
  brand: string;
  brandSoft: string;
}

/** 一次性读出整套面板色，供 option 构造使用。 */
export function readChartPalette(): ChartPalette {
  return {
    axis: readChartToken('axis'),
    split: readChartToken('split'),
    label: readChartToken('label'),
    faint: readChartToken('faint'),
    strong: readChartToken('strong'),
    canvas: readChartToken('canvas'),
    subtle: readChartToken('subtle'),
    brand: readChartToken('brand'),
    brandSoft: readChartToken('brandSoft'),
  };
}

/**
 * 把配置里形如 `'@token:label'` 的字符串递归替换成当前主题的实际色值。
 *
 * 为什么需要它：页面的 option 常常在模块顶层（或 useMemo 外层）构造，
 * 拿不到"当前主题"这个上下文。让它们写 `'@token:label'` 这种占位符，
 * 由真正渲染的那一刻统一解析，既保持了语义命名，又保证取到的是当下主题的值。
 */
export function resolveChartTokens<T>(value: T): T {
  if (typeof value === 'string') {
    if (value.startsWith('@token:')) {
      const token = value.slice('@token:'.length) as ChartToken;
      if (token in CHART_TOKENS) {
        return readChartToken(token) as unknown as T;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveChartTokens(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveChartTokens(item);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * 返回当前主题下的图表面板色，并在主题切换时触发调用方重渲染。
 *
 * 依赖 ThemeProvider 已经提供的 `theme`：切主题会更新 React 上下文，
 * 于是所有用到本 hook 的图表会重新求值 option，把新的色值交给 ECharts。
 * 这也是为什么图表不需要注册 MutationObserver 去盯 `data-theme`。
 */
export function useChartPalette(): ChartPalette {
  const { theme } = useTheme();
  return useMemo(() => readChartPalette(), [theme]);
}
