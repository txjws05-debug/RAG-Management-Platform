'use client'

/** 知识单元台账表格（按钮级鉴权：无权限码的按钮不渲染）。 */
import {
  Badge,
  Button,
  EmptyState,
  Pagination,
  Spinner,
  Switch,
  TableWrap,
  Td,
  Th,
  cn,
  formatDateTime,
  formatFileSize,
  formatNumber,
} from '@/components/ui/kit'
import type { DocumentRow, DocumentStatus } from './types'

const STATUS_META: Record<DocumentStatus, { label: string; tone: 'slate' | 'indigo' | 'emerald' | 'rose' | 'amber' }> = {
  pending: { label: '待处理', tone: 'slate' },
  parsing: { label: '解析中', tone: 'amber' },
  ready: { label: '已就绪', tone: 'emerald' },
  failed: { label: '解析失败', tone: 'rose' },
}

export interface DocumentTableProps {
  items: DocumentRow[]
  total: number
  page: number
  pageSize: number
  isLoading: boolean
  error?: string | null
  onPageChange: (page: number) => void
  /** 行级操作进行中的文档 id 集合，用于禁用按钮 */
  busyIds?: number[]
  can: (code: string) => boolean
  onViewChunks: (doc: DocumentRow) => void
  onGrant: (doc: DocumentRow) => void
  onReindex: (doc: DocumentRow) => void
  onToggleEnabled: (doc: DocumentRow, enabled: boolean) => void
  onDelete: (doc: DocumentRow) => void
}

export default function DocumentTable({
  items,
  total,
  page,
  pageSize,
  isLoading,
  error,
  onPageChange,
  busyIds = [],
  can,
  onViewChunks,
  onGrant,
  onReindex,
  onToggleEnabled,
  onDelete,
}: DocumentTableProps) {
  const canManage = can('knowledge:manage')
  const canGrant = can('knowledge:grant')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
        <Spinner /> 正在加载知识台账…
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
        {error}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="没有匹配的知识单元"
        description="可调整筛选条件，或通过右上角「上传导入」新增文档"
      />
    )
  }

  return (
    <>
      <TableWrap minWidthClass="min-w-[1080px]">
        <thead>
          <tr>
            <Th className="w-[92px]">编号</Th>
            <Th>标题</Th>
            <Th className="w-[70px]">格式</Th>
            <Th className="w-[110px]">分类</Th>
            <Th className="w-[90px]">解析状态</Th>
            <Th className="w-[220px]">数据权限</Th>
            <Th className="w-[90px]">切片数</Th>
            <Th className="w-[88px]">大小</Th>
            <Th className="w-[140px]">更新时间</Th>
            <Th className="w-[80px]">启用</Th>
            <Th className="w-[280px]">操作</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((doc) => {
            const busy = busyIds.includes(doc.id)
            const statusMeta = STATUS_META[doc.status] ?? { label: doc.status, tone: 'slate' as const }
            const noGrant = !doc.grant_summary || doc.grant_summary.includes('无任何权限')
            return (
              <tr key={doc.id} className={cn('hover:bg-slate-50/70', !doc.enabled && 'opacity-60')}>
                <Td className="font-mono text-xs text-slate-500">{doc.code}</Td>
                <Td>
                  <div className="max-w-[320px]">
                    <p className="truncate font-medium text-slate-800" title={doc.title}>
                      {doc.title}
                    </p>
                    {doc.status === 'failed' && doc.error_message ? (
                      <p className="mt-0.5 truncate text-xs text-rose-600" title={doc.error_message}>
                        {doc.error_message}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-slate-400">
                        {formatNumber(doc.char_count)} 字 · 创建于 {formatDateTime(doc.created_at)}
                      </p>
                    )}
                  </div>
                </Td>
                <Td>
                  <Badge tone="sky">{doc.file_type.toUpperCase()}</Badge>
                </Td>
                <Td className="text-xs text-slate-600">{doc.category || '未分类'}</Td>
                <Td>
                  <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                </Td>
                <Td>
                  {noGrant ? (
                    <Badge tone="rose" title="仅管理员可见，请配置数据权限">
                      无权限（仅管理员）
                    </Badge>
                  ) : (
                    <span
                      className="line-clamp-2 block text-xs leading-relaxed text-slate-600"
                      title={doc.grant_summary}
                    >
                      {doc.grant_summary}
                    </span>
                  )}
                </Td>
                <Td className="text-xs text-slate-600">{formatNumber(doc.chunk_count)}</Td>
                <Td className="text-xs text-slate-500">{formatFileSize(doc.file_size)}</Td>
                <Td className="text-xs text-slate-500">{formatDateTime(doc.updated_at)}</Td>
                <Td>
                  {canManage ? (
                    <Switch
                      checked={doc.enabled}
                      disabled={busy}
                      title={doc.enabled ? '点击停用' : '点击启用'}
                      onChange={(next) => onToggleEnabled(doc, next)}
                    />
                  ) : (
                    <Badge tone={doc.enabled ? 'emerald' : 'slate'}>
                      {doc.enabled ? '已启用' : '已停用'}
                    </Badge>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button size="sm" onClick={() => onViewChunks(doc)}>
                      查看切片
                    </Button>
                    {canGrant ? (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onGrant(doc)}>
                        权限配置
                      </Button>
                    ) : null}
                    {canManage ? (
                      <>
                        <Button size="sm" disabled={busy} onClick={() => onReindex(doc)}>
                          重新索引
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => onDelete(doc)}>
                          删除
                        </Button>
                      </>
                    ) : null}
                  </div>
                </Td>
              </tr>
            )
          })}
        </tbody>
      </TableWrap>
      <Pagination page={page} pageSize={pageSize} total={total} onChange={onPageChange} />
    </>
  )
}
