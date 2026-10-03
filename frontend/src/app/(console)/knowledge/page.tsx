'use client'

/** 知识维护与导入中心：台账筛选、上传导入、四维数据权限、切片查看、重新索引。 */
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { api, errorMessage, type QueryParams } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Modal,
  Select,
  cn,
  formatNumber,
  useDebounced,
  useNotice,
} from '@/components/ui/kit'
import DocumentTable from '@/components/knowledge/DocumentTable'
import UploadDrawer from '@/components/knowledge/UploadDrawer'
import GrantDialog from '@/components/knowledge/GrantDialog'
import ChunkViewer from '@/components/knowledge/ChunkViewer'
import type { CategoryCount, DocumentRow, Paged } from '@/components/knowledge/types'

const PAGE_SIZE = 20
const FILE_TYPES = ['pdf', 'docx', 'doc', 'md', 'txt', 'xlsx', 'csv', 'pptx']
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待处理' },
  { value: 'parsing', label: '解析中' },
  { value: 'ready', label: '已就绪' },
  { value: 'failed', label: '解析失败' },
]

interface ReindexResult {
  id: number
  status: string
  chunk_count: number
  error_message: string | null
}

export default function KnowledgePage() {
  const { can } = useAuth()
  const { push, node: noticeNode } = useNotice()

  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState('')
  const [fileType, setFileType] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const debouncedKeyword = useDebounced(keyword, 400)

  const [uploadOpen, setUploadOpen] = useState(false)
  const [grantDoc, setGrantDoc] = useState<DocumentRow | null>(null)
  const [chunkDoc, setChunkDoc] = useState<DocumentRow | null>(null)
  const [editDoc, setEditDoc] = useState<DocumentRow | null>(null)
  const [deleteDoc, setDeleteDoc] = useState<DocumentRow | null>(null)
  const [busyIds, setBusyIds] = useState<number[]>([])
  const [actionError, setActionError] = useState<string | null>(null)

  const params = useMemo<QueryParams>(
    () => ({
      keyword: debouncedKeyword.trim() || undefined,
      category: category || undefined,
      file_type: fileType || undefined,
      status: status || undefined,
      page,
      page_size: PAGE_SIZE,
    }),
    [debouncedKeyword, category, fileType, status, page],
  )

  const { data, error, isLoading, mutate } = useSWR(
    ['/knowledge/documents', params],
    ([, query]: [string, QueryParams]) =>
      api.get<Paged<DocumentRow>>('/knowledge/documents', query),
    { keepPreviousData: true },
  )

  const { data: categories, mutate: mutateCategories } = useSWR('/knowledge/categories', () =>
    api.get<CategoryCount[]>('/knowledge/categories'),
  )

  const withBusy = async (id: number, fn: () => Promise<void>) => {
    setBusyIds((prev) => [...prev, id])
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(errorMessage(err, '操作失败'))
    } finally {
      setBusyIds((prev) => prev.filter((x) => x !== id))
    }
  }

  const refreshAll = () => {
    void mutate()
    void mutateCategories()
  }

  const handleReindex = (doc: DocumentRow) =>
    withBusy(doc.id, async () => {
      const res = await api.post<ReindexResult>(`/knowledge/documents/${doc.id}/reindex`)
      push(
        res.status === 'failed' ? 'error' : 'success',
        res.status === 'failed'
          ? `「${doc.title}」重新索引失败：${res.error_message ?? '未知原因'}`
          : `「${doc.title}」重新索引完成，共 ${res.chunk_count} 个切片`,
      )
      refreshAll()
    })

  const handleToggleEnabled = (doc: DocumentRow, enabled: boolean) =>
    withBusy(doc.id, async () => {
      await api.put(`/knowledge/documents/${doc.id}`, { enabled })
      push('success', `「${doc.title}」已${enabled ? '启用' : '停用'}`)
      refreshAll()
    })

  const handleDelete = async () => {
    if (!deleteDoc) return
    const doc = deleteDoc
    await withBusy(doc.id, async () => {
      await api.delete(`/knowledge/documents/${doc.id}`)
      push('success', `「${doc.title}」已删除`)
      setDeleteDoc(null)
      refreshAll()
    })
  }

  const resetFilters = () => {
    setKeyword('')
    setCategory('')
    setFileType('')
    setStatus('')
    setPage(1)
  }

  const totalChunks = (data?.items ?? []).reduce((sum, d) => sum + d.chunk_count, 0)

  const overview = [
    { label: '知识单元总数', value: formatNumber(data?.total ?? 0), color: 'text-brand-ink' },
    {
      label: '本页已就绪',
      value: formatNumber((data?.items ?? []).filter((d) => d.status === 'ready').length),
      color: 'text-emerald-600',
    },
    {
      label: '本页解析中 / 待处理',
      value: formatNumber(
        (data?.items ?? []).filter((d) => d.status === 'parsing' || d.status === 'pending').length,
      ),
      color: 'text-amber-600',
    },
    { label: '本页切片合计', value: formatNumber(totalChunks), color: 'text-sky-600' },
  ]

  return (
    <div className="space-y-3 sm:space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div>
          <h1 className="text-base font-semibold text-strong sm:text-lg">知识维护与导入中心</h1>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            统一管理知识单元台账：上传导入、解析状态跟踪、切片查看与四维数据权限分配。
          </p>
        </div>
        {/* 窄屏按钮铺满整行，避免两个按钮被挤成细条 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button className="flex-1 sm:flex-none" onClick={refreshAll}>
            刷新
          </Button>
          {can('knowledge:upload') || can('knowledge:manage') ? (
            <Button
              variant="primary"
              className="flex-1 sm:flex-none"
              onClick={() => setUploadOpen(true)}
            >
              上传 / 批量导入
            </Button>
          ) : null}
        </div>
      </header>

      {noticeNode}
      {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}

      {/* 概览：手机上两列比一列更省纵向空间 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {overview.map((item) => (
          <div
            key={item.label}
            className="rounded-xl border border-line bg-canvas px-3 py-3 shadow-sm sm:px-4"
          >
            <p className="text-xs text-muted">{item.label}</p>
            <p className={cn('mt-1 text-lg font-semibold sm:text-xl', item.color)}>{item.value}</p>
          </div>
        ))}
      </div>

      <Card
        title="知识单元台账"
        description="支持按关键词、分类、格式与解析状态筛选；权限标签来自四维数据权限配置结果"
        bodyClassName="space-y-3"
      >
        {/* 筛选：手机单列堆叠，下拉与按钮占满宽度便于点按 */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value)
              setPage(1)
            }}
            placeholder="搜索标题或编号"
            className="w-full"
          />
          <Select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value)
              setPage(1)
            }}
            className="w-full"
          >
            <option value="">全部分类</option>
            {(categories ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}（{c.count}）
              </option>
            ))}
          </Select>
          <Select
            value={fileType}
            onChange={(e) => {
              setFileType(e.target.value)
              setPage(1)
            }}
            className="w-full"
          >
            <option value="">全部格式</option>
            {FILE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.toUpperCase()}
              </option>
            ))}
          </Select>
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
            className="w-full"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Button className="w-full" onClick={resetFilters}>
            重置筛选
          </Button>
        </div>

        {/* 分类快捷筛选 */}
        {(categories ?? []).length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-faint">分类快捷筛选：</span>
            <button
              type="button"
              onClick={() => {
                setCategory('')
                setPage(1)
              }}
              className={cn(
                'min-h-11 sm:min-h-0 rounded-md border px-2 py-0.5 text-xs',
                category === ''
                  ? 'border-brand-ink/30 bg-brand-soft text-brand-ink'
                  : 'border-line bg-canvas text-body hover:bg-subtle',
              )}
            >
              全部
            </button>
            {(categories ?? []).map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => {
                  setCategory(c.name)
                  setPage(1)
                }}
                className={cn(
                  'min-h-11 sm:min-h-0 rounded-md border px-2 py-0.5 text-xs',
                  category === c.name
                    ? 'border-brand-ink/30 bg-brand-soft text-brand-ink'
                    : 'border-line bg-canvas text-body hover:bg-subtle',
                )}
              >
                {c.name}
                <span className="ml-1 text-faint">{c.count}</span>
              </button>
            ))}
          </div>
        ) : null}

        <DocumentTable
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          pageSize={data?.page_size ?? PAGE_SIZE}
          isLoading={isLoading && !data}
          error={error ? errorMessage(error, '知识台账加载失败') : null}
          onPageChange={setPage}
          busyIds={busyIds}
          can={can}
          onViewChunks={setChunkDoc}
          onGrant={setGrantDoc}
          onReindex={handleReindex}
          onToggleEnabled={handleToggleEnabled}
          onDelete={setDeleteDoc}
        />
      </Card>

      {!can('knowledge:grant') ? (
        <p className="text-xs text-faint">
          当前账号没有「knowledge:grant」权限码，因此不显示权限配置按钮。
        </p>
      ) : null}

      <UploadDrawer
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={refreshAll}
        categories={categories ?? []}
      />

      <GrantDialog
        open={grantDoc !== null}
        documentId={grantDoc?.id ?? null}
        documentTitle={grantDoc?.title}
        onClose={() => setGrantDoc(null)}
        onSaved={(res) => {
          push('success', `权限已更新：${res.grant_summary}`)
          refreshAll()
        }}
      />

      <ChunkViewer open={chunkDoc !== null} document={chunkDoc} onClose={() => setChunkDoc(null)} />

      <EditDocumentModal
        doc={editDoc}
        onClose={() => setEditDoc(null)}
        onSaved={() => {
          push('success', '知识单元信息已更新')
          setEditDoc(null)
          refreshAll()
        }}
      />

      <Modal
        open={deleteDoc !== null}
        title="删除知识单元"
        description="删除后原始文件、切片与权限配置将一并清除，且不可恢复。"
        widthClass="max-w-md"
        onClose={() => setDeleteDoc(null)}
        footer={
          <>
            <Button onClick={() => setDeleteDoc(null)}>取消</Button>
            <Button
              variant="primary"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={handleDelete}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-body">
          确定要删除知识单元
          <span className="mx-1 font-medium text-strong">「{deleteDoc?.title}」</span>
          吗？
        </p>
        {deleteDoc ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone="sky">{deleteDoc.file_type.toUpperCase()}</Badge>
            <Badge tone="slate">{deleteDoc.category || '未分类'}</Badge>
            <Badge tone="indigo">{deleteDoc.chunk_count} 切片</Badge>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 编辑弹窗（标题 / 分类 / 启用）                                       */
/* ------------------------------------------------------------------ */

function EditDocumentModal({
  doc,
  onClose,
  onSaved,
}: {
  doc: DocumentRow | null
  onClose: () => void
  onSaved: () => void
}) {
  return (
    <Modal
      open={doc !== null}
      widthClass="max-w-md"
      title="编辑知识单元"
      description={doc ? `${doc.code} · ${doc.file_type.toUpperCase()}` : undefined}
      onClose={onClose}
    >
      {/* 用 key 让表单在切换文档时重新挂载，天然获得初值 */}
      {doc ? <EditDocumentForm key={doc.id} doc={doc} onClose={onClose} onSaved={onSaved} /> : null}
    </Modal>
  )
}

function EditDocumentForm({
  doc,
  onClose,
  onSaved,
}: {
  doc: DocumentRow
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(doc.title)
  const [category, setCategory] = useState(doc.category)
  const [enabled, setEnabled] = useState(doc.enabled)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!title.trim()) {
      setError('标题不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.put(`/knowledge/documents/${doc.id}`, {
        title: title.trim(),
        category: category.trim() || '未分类',
        enabled,
      })
      onSaved()
    } catch (err) {
      setError(errorMessage(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Field label="标题" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="分类">
        <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="未分类" />
      </Field>
      <Field label="启用状态" hint="停用后该知识单元不参与检索问答">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-body min-h-11 sm:min-h-0">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line-strong text-indigo-600"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用
        </label>
      </Field>
      {/* 底部按钮：窄屏铺满，便于单手点按 */}
      <div className="flex flex-col-reverse items-stretch gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
        <Button onClick={onClose} disabled={saving}>
          取消
        </Button>
        <Button variant="primary" onClick={save} loading={saving}>
          保存
        </Button>
      </div>
    </div>
  )
}
