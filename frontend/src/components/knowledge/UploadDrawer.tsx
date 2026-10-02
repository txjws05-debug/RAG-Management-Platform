'use client'

/**
 * 上传与批量拖拽导入抽屉。
 * - 点击选择单文件（/knowledge/documents/upload，字段 file）
 * - 拖拽多文件 / 文件夹（递归读取目录，/knowledge/documents/batch-upload，字段 files）
 * - 逐条状态 + 进度条；上传后轮询台账直到新文档解析为 ready / failed
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  InfoNote,
  ProgressBar,
  Select,
  Spinner,
  cn,
  errText,
  formatFileSize,
  useNotice,
} from '@/components/ui/kit'
import type {
  BatchUploadResult,
  CategoryCount,
  DocumentRow,
  Paged,
  UploadResult,
} from './types'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 与后端 MAX_UPLOAD_MB 默认值保持一致，做前置提示
const POLL_INTERVAL_MS = 2000
const POLL_MAX_TIMES = 60

const SUPPORTED_EXT = ['pdf', 'docx', 'doc', 'md', 'markdown', 'txt', 'xlsx', 'xls', 'pptx', 'ppt', 'csv']

type QueueStatus = 'queued' | 'uploading' | 'accepted' | 'parsing' | 'ready' | 'failed'

interface QueueItem {
  key: string
  file: File
  name: string
  size: number
  status: QueueStatus
  message?: string
  documentId?: number
  chunkCount?: number
  charCount?: number
}

interface Props {
  open: boolean
  onClose: () => void
  /** 新文档解析完成（或批量导入受理）时回调，用于刷新台账 */
  onUploaded?: () => void
  categories?: CategoryCount[]
}

/* ---------------- 目录递归读取 ---------------- */

interface DroppedEntry {
  file: File
  path: string
}

interface FsEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void
  createReader?: () => {
    readEntries: (cb: (entries: FsEntryLike[]) => void, err?: (e: unknown) => void) => void
  }
}

function readDirectory(reader: NonNullable<ReturnType<NonNullable<FsEntryLike['createReader']>>>): Promise<FsEntryLike[]> {
  return new Promise((resolve, reject) => {
    const acc: FsEntryLike[] = []
    const step = () => {
      reader.readEntries((entries) => {
        if (!entries.length) {
          resolve(acc)
          return
        }
        acc.push(...entries)
        step() // readEntries 每次只返回一批，需要反复读取直到为空
      }, reject)
    }
    step()
  })
}

async function walkEntry(entry: FsEntryLike, prefix: string, out: DroppedEntry[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      entry.file?.(
        (f) => resolve(f),
        () => resolve(null),
      )
    })
    if (file) out.push({ file, path: prefix ? `${prefix}/${file.name}` : file.name })
    return
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    const children = await readDirectory(reader)
    for (const child of children) {
      await walkEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name, out)
    }
  }
}

/** 优先用 DataTransferItem.webkitGetAsEntry() 递归读取文件夹，降级用 dataTransfer.files。 */
async function collectDropped(dt: DataTransfer): Promise<DroppedEntry[]> {
  const out: DroppedEntry[] = []
  const items = dt.items ? Array.from(dt.items) : []
  const entries: FsEntryLike[] = []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const anyItem = item as DataTransferItem & {
      webkitGetAsEntry?: () => FsEntryLike | null
      getAsFileSystemHandle?: () => Promise<unknown>
    }
    const entry = anyItem.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  if (entries.length > 0) {
    for (const entry of entries) {
      try {
        await walkEntry(entry, '', out)
      } catch {
        /* 单个条目失败不影响其它文件 */
      }
    }
    if (out.length > 0) return out
  }
  return Array.from(dt.files ?? []).map((f) => ({ file: f, path: f.name }))
}

/* ---------------- 状态展示 ---------------- */

const STATUS_META: Record<QueueStatus, { label: string; tone: 'slate' | 'indigo' | 'emerald' | 'rose' | 'amber'; progress: number }> = {
  queued: { label: '待上传', tone: 'slate', progress: 0 },
  uploading: { label: '上传中', tone: 'indigo', progress: 35 },
  accepted: { label: '已受理（待解析）', tone: 'amber', progress: 55 },
  parsing: { label: '解析中', tone: 'indigo', progress: 80 },
  ready: { label: '解析完成', tone: 'emerald', progress: 100 },
  failed: { label: '失败', tone: 'rose', progress: 100 },
}

function extOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

/** 后端 UploadResult 只返回文件名主干（无扩展名），用扩展名把受理结果对回队列条目。 */
function matchPending(pending: QueueItem[], fileType: string): QueueItem | undefined {
  const idx = pending.findIndex((it) => extOf(it.file.name) === fileType.toLowerCase())
  if (idx >= 0) return pending.splice(idx, 1)[0]
  return pending.shift()
}

export default function UploadDrawer({ open, onClose, onUploaded, categories = [] }: Props) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [category, setCategory] = useState('未分类')
  const [customCategory, setCustomCategory] = useState('')
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const pollTokenRef = useRef(0)
  const itemsRef = useRef<QueueItem[]>([])
  const { push, node: noticeNode } = useNotice(6000)

  // 保持最新队列引用，供上传完成后同步读取（避免在 setState 更新函数里做副作用）
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const effectiveCategory = (customCategory.trim() || category || '未分类').trim()

  useEffect(() => {
    if (!open) {
      // 关闭时终止轮询
      pollTokenRef.current += 1
      setPolling(false)
    }
  }, [open])

  useEffect(() => {
    return () => {
      pollTokenRef.current += 1
    }
  }, [])

  const patch = useCallback((keys: string[], next: Partial<QueueItem>) => {
    setItems((prev) => {
      const updated = prev.map((it) => (keys.includes(it.key) ? { ...it, ...next } : it))
      itemsRef.current = updated
      return updated
    })
  }, [])

  const addFiles = useCallback(
    (drafts: DroppedEntry[]) => {
      if (drafts.length === 0) {
        push('error', '未读取到任何文件，请确认拖入的是文件或文件夹')
        return
      }
      const rejected: string[] = []
      const accepted: QueueItem[] = []
      for (const draft of drafts) {
        const ext = extOf(draft.file.name)
        if (!SUPPORTED_EXT.includes(ext)) {
          rejected.push(`${draft.path}（不支持的格式 .${ext || '未知'}）`)
          continue
        }
        if (draft.file.size === 0) {
          rejected.push(`${draft.path}（空文件）`)
          continue
        }
        if (draft.file.size > MAX_UPLOAD_BYTES) {
          rejected.push(`${draft.path}（超过 50MB）`)
          continue
        }
        accepted.push({
          key: `${draft.path}-${draft.file.size}-${draft.file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          file: draft.file,
          name: draft.path,
          size: draft.file.size,
          status: 'queued',
        })
      }
      setItems((prev) => {
        const updated = [...prev, ...accepted]
        itemsRef.current = updated
        return updated
      })
      setError(rejected.length > 0 ? `已过滤 ${rejected.length} 个文件：${rejected.slice(0, 3).join('、')}${rejected.length > 3 ? ' 等' : ''}` : null)
    },
    [push],
  )

  /* -------- 拖拽 -------- */
  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const drafts = await collectDropped(e.dataTransfer)
    addFiles(drafts)
  }

  /* -------- 上传 -------- */
  const doUpload = async () => {
    const pending = items.filter((it) => it.status === 'queued')
    if (pending.length === 0) {
      push('error', '没有待上传的文件')
      return
    }
    setUploading(true)
    setError(null)
    const token = ++pollTokenRef.current

    const pendingKeys = pending.map((it) => it.key)
    patch(pendingKeys, { status: 'uploading', message: undefined })

    try {
      if (pending.length === 1) {
        const target = pending[0]
        const fd = new FormData()
        fd.append('file', target.file, target.file.name)
        fd.append('category', effectiveCategory)
        const res = await api.upload<UploadResult>('/knowledge/documents/upload', fd)
        patch([target.key], {
          status: 'accepted',
          documentId: res.id,
          message: res.message || '已受理，正在后台解析',
        })
        push('success', `「${target.name}」已受理，正在后台解析与向量化`)
      } else {
        const fd = new FormData()
        for (const it of pending) fd.append('files', it.file, it.file.name)
        fd.append('category', effectiveCategory)
        const res = await api.upload<BatchUploadResult>('/knowledge/documents/batch-upload', fd)

        const remaining = [...pending]
        for (const accepted of res.accepted) {
          const hit = matchPending(remaining, accepted.file_type)
          if (hit) {
            patch([hit.key], {
              status: 'accepted',
              documentId: accepted.id,
              message: accepted.message || '已受理',
            })
          }
        }
        for (const failed of res.failed) {
          const hit =
            remaining.find((it) => it.file.name === failed.filename) ??
            remaining.shift()
          if (hit) patch([hit.key], { status: 'failed', message: failed.message })
        }
        push(
          res.failed_count > 0 ? 'info' : 'success',
          `批量导入：受理 ${res.accepted_count} 个，失败 ${res.failed_count} 个`,
        )
      }

      onUploaded?.()
      const acceptedItems = itemsRef.current.filter(
        (it) => pendingKeys.includes(it.key) && it.documentId !== undefined,
      )
      if (acceptedItems.length > 0 && token === pollTokenRef.current) {
        setPolling(true)
        void pollParseStatus(acceptedItems, token)
      }
    } catch (err) {
      patch(pendingKeys, { status: 'failed', message: errText(err, '上传失败') })
      setError(errText(err, '上传失败'))
    } finally {
      setUploading(false)
    }
  }

  /** 轮询台账，直到新文档解析为 ready / failed。 */
  const pollParseStatus = async (accepted: QueueItem[], token: number) => {
    const unwatched = new Set(accepted.map((it) => it.documentId as number))
    let round = 0
    while (token === pollTokenRef.current && unwatched.size > 0 && round < POLL_MAX_TIMES) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      if (token !== pollTokenRef.current) return
      round += 1
      try {
        const page = await api.get<Paged<DocumentRow>>('/knowledge/documents', {
          page: 1,
          page_size: 50,
        })
        for (const doc of page.items) {
          if (!unwatched.has(doc.id)) continue
          if (doc.status === 'ready' || doc.status === 'failed') {
            unwatched.delete(doc.id)
            const key = accepted.find((it) => it.documentId === doc.id)?.key
            if (key) {
              patch([key], {
                status: doc.status === 'ready' ? 'ready' : 'failed',
                chunkCount: doc.chunk_count,
                charCount: doc.char_count,
                message:
                  doc.status === 'ready'
                    ? `解析完成，共 ${doc.chunk_count} 个切片 / ${doc.char_count} 字`
                    : doc.error_message || '解析失败',
              })
            }
          } else {
            const key = accepted.find((it) => it.documentId === doc.id)?.key
            if (key) patch([key], { status: 'parsing', message: '正在切片与向量化…' })
          }
        }
        onUploaded?.()
      } catch {
        /* 轮询失败不打断流程，下一轮重试 */
      }
    }
    if (token === pollTokenRef.current) {
      setPolling(false)
      if (unwatched.size > 0) {
        const keys = accepted
          .filter((it) => it.documentId !== undefined && unwatched.has(it.documentId))
          .map((it) => it.key)
        patch(keys, { message: '解析时间超出预期，请稍后在台账中查看最新状态' })
        push('info', '仍有文档在后台解析，请稍后在台账中确认状态')
      } else {
        push('success', '全部文档解析完成')
      }
    }
  }

  const stats = useMemo(() => {
    const counter = { queued: 0, running: 0, done: 0, failed: 0 }
    for (const it of items) {
      if (it.status === 'queued') counter.queued += 1
      else if (it.status === 'ready') counter.done += 1
      else if (it.status === 'failed') counter.failed += 1
      else counter.running += 1
    }
    return counter
  }, [items])

  const onPickFiles = (fileList: FileList | null, input: HTMLInputElement | null) => {
    if (!fileList || fileList.length === 0) return
    addFiles(Array.from(fileList).map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name })))
    if (input) input.value = ''
  }

  return (
    <Drawer
      open={open}
      widthClass="max-w-2xl"
      title="上传与批量导入"
      description="支持单文件上传，以及拖拽多个文件或整个文件夹批量导入"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-slate-500">
            待上传 {stats.queued} · 处理中 {stats.running} · 完成 {stats.done} · 失败 {stats.failed}
          </span>
          <Button onClick={onClose} disabled={uploading}>
            关闭
          </Button>
          <Button variant="primary" onClick={doUpload} loading={uploading} disabled={stats.queued === 0}>
            开始上传{stats.queued > 0 ? `（${stats.queued}）` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {noticeNode}
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="归属分类" hint="批量导入的文档统一归入该分类">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="未分类">未分类</option>
              {categories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}（{c.count}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="新分类（可选）" hint="填写后将覆盖左侧选择的分类">
            <Input
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              placeholder="例如：财务制度"
            />
          </Field>
        </div>

        <div className="text-xs text-slate-500">
          实际入库分类：<span className="font-medium text-indigo-600">{effectiveCategory}</span>
        </div>

        {/* 拖拽区 */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
            dragging ? 'border-indigo-400 bg-indigo-50/70' : 'border-slate-200 bg-slate-50/60',
          )}
        >
          <p className="text-sm font-medium text-slate-700">
            把文件或<strong className="text-indigo-600">整个文件夹</strong>拖到这里
          </p>
          <p className="text-xs text-slate-400">
            支持 {SUPPORTED_EXT.map((e) => `.${e}`).join(' / ')}，单文件不超过 50MB；文件夹会自动递归读取
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => fileInputRef.current?.click()}>选择文件</Button>
            <Button onClick={() => folderInputRef.current?.click()}>选择文件夹</Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onPickFiles(e.target.files, fileInputRef.current)}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            // 目录选择（非标准属性，Next/TS 需要显式声明）
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => onPickFiles(e.target.files, folderInputRef.current)}
          />
        </div>

        <InfoNote>
          上传成功后系统会在后台完成文本抽取、切片与向量化；本抽屉每 2 秒轮询一次台账（最多 60 次），
          直到新文档状态变为「已就绪」或「失败」。
          {polling ? <span className="ml-1 font-medium">（正在轮询解析状态…）</span> : null}
        </InfoNote>

        {/* 队列 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-700">待上传队列 / 上传状态</h4>
            {items.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={uploading || polling}
                onClick={() => setItems((prev) => prev.filter((it) => it.status !== 'queued'))}
              >
                清空待上传
              </Button>
            ) : null}
          </div>

          {items.length === 0 ? (
            <EmptyState title="队列为空" description="拖入文件或点击上方按钮选择文件/文件夹" />
          ) : (
            <ul className="space-y-2">
              {items.map((it) => {
                const meta = STATUS_META[it.status]
                const progress =
                  it.status === 'ready' || it.status === 'failed' ? 100 : meta.progress
                return (
                  <li
                    key={it.key}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {it.status === 'uploading' || it.status === 'parsing' ? (
                          <Spinner className="h-3.5 w-3.5 text-indigo-500" />
                        ) : null}
                        <span className="truncate text-sm text-slate-700" title={it.name}>
                          {it.name}
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">
                          {formatFileSize(it.size)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {it.status === 'ready' ? (
                          <Badge tone="emerald">已就绪 · {it.chunkCount ?? 0} 切片</Badge>
                        ) : (
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        )}
                        {it.status === 'queued' ? (
                          <button
                            type="button"
                            className="text-xs text-slate-400 hover:text-rose-500"
                            onClick={() => setItems((prev) => prev.filter((p) => p.key !== it.key))}
                          >
                            移除
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <ProgressBar
                      className="mt-2"
                      value={progress}
                      tone={
                        it.status === 'failed'
                          ? 'rose'
                          : it.status === 'ready'
                            ? 'emerald'
                            : it.status === 'accepted'
                              ? 'amber'
                              : 'indigo'
                      }
                    />
                    {it.message ? (
                      <p
                        className={cn(
                          'mt-1.5 text-xs',
                          it.status === 'failed' ? 'text-rose-600' : 'text-slate-500',
                        )}
                      >
                        {it.message}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  )
}
