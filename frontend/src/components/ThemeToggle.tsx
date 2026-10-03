'use client';

/**
 * 顶栏一键明暗切换（设计规范：开关放在顶栏，与语言切换器并列）。
 *
 * 两个关键约束：
 *  1. 首帧前不渲染真实值 —— 主题来自 localStorage，服务端读不到。水合完成前
 *     先渲染服务端的假设并禁用按钮，否则 React 会因水合不匹配丢弃整棵树。
 *  2. 点击即固定为显式选择，写入 localStorage；Settings 侧提供回到"跟随系统"的入口。
 */
import { useTheme } from '@/lib/theme';
import { Icon } from '@/components/Icons';
import { cn } from '@/components/primitives';

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, followsSystem, setTheme, hydrated } = useTheme();

  const label = !hydrated ? '主题' : followsSystem ? '跟随系统' : theme === 'dark' ? '暗色' : '亮色';
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      disabled={!hydrated}
      onClick={() => setTheme(next)}
      title={hydrated ? `切换到${next === 'dark' ? '暗色' : '亮色'}主题` : '主题加载中'}
      aria-label={hydrated ? `切换到${next === 'dark' ? '暗色' : '亮色'}主题` : '主题加载中'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2 py-1.5',
        'text-xs font-medium text-muted transition-colors',
        'hover:bg-muted-surface hover:text-body',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'touch-target sm:min-h-0 sm:min-w-0',
        className,
      )}
    >
      <Icon
        name={theme === 'dark' ? 'sun' : 'moon'}
        className={cn('h-4 w-4 shrink-0', !hydrated && 'opacity-40')}
      />
      {/* 窄屏只留图标，避免顶栏拥挤 */}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export default ThemeToggle;
