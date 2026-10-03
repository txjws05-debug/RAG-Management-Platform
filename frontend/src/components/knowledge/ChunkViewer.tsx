'use client'

/** 切片查看抽屉：分页展示知识单元切片正文。 */
import { useState } from 'react'
import useSWR from 'swr'
import { api } from '@/lib/api'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorNote,
  Pagination,
  Spinner,
  formatNumber,
} from '@/components/ui/kit'
import type { ChunkRow, DocumentRow, Paged } from './types'

interface Props {
  open: boolean
  document: DocumentRow | null
  onClose: () => void
}

export default function ChunkViewer({ open, document, onClose }: Props) {
  const [page, setPage] = useState(1)
  const pageSize = 10

  const { data, error, isLoading } = useSWR(
    open && document ? ['/knowledge/documents/chunks', document.id, page] : null,
    () =>
      api.get<Paged<ChunkRow>>(`/knowledge/documents/${document?.id}/chunks`, {
        page,
        page_size: pageSize,
      }),
    { keepPreviousData: true },
  )

  const close = () => {
    setPage(1)
    onClose()
  }

  return (
    <Drawer
      open={open}
      widthClass="max-w-3xl"
      title={`切片查看${document ? ` · ${document.title}` : ''}`}
      description={document ? `${document.code} · 共 ${document.chunk_count} 个切片` : undefined}
      onClose={close}
      footer={
        <Button onClick={close}>关闭</Button>
      }
    >
      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted">
            <Spinner /> 正在加载切片…
          </div>
        ) : null}
        {error ? <ErrorNote>切片加载失败：{(error as Error).message}</ErrorNote> : null}

        {data && data.items.length === 0 && !isLoading ? (
          <EmptyState
            title="暂无切片"
            description="文档可能仍在解析中，或解析失败。可回到台账点击「重新索引」。"
          />
        ) : null}

        {(data?.items ?? []).map((chunk) => (
          <article key={chunk.id} className="rounded-lg border border-line bg-canvas">
            {/* 窄屏下标题与字数各占一行：flex-wrap 让它们自然折行而不是挤在一起 */}
            <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge tone="indigo">#{chunk.ordinal}</Badge>
                {/* min-w-0 + break-all：切片 ID 是长数字串，不折行会把头部顶宽 */}
                <span className="min-w-0 break-all text-xs text-faint">切片 ID {chunk.id}</span>
              </div>
              <span className="shrink-0 text-xs text-faint">{formatNumber(chunk.char_count)} 字</span>
            </header>
            <pre className="max-h-72 overflow-y-auto px-3 py-2.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-body">
              {chunk.content}
            </pre>
          </article>
        ))}

        {data && data.total > 0 ? (
          <Pagination
            page={data.page}
            pageSize={data.page_size}
            total={data.total}
            onChange={setPage}
          />
        ) : null}
      </div>
    </Drawer>
  )
}
