'use client';

/**
 * 通用基础组件（全部 Tailwind 手写，不引入任何 UI 组件库）。
 * 企业后台 SaaS 风格：浅色主题、圆角卡片、border-slate-200、主色 indigo。
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useEffect } from 'react';

import { Icon, type IconName } from '@/components/Icons';

/** 条件拼接 className。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* 按钮 / 加载态                                                       */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-700 border border-transparent disabled:bg-indigo-300',
  secondary:
    'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-100 disabled:opacity-60',
  outline: 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200 disabled:opacity-60',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border border-transparent',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 border border-transparent disabled:bg-rose-300',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1',
  md: 'h-9 px-3.5 text-sm gap-1.5',
  lg: 'h-11 px-5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: IconName;
}

export function Button({
  variant = 'outline',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon ? <Icon name={icon} className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin text-current', className ?? 'h-4 w-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4z" />
    </svg>
  );
}

/** 区块级加载态。 */
export function Loading({ text = '加载中…', className }: { text?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-slate-500', className)}>
      <Spinner className="h-4 w-4 text-indigo-500" />
      <span className="text-sm">{text}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-100', className)} />;
}

/* ------------------------------------------------------------------ */
/* 卡片 / 指标卡                                                       */
/* ------------------------------------------------------------------ */

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Card({ title, description, actions, children, className, bodyClassName }: CardProps) {
  const hasHeader = Boolean(title || actions);
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-100',
        className,
      )}
    >
      {hasHeader ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-800">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export type StatTone = 'indigo' | 'emerald' | 'amber' | 'sky' | 'violet' | 'rose' | 'slate';

const STAT_TONES: Record<StatTone, string> = {
  indigo: 'bg-indigo-50 text-indigo-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  sky: 'bg-sky-50 text-sky-600',
  violet: 'bg-violet-50 text-violet-600',
  rose: 'bg-rose-50 text-rose-600',
  slate: 'bg-slate-100 text-slate-600',
};

export interface StatCardProps {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  icon?: IconName;
  tone?: StatTone;
}

export function StatCard({ label, value, unit, hint, icon, tone = 'indigo' }: StatCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-100">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        {icon ? (
          <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', STAT_TONES[tone])}>
            <Icon name={icon} className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <p className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tracking-tight text-slate-800">{value}</span>
        {unit ? <span className="text-xs text-slate-400">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 徽标 / 提示                                                         */
/* ------------------------------------------------------------------ */

export type BadgeTone = 'slate' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet';

const BADGE_TONES: Record<BadgeTone, string> = {
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-100',
  sky: 'bg-sky-50 text-sky-700 border-sky-100',
  violet: 'bg-violet-50 text-violet-700 border-violet-100',
};

export function Badge({
  tone = 'slate',
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className={cn('rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700', className)}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 空态 / 错误态                                                       */
/* ------------------------------------------------------------------ */

export function EmptyState({
  title = '暂无数据',
  description,
  action,
  icon = 'file',
  className,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center',
        className,
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-400 shadow-sm">
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {description ? <p className="max-w-md text-xs text-slate-400">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-8 text-center',
        className,
      )}
    >
      <p className="text-sm text-rose-700">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" icon="refresh" onClick={onRetry}>
          重新加载
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 表单控件                                                            */
/* ------------------------------------------------------------------ */

const FIELD_BASE =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 ' +
  'placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 ' +
  'disabled:bg-slate-50 disabled:text-slate-400';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(FIELD_BASE, 'h-9', className)} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(FIELD_BASE, 'leading-relaxed', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(FIELD_BASE, 'h-9 pr-8', className)}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="flex items-center gap-1 text-xs font-medium text-slate-600">
        {label}
        {required ? <span className="text-rose-500">*</span> : null}
      </span>
      {children}
      {hint ? <span className="block text-xs text-slate-400">{hint}</span> : null}
    </label>
  );
}

/** 分段控件（例如看板 7/14/30 天切换）。 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              active ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  className?: string;
  align?: 'left' | 'center' | 'right';
  width?: string;
}

const ALIGN: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/**
 * 轻量数据表格：泛型 + 自定义单元格渲染。
 * loading / empty 态内置，横向滚动由外层负责。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty,
  minWidthClass = 'min-w-[880px]',
  onRowClick,
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  empty?: ReactNode;
  minWidthClass?: string;
  onRowClick?: (row: T) => void;
}) {
  if (loading) return <Loading text="数据加载中…" />;
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="暂无数据" />}</>;
  }
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', minWidthClass)}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'border-b border-slate-200 bg-slate-50/80 px-3 py-2.5 text-xs font-semibold whitespace-nowrap text-slate-500',
                  ALIGN[column.align ?? 'left'],
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'transition-colors',
                onRowClick ? 'cursor-pointer hover:bg-slate-50' : 'hover:bg-slate-50/60',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'border-b border-slate-100 px-3 py-2.5 align-middle text-slate-700',
                    ALIGN[column.align ?? 'left'],
                    column.className,
                  )}
                >
                  {column.render ? column.render(row, index) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string;
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  widthClass = 'max-w-lg',
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className={cn('my-auto w-full rounded-xl border border-slate-200 bg-white shadow-xl', widthClass)}>
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
