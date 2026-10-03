'use client';

/**
 * 运营看板：PV/UV、知识量、Token 消耗、响应延时分布与热榜。
 * 数据一次拉取：GET /api/dashboard/all?days=7|14|30
 */
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import type { EChartsOption } from 'echarts';

import Chart from '@/components/Chart';
import { Icon } from '@/components/Icons';
import {
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Segmented,
  StatCard,
} from '@/components/primitives';
import { dashboardApi, errorMessage, type DashboardPayload } from '@/lib/api';
import { RequireAuth } from '@/lib/auth';

/* ------------------------------------------------------------------ */
/* 格式化工具                                                          */
/* ------------------------------------------------------------------ */

const INTEGER_FORMATTER = new Intl.NumberFormat('zh-CN');

function formatInt(value: number | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '0';
  return INTEGER_FORMATTER.format(Math.round(value));
}

function formatCompact(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)} 万`;
  return INTEGER_FORMATTER.format(Math.round(value));
}

function formatPercent(ratio: number | undefined, digits = 1): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return '0%';
  const normalized = ratio > 1 ? ratio : ratio * 100;
  return `${normalized.toFixed(digits)}%`;
}

function formatLatency(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '0 ms';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** 排行榜是否没有任何有效数据。 */
function isBlank(rows: ReadonlyArray<{ value: number }> | undefined): boolean {
  if (!rows || rows.length === 0) return true;
  return rows.every((row) => !row.value);
}

/* ------------------------------------------------------------------ */
/* ECharts 配置                                                        */
/* ------------------------------------------------------------------ */

const PALETTE = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6'];

const BASE_GRID = { left: 12, right: 20, top: 36, bottom: 8, containLabel: true };

/**
 * 图表文字与轴线的颜色用 `'@token:xxx'` 占位符表达语义角色。
 *
 * ECharts 把颜色画进 canvas，读不到 CSS 变量，所以不能直接写 `var(--color-muted)`；
 * 而写死 `#64748b` 这类十六进制值会让暗色主题下的图表停留在亮色配色。
 * `Chart.tsx` 会在渲染时（并按主题变化重算）把这些占位符解析成当前主题的实际色值，
 * 见 `src/lib/chartTheme.ts`。
 *
 * 系列色（PALETTE）保持固定，符合规范：品牌色与状态色不参与主题反转。
 */
const BASE_TEXT_STYLE = { fontSize: 11, color: '@token:label' };

/** 访问量趋势：PV + UV 双折线。 */
function buildVisitOption(data: DashboardPayload['visit_trend']): EChartsOption {
  return {
    color: PALETTE,
    textStyle: BASE_TEXT_STYLE,
    grid: BASE_GRID,
    tooltip: { trigger: 'axis' },
    legend: { data: ['PV 提问量', 'UV 提问人数'], top: 0, right: 0, itemHeight: 8, itemWidth: 12, textStyle: BASE_TEXT_STYLE },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: data.map((item) => item.label),
      axisLine: { lineStyle: { color: '@token:axis' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '@token:split' } },
      axisLine: { show: false },
    },
    series: [
      {
        name: 'PV 提问量',
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: { color: 'rgba(79,70,229,0.10)' },
        data: data.map((item) => item.value),
      },
      {
        name: 'UV 提问人数',
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: { color: 'rgba(14,165,233,0.10)' },
        data: data.map((item) => item.uv ?? 0),
      },
    ],
  };
}

/** Token 消耗趋势：柱状。 */
function buildTokenOption(data: DashboardPayload['token_trend']): EChartsOption {
  return {
    color: ['#6366f1'],
    textStyle: BASE_TEXT_STYLE,
    grid: BASE_GRID,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      data: data.map((item) => item.label),
      axisLine: { lineStyle: { color: '@token:axis' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '@token:split' } },
      axisLine: { show: false },
    },
    series: [
      {
        name: 'Token 消耗',
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: data.map((item) => item.value),
      },
    ],
  };
}

/** 响应延时分布：柱状。 */
function buildLatencyOption(data: DashboardPayload['latency_distribution']): EChartsOption {
  return {
    color: ['#f59e0b'],
    textStyle: BASE_TEXT_STYLE,
    grid: BASE_GRID,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      data: data.map((item) => item.label),
      axisLine: { lineStyle: { color: '@token:axis' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '@token:split' } },
      axisLine: { show: false },
    },
    series: [
      {
        name: '回答数',
        type: 'bar',
        barMaxWidth: 28,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: data.map((item) => item.value),
      },
    ],
  };
}

/** 横向柱状图（常见问题 / 高频引用知识）。 */
function buildHorizontalOption(
  rows: ReadonlyArray<{ name: string; value: number }>,
  color: string,
  seriesName: string,
): EChartsOption {
  // 横向柱状：ECharts 的 y 轴类目顺序自下而上，需要反转以保证 TOP1 在最上方
  const reversed = [...rows].reverse();
  return {
    color: [color],
    textStyle: BASE_TEXT_STYLE,
    grid: { left: 12, right: 36, top: 12, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '@token:split' } },
      axisLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: reversed.map((row) => (row.name.length > 18 ? `${row.name.slice(0, 18)}…` : row.name)),
      axisLine: { lineStyle: { color: '@token:axis' } },
      axisTick: { show: false },
    },
    series: [
      {
        name: seriesName,
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', fontSize: 10, color: '@token:faint' },
        data: reversed.map((row) => row.value),
      },
    ],
  };
}

/** 部门提问排行：环形饼图。 */
function buildDepartmentOption(data: DashboardPayload['department_question_rank']): EChartsOption {
  return {
    color: PALETTE,
    textStyle: BASE_TEXT_STYLE,
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, itemHeight: 8, itemWidth: 12, textStyle: BASE_TEXT_STYLE },
    series: [
      {
        name: '部门提问量',
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '@token:canvas', borderWidth: 2 },
        label: { show: false },
        data: data.map((item) => ({ name: item.name, value: item.value })),
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

const DAY_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '近 7 天', value: 7 },
  { label: '近 14 天', value: 14 },
  { label: '近 30 天', value: 30 },
];

function DashboardContent() {
  const [days, setDays] = useState<number>(7);

  const { data, error, isLoading, mutate } = useSWR<DashboardPayload>(
    ['/dashboard/all', days],
    () => dashboardApi.all(days),
    { keepPreviousData: true, revalidateOnFocus: false },
  );

  const overview = data?.overview;

  const visitOption = useMemo(() => buildVisitOption(data?.visit_trend ?? []), [data?.visit_trend]);
  const tokenOption = useMemo(() => buildTokenOption(data?.token_trend ?? []), [data?.token_trend]);
  const latencyOption = useMemo(
    () => buildLatencyOption(data?.latency_distribution ?? []),
    [data?.latency_distribution],
  );
  const questionOption = useMemo(
    () => buildHorizontalOption(data?.top_questions ?? [], '#4f46e5', '提问次数'),
    [data?.top_questions],
  );
  const documentOption = useMemo(
    () => buildHorizontalOption(data?.top_documents ?? [], '#10b981', '被引用次数'),
    [data?.top_documents],
  );
  const departmentOption = useMemo(
    () => buildDepartmentOption(data?.department_question_rank ?? []),
    [data?.department_question_rank],
  );

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* 工具条：窄屏分段控件占满整行，避免与刷新按钮互相挤压 */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-2 text-xs text-muted">
          <Icon name="dashboard" className="h-4 w-4 text-brand-ink" />
          <span>统计范围：最近 {days} 天</span>
          {isLoading && data ? <span className="text-faint">· 正在刷新…</span> : null}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Segmented options={DAY_OPTIONS} value={days} onChange={setDays} className="flex-1 sm:flex-none" />
          <button
            type="button"
            onClick={() => void mutate()}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 text-xs text-body hover:bg-subtle"
          >
            <Icon name="refresh" className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <ErrorState message={errorMessage(error, '看板数据加载失败')} onRetry={() => void mutate()} />
      ) : null}

      {isLoading && !data ? <Loading text="正在加载看板数据…" /> : null}

      {overview ? (
        <>
          {/* 指标卡：手机保持两列（一列会浪费纵向空间），宽屏四列 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="提问量 / 提问人数（PV / UV）"
              value={`${formatInt(overview.pv)} / ${formatInt(overview.uv)}`}
              icon="users"
              tone="indigo"
              hint={`累计提问 ${formatInt(overview.question_count)} 次（最近 ${days} 天）`}
            />
            <StatCard
              label="知识单元总数"
              value={formatInt(overview.document_count)}
              unit="篇"
              icon="file"
              tone="sky"
              hint={`已就绪 ${formatInt(overview.ready_document_count)} 篇`}
            />
            <StatCard
              label="知识切片数"
              value={formatCompact(overview.chunk_count)}
              unit="片"
              icon="layers"
              tone="violet"
              hint="向量化入库的检索单元"
            />
            <StatCard
              label="FAQ 标准问答数"
              value={formatInt(overview.faq_count)}
              unit="条"
              icon="database"
              tone="emerald"
              hint={`缓存命中率 ${formatPercent(overview.faq_cache_hit_rate)}`}
            />
            <StatCard
              label="知识覆盖率"
              value={formatPercent(overview.knowledge_coverage)}
              icon="percent"
              tone="emerald"
              hint="已命中知识的问题占比"
            />
            <StatCard
              label="平均响应延时"
              value={formatLatency(overview.avg_latency_ms)}
              icon="zap"
              tone="amber"
              hint={`P95 延时 ${formatLatency(overview.p95_latency_ms)}`}
            />
            <StatCard
              label="Token 消耗"
              value={formatCompact(overview.total_tokens)}
              icon="trending"
              tone="rose"
              hint="最近统计周期内的模型用量"
            />
            <StatCard
              label="待处理知识缺口"
              value={formatInt(overview.gap_count)}
              unit="项"
              icon="alert"
              tone={overview.gap_count > 0 ? 'amber' : 'slate'}
              hint="检索未命中或置信度偏低"
            />
          </div>

          {/* 趋势图：手机单列，宽屏两列 */}
          <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
            <Card
              title="访问量趋势"
              description="每日提问量（PV）与独立提问人数（UV）"
              bodyClassName="pt-2"
            >
              <Chart option={visitOption} height={300} />
            </Card>

            <Card title="Token 消耗趋势" description="每日大模型 Token 用量" bodyClassName="pt-2">
              <Chart option={tokenOption} height={300} />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
            <Card title="响应延时分布" description="按区间统计回答数量" bodyClassName="pt-2">
              <Chart option={latencyOption} height={280} />
            </Card>

            <Card title="部门提问排行" description="各部门提问量占比" bodyClassName="pt-2">
              {isBlank(data?.department_question_rank) ? (
                <EmptyState title="暂无部门提问数据" description="所选周期内还没有带部门的提问记录" icon="users" />
              ) : (
                <Chart option={departmentOption} height={280} />
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
            <Card
              title="常见问题 TOP"
              description="高频提问排行（取前 10）"
              bodyClassName="pt-2"
            >
              {isBlank(data?.top_questions) ? (
                <EmptyState title="暂无高频提问" description="所选周期内还没有提问记录" icon="chat" />
              ) : (
                <Chart option={questionOption} height={320} />
              )}
            </Card>

            <Card
              title="高频引用知识 TOP"
              description="被回答引用次数最多的知识单元"
              bodyClassName="pt-2"
            >
              {isBlank(data?.top_documents) ? (
                <EmptyState
                  title="暂无知识引用数据"
                  description="提问命中知识后，这里会展示被引用最多的知识单元"
                  icon="knowledge"
                />
              ) : (
                <Chart option={documentOption} height={320} />
              )}
            </Card>
          </div>
        </>
      ) : null}

      {!isLoading && !error && !overview ? (
        <EmptyState title="暂无看板数据" description="后端暂未返回统计数据" icon="dashboard" />
      ) : null}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth anyOf={['menu:dashboard', 'dashboard:view']}>
      <DashboardContent />
    </RequireAuth>
  );
}
