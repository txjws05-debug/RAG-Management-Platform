'use client';

/**
 * 轻量 Toast 通知：ToastProvider + useToast()。
 * 固定右上角堆叠，3.2 秒自动消失，支持成功 / 失败 / 提示三种语气。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Icon, type IconName } from '@/components/Icons';
import { cn } from '@/components/primitives';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  push: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/* 中性/品牌一档走 token；状态色保持固定色对（它们是「深字浅底」的成对语义，暗色下仍成立）。 */
const TONE_STYLES: Record<ToastTone, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  info: 'border-brand-ink/30 bg-brand-soft text-brand-ink',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
};

const TONE_ICONS: Record<ToastTone, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'sparkles',
  warning: 'alert',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seedRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      seedRef.current += 1;
      const id = seedRef.current;
      setItems((prev) => [...prev.slice(-4), { id, tone, message }]);
      const timer = setTimeout(() => remove(id), 3200);
      timersRef.current.set(id, timer);
    },
    [remove],
  );

  // 卸载时清理所有定时器，避免内存泄漏
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (message: string) => push(message, 'success'),
      error: (message: string) => push(message, 'error'),
      info: (message: string) => push(message, 'info'),
      warning: (message: string) => push(message, 'warning'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* 手机上留出左右各 1rem，避免固定 320px 宽在 375px 屏上贴边甚至溢出 */}
      <div className="pointer-events-none fixed top-4 right-4 left-4 z-[100] flex flex-col gap-2 sm:left-auto sm:w-80">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs shadow-sm',
              TONE_STYLES[item.tone],
            )}
          >
            <Icon name={TONE_ICONS[item.tone]} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 leading-relaxed break-words">{item.message}</span>
            <button
              type="button"
              onClick={() => remove(item.id)}
              aria-label="关闭提示"
              className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 min-h-11 sm:min-h-0"
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 读取 Toast 方法；必须在 <ToastProvider> 内部使用。 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
