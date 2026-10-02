'use client';

/**
 * 权限缺失安全提示气泡。
 *
 * 当后端 SSE 下发 `restricted` 事件（检索命中无权查阅的制度文档）时，
 * 在该条回答内以醒目的黄/橙色警示样式展示，明确告知"内容被拦截但未泄露"。
 */
import { Icon } from '@/components/Icons';
import { cn } from '@/components/primitives';

export interface RestrictedNoticeProps {
  /** 后端下发的提示文案；缺省时使用兜底文案。 */
  message?: string;
  blockedDocumentCount?: number;
  blockedChunkCount?: number;
  className?: string;
  /** 紧凑模式（用于历史消息回放）。 */
  compact?: boolean;
}

const DEFAULT_MESSAGE = '检测到相关制度文档，但您当前所属部门/角色无权查阅该内容。';

export default function RestrictedNotice({
  message,
  blockedDocumentCount,
  blockedChunkCount,
  className,
  compact = false,
}: RestrictedNoticeProps) {
  const text = message?.trim() ? message : DEFAULT_MESSAGE;
  const hasCounts =
    (blockedDocumentCount !== undefined && blockedDocumentCount > 0) ||
    (blockedChunkCount !== undefined && blockedChunkCount > 0);

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50',
        compact ? 'px-2.5 py-2' : 'px-3 py-2.5',
        className,
      )}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
        <Icon name="shield" className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-amber-800">
          权限受限提示
          {hasCounts ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
              已拦截 {blockedDocumentCount ?? 0} 篇文档 / {blockedChunkCount ?? 0} 个切片
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-amber-700">{text}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-amber-600/80">
          出于数据安全考虑，受权限保护的原文不会出现在回答与引用中。如需查阅，请联系系统管理员申请对应部门或角色的数据权限。
        </p>
      </div>
    </div>
  );
}
