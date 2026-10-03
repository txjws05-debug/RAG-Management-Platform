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

/* 主按钮的 indigo/white 是固定色对：暗色下若把 indigo 调亮就会变成浅蓝底白字，
   所以品牌填充色刻意不参与主题化，只有中性色走 token。 */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-white hover:bg-brand-dark border border-transparent disabled:bg-brand/50',
  secondary:
    'bg-brand-soft text-brand-ink hover:bg-raised border border-brand-ink/30 disabled:opacity-60',
  outline:
    'bg-canvas text-body hover:bg-subtle border border-line disabled:opacity-60',
  ghost: 'bg-transparent text-body hover:bg-subtle border border-transparent',
  danger:
    'bg-canvas text-rose-600 hover:bg-rose-50 border border-rose-200 disabled:opacity-60',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1',
  md: 'h-9 px-3.5 text-sm gap-1.5',
}

/**
 * 可点击元素的共用类：触屏下把可点区抬到 44px（见 globals.css 的 @media (hover: none)），
 * 桌面鼠标环境不受影响，因此可以直接内联进每个交互件。
 */
const TOUCH = 'touch-target'

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
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink/40',
        'disabled:cursor-not-allowed',
        TOUCH,
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
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-strong ' +
  'placeholder:text-faint focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 ' +
  'disabled:bg-subtle disabled:text-faint'

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  // h-10 sm:h-9：手机上 40px 才够手指点，桌面上维持原来紧凑的 36px
  return <input {...rest} className={cn(FIELD_BASE, 'h-10 sm:h-9', className)} />
}

export function TextArea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(FIELD_BASE, 'min-h-[80px] leading-relaxed', className)} />
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(FIELD_BASE, 'h-10 pr-8 sm:h-9', className)}>
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
      {/* 标签允许换行：长中文标签在 375px 上不该被 whitespace-nowrap 顶出容器 */}
      <span className="flex flex-wrap items-center gap-1 text-xs font-medium text-body">
        {label}
        {required ? <span className="text-rose-500">*</span> : null}
      </span>
      {children}
      {hint ? <span className="block text-xs text-faint">{hint}</span> : null}
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
        'h-4 w-4 cursor-pointer rounded border-line-strong text-brand',
        'focus:ring-2 focus:ring-brand/30',
        TOUCH,
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
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink/40',
        TOUCH,
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        checked ? 'bg-brand' : 'bg-raised',
      )}
    >
      {/* 开关滑块是「画在固定色上的图形」，与 bg-white 的语义无关，故保留白色 */}
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
        'rounded-xl border border-line bg-canvas shadow-sm shadow-line',
        className,
      )}
    >
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-strong">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
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

/* 状态色（emerald/amber/rose/sky/violet）是固定色对，暗色下深浅关系依然成立，故整体保留。
   只有 slate 这一档本质是中性色，改用 token 以便跟随主题。 */
const BADGE_TONES: Record<BadgeTone, string> = {
  slate: 'bg-subtle text-body border-line',
  indigo: 'bg-brand-soft text-brand-ink border-brand-ink/30',
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
    indigo: 'bg-brand',
    emerald: 'bg-emerald-500',
    rose: 'bg-rose-500',
    amber: 'bg-amber-500',
  }
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-subtle', className)}>
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-subtle/60 px-4 py-10 text-center">
      <p className="text-sm font-medium text-body">{title}</p>
      {description ? <p className="text-xs text-faint">{description}</p> : null}
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
    <div className="rounded-lg border border-brand-ink/30 bg-brand-soft/70 px-3 py-2 text-xs leading-relaxed text-brand-ink">
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
      <p className="text-xs text-muted">
        共 {total} 条，当前 {from}-{to} 条 · 第 {page}/{totalPages} 页
      </p>
      <div className="flex flex-wrap items-center gap-2">
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
    /* 手机上贴底弹出的抽屉（items-end + 无外边距），桌面恢复居中卡片（sm:items-center + sm:p-4）。
       高度一律用 dvh：移动浏览器地址栏收起/展开会改变可视高度，vh 会算大并裁掉底部按钮。 */
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div
        className={cn(
          'flex max-h-[92dvh] w-full flex-col border border-line bg-canvas shadow-xl',
          'rounded-t-2xl sm:max-h-[85dvh] sm:rounded-2xl',
          widthClass,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-strong">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className={cn(
              '-mr-1 shrink-0 rounded-md px-2 py-1 text-lg leading-none text-muted',
              'hover:bg-subtle hover:text-body',
              TOUCH,
            )}
          >
            ×
          </button>
        </header>
        {/* 头部/底部固定，只有内容区滚动；这样底部按钮在手机上始终可见 */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 pb-safe sm:px-5">
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
    /* 与 Modal 统一：手机上是全屏宽度的底部抽屉，桌面是居中卡片。
       原先的「右侧固定侧栏」在 375px 上只能靠横向滚动，因此不再沿用右对齐布局。 */
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <aside
        className={cn(
          'flex max-h-[92dvh] w-full flex-col border border-line bg-canvas shadow-2xl',
          'rounded-t-2xl sm:max-h-[85dvh] sm:rounded-2xl',
          widthClass,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-strong">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className={cn(
              '-mr-1 shrink-0 rounded-md px-2 py-1 text-lg leading-none text-muted',
              'hover:bg-subtle hover:text-body',
              TOUCH,
            )}
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 pb-safe sm:px-5">
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
  info: 'border-brand-ink/30 bg-brand-soft text-brand-ink',
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
    /* 窄屏靠横向滚动兜底，而不是让单元格把整页撑破。
       min-width 只作用在 table 上（配合外层 overflow-x-auto），不会给页面制造横向滚动。 */
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
        // 表头不设 whitespace-nowrap：中文表头在窄屏允许折行，比强行撑宽表格更好
        'border-b border-line bg-subtle/80 px-2 py-2 text-left text-xs font-semibold text-muted sm:px-3 sm:py-2.5',
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
    <td
      className={cn(
        'border-b border-line px-2 py-2 align-middle text-body sm:px-3 sm:py-2.5',
        className,
      )}
    >
      {children}
    </td>
  )
}
