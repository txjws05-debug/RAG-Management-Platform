'use client'

/**
 * 极简 UI 基础件（全部 Tailwind 手写，不依赖任何 UI 组件库）。
 * 仅本代理创建的页面/组件内部使用，避免与基础设施代理的 components/* 冲突。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 把任意异常转成可展示的中文提示（优先使用 ApiError.message）。 */
export function errText(err: unknown, fallback = '操作失败，请稍后重试'): string {
  if (err instanceof ApiError) return err.message || fallback
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string' && err.trim()) return err
  return fallback
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatFileSize(bytes?: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatNumber(value?: number | null): string {
  if (value === null || value === undefined) return '0'
  return value.toLocaleString('zh-CN')
}

/** 简单防抖，用于关键词检索输入。 */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/* ------------------------------------------------------------------ */
/* 按钮                                                                */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-700 border border-transparent disabled:bg-indigo-300',
  secondary:
    'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-100 disabled:opacity-60',
  outline:
    'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200 disabled:opacity-60',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border border-transparent',
  danger:
    'bg-white text-rose-600 hover:bg-rose-50 border border-rose-200 disabled:opacity-60',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1',
  md: 'h-9 px-3.5 text-sm gap-1.5',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export function Button({
  variant = 'outline',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin text-current', className ?? 'h-4 w-4')} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* 表单控件                                                            */
/* ------------------------------------------------------------------ */

const FIELD_BASE =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 ' +
  'placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 ' +
  'disabled:bg-slate-50 disabled:text-slate-400'

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(FIELD_BASE, 'h-9', className)} />
}

export function TextArea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(FIELD_BASE, 'min-h-[80px] leading-relaxed', className)} />
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(FIELD_BASE, 'h-9 pr-8', className)}>
      {children}
    </select>
  )
}

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: string
  hint?: React.ReactNode
  required?: boolean
  children: React.ReactNode
  className?: string
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
  )
}

export function Checkbox({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      {...rest}
      className={cn(
        'h-4 w-4 cursor-pointer rounded border-slate-300 text-indigo-600',
        'focus:ring-2 focus:ring-indigo-200',
        className,
      )}
    />
  )
}

export function Switch({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        checked ? 'bg-indigo-600' : 'bg-slate-300',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 展示件                                                              */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-100',
        className,
      )}
    >
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-800">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export type BadgeTone =
  | 'slate'
  | 'indigo'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'sky'
  | 'violet'

const BADGE_TONES: Record<BadgeTone, string> = {
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  amber: 'bg-amber-50 text-amber-700 border-amber-100',
  rose: 'bg-rose-50 text-rose-700 border-rose-100',
  sky: 'bg-sky-50 text-sky-700 border-sky-100',
  violet: 'bg-violet-50 text-violet-700 border-violet-100',
}

export function Badge({
  tone = 'slate',
  children,
  className,
  title,
}: {
  tone?: BadgeTone
  children: React.ReactNode
  className?: string
  title?: string
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
  )
}

export function ProgressBar({
  value,
  tone = 'indigo',
  className,
}: {
  value: number
  tone?: 'indigo' | 'emerald' | 'rose' | 'amber'
  className?: string
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  const tones: Record<string, string> = {
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    rose: 'bg-rose-500',
    amber: 'bg-amber-500',
  }
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-slate-100', className)}>
      <div
        className={cn('h-full rounded-full transition-all duration-300', tones[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function EmptyState({
  title = '暂无数据',
  description,
  action,
}: {
  title?: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {description ? <p className="text-xs text-slate-400">{description}</p> : null}
      {action}
    </div>
  )
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
      {children}
    </div>
  )
}

export function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/70 px-3 py-2 text-xs leading-relaxed text-indigo-700">
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 分页                                                                */
/* ------------------------------------------------------------------ */

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  className,
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
  className?: string
}) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 pt-3', className)}>
      <p className="text-xs text-slate-500">
        共 {total} 条，当前 {from}-{to} 条 · 第 {page}/{totalPages} 页
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          上一页
        </Button>
        <Button size="sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          下一页
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 浮层：Modal / Drawer                                                 */
/* ------------------------------------------------------------------ */

function useEscape(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, onClose])
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  widthClass = 'max-w-2xl',
}: {
  open: boolean
  title: React.ReactNode
  description?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  widthClass?: string
}) {
  useEscape(open, onClose)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div
        className={cn(
          'my-auto w-full rounded-xl border border-slate-200 bg-white shadow-xl',
          widthClass,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md px-2 py-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ×
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
  )
}

export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  widthClass = 'max-w-xl',
}: {
  open: boolean
  title: React.ReactNode
  description?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  widthClass?: string
}) {
  useEscape(open, onClose)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40">
      <aside
        className={cn(
          'flex h-full w-full flex-col border-l border-slate-200 bg-white shadow-2xl',
          widthClass,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-800">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md px-2 py-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 轻量消息条                                                          */
/* ------------------------------------------------------------------ */

export interface Notice {
  tone: 'success' | 'error' | 'info'
  text: string
}

const NOTICE_TONES: Record<Notice['tone'], string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  error: 'border-rose-200 bg-rose-50 text-rose-700',
  info: 'border-indigo-100 bg-indigo-50 text-indigo-700',
}

/** 一次性提示：setNotice({tone,text})，4 秒后自动消失。 */
export function useNotice(timeout = 4000) {
  const [notice, setNotice] = useState<Notice | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const push = useCallback(
    (tone: Notice['tone'], text: string) => {
      setNotice({ tone, text })
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setNotice(null), timeout)
    },
    [timeout],
  )

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const node = useMemo(
    () =>
      notice ? (
        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-xs font-medium',
            NOTICE_TONES[notice.tone],
          )}
        >
          {notice.text}
        </div>
      ) : null,
    [notice],
  )

  return { notice, push, node, clear: () => setNotice(null) }
}

/** 表格外框，统一横向滚动与最小宽度。 */
export function TableWrap({
  children,
  minWidthClass = 'min-w-[880px]',
}: {
  children: React.ReactNode
  minWidthClass?: string
}) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', minWidthClass)}>{children}</table>
    </div>
  )
}

export function Th({
  children,
  className,
}: {
  children?: React.ReactNode
  className?: string
}) {
  return (
    <th
      className={cn(
        'border-b border-slate-200 bg-slate-50/80 px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap text-slate-500',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  className,
}: {
  children?: React.ReactNode
  className?: string
}) {
  return (
    <td className={cn('border-b border-slate-100 px-3 py-2.5 align-middle text-slate-700', className)}>
      {children}
    </td>
  )
}
