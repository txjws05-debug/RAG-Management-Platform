'use client'

/** ③ 知识缺口清单区：未命中提问、提问部门、频次、最高相似度、建议分类、转建任务与标记解决。 */
import { useState } from 'react'
import useSWR from 'swr'
import { api, errorMessage } from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Pagination,
  Select,
  Spinner,
  TableWrap,
  Td,
  Th,
  TextArea,
  cn,
  formatDateTime,
  formatNumber,
  useNotice,
} from '@/components/ui/kit'
import type { GapTaskResult, KnowledgeGap, Paged } from './types'

const PAGE_SIZE = 20

const STATUS_FILTERS = [
  { value: 'open', label: '待处理' },
  { value: 'task_created', label: '已转建任务' },
  { value: 'resolved', label: '已解决' },
  { value: 'all', label: '全部' },
]

const STATUS_META: Record<string, { label: string; tone: 'amber' | 'indigo' | 'emerald' | 'slate' }> = {
  open: { label: '待处理', tone: 'amber' },
  task_created: { label: '已转建任务', tone: 'indigo' },
  resolved: { label: '已解决', tone: 'emerald' },
}

function similarityTone(v: number): 'emerald' | 'amber' | 'rose' {
  if (v >= 0.6) return 'emerald'
  if (v >= 0.4) return 'amber'
  return 'rose'
}

export interface GapTabProps {
  can: (code: string) => boolean
}

export default function GapTab({ can }: GapTabProps) {
  const [status, setStatus] = useState('open')
  const [page, setPage] = useState(1)
  const [taskGap, setTaskGap] = useState<KnowledgeGap | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const { push, node: noticeNode } = useNotice(6000)

  const canManage = can('faq:manage') || can('gap:manage')

  const { data, error, isLoading, mutate } = useSWR(
    ['/gaps', status, page],
    ([, statusFilter, pageNo]: [string, string, number]) =>
      api.get<Paged<KnowledgeGap>>('/gaps', {
        status: statusFilter,
        page: pageNo,
        page_size: PAGE_SIZE,
      }),
    { keepPreviousData: true },
  )

  const resolveGap = async (gap: KnowledgeGap) => {
    setBusyId(gap.id)
    try {
      await api.post(`/gaps/${gap.id}/resolve`)
      push('success', `已标记「${gap.question_text}」为已解决`)
      await mutate()
    } catch (err) {
      push('error', errorMessage(err, '标记失败'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      {noticeNode}

      <Card
        title="知识缺口清单"
        description="低置信度或未命中的提问会沉淀为知识缺口，可一键转建知识补充任务"
        bodyClassName="space-y-3"
        actions={
          <>
            <Select
              value={status}
              className="h-8 text-xs"
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={() => void mutate()}>
              刷新
            </Button>
          </>
        }
      >
        {isLoading && !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Spinner /> 正在加载知识缺口…
          </div>
        ) : null}
        {error ? <ErrorNote>{errorMessage(error, '知识缺口加载失败')}</ErrorNote> : null}

        {data && data.items.length === 0 && !isLoading ? (
          <EmptyState
            title="暂无知识缺口"
            description="执行一次挖掘后，低置信度提问会在此列出"
          />
        ) : null}

        {(data?.items ?? []).length > 0 ? (
          <>
            <TableWrap minWidthClass="min-w-[1040px]">
              <thead>
                <tr>
                  {/* 手机上只留「提问 / 频次 / 状态 / 操作」，其余列 md 起才出现 */}
                  <Th className="min-w-[200px]">未命中提问</Th>
                  <Th className="hidden w-[130px] md:table-cell">提问部门</Th>
                  <Th className="w-[80px]">频次</Th>
                  <Th className="hidden w-[110px] md:table-cell">最高相似度</Th>
                  <Th className="hidden w-[130px] md:table-cell">建议分类</Th>
                  <Th className="w-[110px]">状态</Th>
                  <Th className="hidden w-[140px] md:table-cell">最近出现</Th>
                  <Th className="w-[190px]">操作</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((gap) => {
                  const meta = STATUS_META[gap.status] ?? { label: gap.status, tone: 'slate' as const }
                  return (
                    <tr key={gap.id} className="align-top hover:bg-subtle/70">
                      <Td className="min-w-0 max-w-[320px]">
                        <p className="font-medium break-words text-strong">{gap.question_text}</p>
                        {gap.task_note ? (
                          <p className="mt-1 rounded-md bg-brand-soft/70 px-2 py-1 text-xs leading-relaxed break-words text-brand-ink">
                            任务说明：{gap.task_note}
                          </p>
                        ) : null}
                      </Td>
                      <Td className="hidden text-xs text-body md:table-cell">
                        {gap.department_name ?? '未知部门'}
                      </Td>
                      <Td className="text-xs text-body">
                        <span className="font-semibold text-strong">{formatNumber(gap.frequency)}</span> 次
                      </Td>
                      <Td className="hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <Badge tone={similarityTone(gap.max_similarity)}>
                            {gap.max_similarity.toFixed(2)}
                          </Badge>
                          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-subtle">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                similarityTone(gap.max_similarity) === 'emerald'
                                  ? 'bg-emerald-500'
                                  : similarityTone(gap.max_similarity) === 'amber'
                                    ? 'bg-amber-500'
                                    : 'bg-rose-500',
                              )}
                              style={{
                                width: `${Math.round(Math.max(0, Math.min(1, gap.max_similarity)) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      </Td>
                      <Td className="hidden text-xs text-body md:table-cell">
                        {gap.suggested_category || '未建议'}
                      </Td>
                      <Td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </Td>
                      <Td className="hidden text-xs text-muted md:table-cell">
                        {formatDateTime(gap.last_seen_at)}
                      </Td>
                      <Td>
                        {canManage ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busyId === gap.id || gap.status === 'resolved'}
                              onClick={() => setTaskGap(gap)}
                            >
                              {gap.status === 'task_created' ? '重新转建' : '一键转建任务'}
                            </Button>
                            <Button
                              size="sm"
                              disabled={busyId === gap.id || gap.status === 'resolved'}
                              onClick={() => void resolveGap(gap)}
                            >
                              标记已解决
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-faint">只读</span>
                        )}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </TableWrap>
            <Pagination
              page={data?.page ?? page}
              pageSize={data?.page_size ?? PAGE_SIZE}
              total={data?.total ?? 0}
              onChange={setPage}
            />
          </>
        ) : null}
      </Card>

      <GapTaskModal
        gap={taskGap}
        onClose={() => setTaskGap(null)}
        onCreated={async (tip) => {
          push('success', tip)
          setTaskGap(null)
          await mutate()
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function GapTaskModal({
  gap,
  onClose,
  onCreated,
}: {
  gap: KnowledgeGap | null
  onClose: () => void
  onCreated: (tip: string) => void
}) {
  return (
    <Modal
      open={gap !== null}
      widthClass="max-w-lg"
      title="转建知识补充任务"
      description="为知识缺口生成补充文档的任务说明，便于分配责任人跟进"
      onClose={onClose}
    >
      {gap ? <GapTaskForm key={gap.id} gap={gap} onClose={onClose} onCreated={onCreated} /> : null}
    </Modal>
  )
}

function GapTaskForm({
  gap,
  onClose,
  onCreated,
}: {
  gap: KnowledgeGap
  onClose: () => void
  onCreated: (tip: string) => void
}) {
  const [note, setNote] = useState('')
  const [category, setCategory] = useState(gap.suggested_category || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<GapTaskResult>(`/gaps/${gap.id}/task`, {
        note: note.trim() || undefined,
        category: category.trim() || undefined,
      })
      onCreated(`任务已创建：${res.task_note}`)
    } catch (err) {
      setError(errorMessage(err, '任务创建失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="rounded-lg border border-line bg-subtle/70 px-3 py-2.5">
        <p className="text-sm font-medium break-words text-strong">{gap.question_text}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Badge tone="slate">部门 {gap.department_name ?? '未知'}</Badge>
          <Badge tone="indigo">频次 {gap.frequency}</Badge>
          <Badge tone="amber">最高相似度 {gap.max_similarity.toFixed(2)}</Badge>
        </div>
      </div>
      <Field label="任务说明（可选）" hint="留空由后端按缺口信息自动生成任务说明">
        <TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="例如：请客户服务中心补充《退换货政策》文档并录入知识库"
        />
      </Field>
      <Field label="建议分类">
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="例如：售后服务"
        />
      </Field>
      {/* 底部按钮换行 + 触屏 44px 可点区 */}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button onClick={onClose} disabled={saving}>
          取消
        </Button>
        <Button variant="primary" onClick={submit} loading={saving}>
          创建任务
        </Button>
      </div>
    </div>
  )
}
