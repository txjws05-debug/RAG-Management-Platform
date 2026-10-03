'use client';

/**
 * ECharts 统一封装。
 *
 * 关键处理（避免图表不显示 / SSR 报错）：
 * 1. `echarts-for-react` 通过 next/dynamic + `ssr: false` 动态导入，服务端不渲染 canvas
 * 2. 外层容器固定高度（默认 224/288px 响应式），内层画布 100%，避免父级高度为 0
 * 3. ResizeObserver + window.resize 双保险，容器变化时调用实例 resize()
 * 4. opts.renderer = 'canvas'
 * 5. 窄屏把 grid 边距与 legend 自动收紧，否则固定的大边距会把绘图区压成一条缝
 */
import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type Ref,
} from 'react';
import type { EChartsOption } from 'echarts';

import { cn } from '@/components/primitives';
import { resolveChartTokens } from '@/lib/chartTheme';
import { useTheme } from '@/lib/theme';

interface EChartsInstance {
  resize: () => void;
}

interface EChartsHandle {
  getEchartsInstance: () => EChartsInstance | undefined;
}

interface ReactEChartsProps {
  option: EChartsOption;
  style?: CSSProperties;
  className?: string;
  notMerge?: boolean;
  lazyUpdate?: boolean;
  opts?: { renderer?: 'canvas' | 'svg' };
  theme?: string | object;
  ref?: Ref<EChartsHandle>;
}

const ReactECharts = dynamic(() => import('echarts-for-react'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-subtle" />,
}) as unknown as ComponentType<ReactEChartsProps>;

/** 窄屏（约等于手机）阈值：低于它 legend 移到顶部、轴标签缩小。 */
const NARROW_WIDTH = 640;

/** 默认容器高度：手机 224px，≥sm 288px。 */
const DEFAULT_HEIGHT_CLASS = 'h-56 sm:h-72';

export interface ChartProps {
  option: EChartsOption;
  /** 容器固定高度（px）。不传则用响应式高度（h-56 sm:h-72）。 */
  height?: number;
  className?: string;
  notMerge?: boolean;
}

export default function Chart({ option, height, className, notMerge = true }: ChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  // 主题变化需要重算 option 里的颜色（canvas 读不到 CSS 变量）
  const { theme } = useTheme();
  // 只在「跨越窄屏断点」时才写 state：ResizeObserver 在滚动/旋屏时高频触发，
  // 每次都 setState 会让整张图重新求值 option 并重绘。
  const [narrow, setNarrow] = useState(false);

  const resize = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      chartRef.current?.getEchartsInstance()?.resize();
      rafRef.current = null;
    });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const sync = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const next = width < NARROW_WIDTH;
      setNarrow((prev) => (prev === next ? prev : next));
      resize();
    };

    // 首帧后补一次同步：容器初始尺寸为 0 时 ECharts 会画不出来
    sync();

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    observer?.observe(el);
    window.addEventListener('resize', sync);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [resize]);

  // 数据/主题变化后重新适配尺寸（例如 7/14/30 天切换导致轴标签长度变化）
  useEffect(() => {
    resize();
  }, [option, resize]);

  /** 只补默认值，不覆盖调用方已显式配置的 grid / legend / axisLabel。 */
  const mergedOption = useMemo<EChartsOption>(() => {
    const axisLabel = { fontSize: narrow ? 10 : 12 };
    return {
      grid: narrow
        ? { left: 4, right: 8, top: 36, bottom: 4, containLabel: true }
        : { left: 8, right: 16, top: 56, bottom: 8, containLabel: true },
      legend: narrow
        ? { top: 0, left: 'center', itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 10 } }
        : { top: 0, left: 'center', itemWidth: 12, itemHeight: 10, textStyle: { fontSize: 12 } },
      ...option,
      xAxis: withAxisLabel(option.xAxis, axisLabel),
      yAxis: withAxisLabel(option.yAxis, axisLabel),
    };
  }, [option, narrow]);

  /**
   * ECharts 画的是 canvas，读不到 CSS 变量，所以调用方无法直接写 `var(--color-line)`。
   * 约定用 `'@token:label'` 之类的占位符表达语义角色，在这里统一解析成
   * **当前主题**（由 ThemeProvider 跟踪，切主题会重算本 useMemo）的实际色值。
   * 这样图表轴线与标签会和页面一起在亮暗之间切换，而不是停留在亮色配色。
   */
  const themedOption = useMemo<EChartsOption>(
    () => resolveChartTokens(mergedOption),
    [mergedOption, theme],
  );

  return (
    <div
      ref={wrapRef}
      className={cn('w-full', height === undefined && DEFAULT_HEIGHT_CLASS, className)}
      style={height === undefined ? undefined : { height }}
    >
      <ReactECharts
        ref={chartRef}
        option={themedOption}
        notMerge={notMerge}
        lazyUpdate
        opts={{ renderer: 'canvas' }}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}

/** ECharts 的 xAxis/yAxis 可能是对象、数组或 undefined，统一按数组处理后再还原形状。 */
function withAxisLabel<T>(axis: T, defaults: { fontSize: number }): T {
  if (!axis) return axis;
  if (Array.isArray(axis)) {
    return axis.map((item) => mergeAxisLabel(item, defaults)) as unknown as T;
  }
  return mergeAxisLabel(axis, defaults) as T;
}

function mergeAxisLabel(axis: unknown, defaults: { fontSize: number }): unknown {
  if (!axis || typeof axis !== 'object') return axis;
  const record = axis as Record<string, unknown>;
  const label = record.axisLabel;
  return {
    ...record,
    axisLabel:
      label && typeof label === 'object'
        ? { ...defaults, ...(label as Record<string, unknown>) }
        : defaults,
  };
}
