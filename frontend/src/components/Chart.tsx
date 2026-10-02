'use client';

/**
 * ECharts 统一封装。
 *
 * 关键处理（避免图表不显示 / SSR 报错）：
 * 1. `echarts-for-react` 通过 next/dynamic + `ssr: false` 动态导入，服务端不渲染 canvas
 * 2. 外层容器固定高度（默认 300px），内层画布 100%，避免父级高度为 0
 * 3. ResizeObserver + window.resize 双保险，容器变化时调用实例 resize()
 * 4. opts.renderer = 'canvas'
 */
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, type CSSProperties, type ComponentType, type Ref } from 'react';
import type { EChartsOption } from 'echarts';

import { cn } from '@/components/primitives';

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
  loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-slate-100" />,
}) as unknown as ComponentType<ReactEChartsProps>;

export interface ChartProps {
  option: EChartsOption;
  /** 容器固定高度（px），默认 300。 */
  height?: number;
  className?: string;
  notMerge?: boolean;
}

export default function Chart({ option, height = 300, className, notMerge = true }: ChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsHandle | null>(null);
  const rafRef = useRef<number | null>(null);

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

    // 首帧后补一次 resize：容器初始尺寸为 0 时 ECharts 会画不出来
    resize();

    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    observer?.observe(el);
    window.addEventListener('resize', resize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [resize]);

  // 数据/主题变化后重新适配尺寸（例如 7/14/30 天切换导致轴标签长度变化）
  useEffect(() => {
    resize();
  }, [option, resize]);

  return (
    <div ref={wrapRef} className={cn('w-full', className)} style={{ height }}>
      <ReactECharts
        ref={chartRef}
        option={option}
        notMerge={notMerge}
        lazyUpdate
        opts={{ renderer: 'canvas' }}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
