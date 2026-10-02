'use client'

/** 已发布 FAQ 知识库区：快速检索、启停、缓存生效开关、缓存状态卡片、编辑与删除。 */
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
  Switch,
  TableWrap,
  Td,
  Th,
  TextArea,
  formatDateTime,
  formatNumber,
  useDebounced,
  useNotice,
} from '@/components/ui/kit'
import type { FaqCacheStats, FaqEntry, FaqEntryPage } from './types'

const PAGE_SIZE = 20

export interface PublishedFaqProps {
  can: (code: string) => boolean
}

export default function PublishedFaqTab({ can }: PublishedFaqProps) {
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editEntry, setEditEntry] = useState<FaqEntry | null>(null)
  const [deleteEntry, setDeleteEntry] = useState<FaqEntry | null>(null)
  const debouncedKeyword = useDebounced(keyword, 400)
  const { push, node: noticeNode } = useNotice()

  const canManage = can('faq:manage')

  const { data, error, isLoading, mutate } = useSWR(
    ['/faq/entries', debouncedKeyword, page],
    ([, keywordValue, pageNo]: [string, string, number]) =>
      api.get<FaqEntryPage>('/faq/entries', {
        keyword: keywordValue.trim() || undefined,
        page: pageNo,
        page_size: PAGE_SIZE,
      }),
    { keepPreviousData: true },
  )

  const entries = data?.items ?? []
  const cache = data?.cache

  const patch = async (entry: FaqEntry, body: Record<string, unknown>, tip: string) => {
    setBusyId(entry.id)
    try {
      await api.put(`/faq/entries/${entry.id}`, body)
      push('success', tip)
      await mutate()
    } catch (err) {
      push('error', errorMessage(err, '更新失败'))
    } finally {
      setBusyId(null)
    }
  }

  const refreshCache = async () => {
    try {
      const stats = await api.post<FaqCacheStats>('/faq/cache/refresh')
      push('success', `缓存已刷新：当前缓存 ${stats?.cached_entries ?? 0} 条`)
      await mutate()
    } catch (err) {
      push('error', errorMessage(err, '缓存刷新失败'))
    }
  }

  const doDelete = async () => {
    if (!deleteEntry) return
    const entry = deleteEntry
    try {
      await api.delete(`/faq/entries/${entry.id}`)
      push('success', 'FAQ 已删除')
      setDeleteEntry(null)
      await mutate()
    } catch (err) {
      push('error', errorMessage(err, '删除失败'))
    }
  }

  return (
    <div className="space-y-4">
      {noticeNode}

      {/* 缓存状态卡片 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">缓存状态</p>
          <p className="mt-1 flex items-center gap-2">
            <Badge tone={cache?.enabled ? 'emerald' : 'slate'}>
              {cache?.enabled ? '已启用' : '未启用'}
            </Badge>
            <span className="text-xs text-slate-400">
              TTL 由服务端配置 · 版本 v{cache?.version ?? 0}
            </span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">缓存条数</p>
          <p className="mt-1 text-xl font-semibold text-indigo-600">
            {formatNumber(cache?.cached_entries ?? 0)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">命中阈值</p>
          <p className="mt-1 text-xl font-semibold text-slate-800">
            {cache?.match_threshold !== undefined ? cache.match_threshold.toFixed(2) : '—'}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs text-slate-500">最近加载时间</p>
          <p className="mt-1 text-sm text-slate-700">{formatDateTime(cache?.loaded_at)}</p>
          {canManage ? (
            <Button size="sm" className="mt-2" onClick={refreshCache}>
              刷新缓存
            </Button>
          ) : null}
        </div>
      </div>

      <Card
        title="已发布 FAQ"
        description="FAQ 缓存命中后可直接返回标准答案，命中阈值由挖掘配置决定"
        bodyClassName="space-y-3"
        actions={
          <>
            <Input
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value)
                setPage(1)
              }}
              placeholder="检索问题或答案"
              className="h-8 w-56 text-xs"
            />
            <Button size="sm" onClick={() => void mutate()}>
              刷新
            </Button>
          </>
        }
      >
        {isLoading && !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Spinner /> 正在加载 FAQ…
          </div>
        ) : null}
        {error ? <ErrorNote>{errorMessage(error, 'FAQ 列表加载失败')}</ErrorNote> : null}

        {data && entries.length === 0 ? (
          <EmptyState title="暂无已发布 FAQ" description="可在「FAQ 挖掘与审核」中采纳候选问题后自动发布" />
        ) : null}

        {entries.length > 0 ? (
          <>
            <TableWrap minWidthClass="min-w-[960px]">
              <thead>
                <tr>
                  <Th>问题</Th>
                  <Th>标准答案</Th>
                  <Th className="w-[100px]">分类</Th>
                  <Th className="w-[80px]">命中次数</Th>
                  <Th className="w-[110px]">缓存开关</Th>
                  <Th className="w-[90px]">启用</Th>
                  <Th className="w-[140px]">发布时间</Th>
                  <Th className="w-[170px]">操作</Th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50/70">
                    <Td className="max-w-[280px]">
                      <p className="truncate font-medium text-slate-800" title={entry.question}>
                        {entry.question}
                      </p>
                    </Td>
                    <Td className="max-w-[320px]">
                      <p className="line-clamp-2 text-xs text-slate-600" title={entry.answer}>
                        {entry.answer}
                      </p>
                    </Td>
                    <Td className="text-xs text-slate-600">{entry.category}</Td>
                    <Td className="text-xs text-slate-600">{formatNumber(entry.hit_count)}</Td>
                    <Td>
                      {canManage ? (
                        <Switch
                          checked={entry.cache_enabled}
                          disabled={busyId === entry.id}
                          title="缓存生效：命中后直出答案"
                          onChange={(next) =>
                            void patch(
                              entry,
                              { cache_enabled: next },
                              next ? '已开启该 FAQ 的缓存生效' : '已关闭该 FAQ 的缓存生效',
                            )
                          }
                        />
                      ) : (
                        <Badge tone={entry.cache_enabled ? 'emerald' : 'slate'}>
                          {entry.cache_enabled ? '缓存生效' : '未缓存'}
                        </Badge>
                      )}
                    </Td>
                    <Td>
                      {canManage ? (
                        <Switch
                          checked={entry.enabled}
                          disabled={busyId === entry.id}
                          onChange={(next) =>
                            void patch(entry, { enabled: next }, next ? 'FAQ 已启用' : 'FAQ 已停用')
                          }
                        />
                      ) : (
                        <Badge tone={entry.enabled ? 'emerald' : 'slate'}>
                          {entry.enabled ? '启用' : '停用'}
                        </Badge>
                      )}
                    </Td>
                    <Td className="text-xs text-slate-500">{formatDateTime(entry.published_at)}</Td>
                    <Td>
                      {canManage ? (
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" onClick={() => setEditEntry(entry)}>
                            编辑
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleteEntry(entry)}>
                            删除
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">只读</span>
                      )}
                    </Td>
                  </tr>
                ))}
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

      <EntryEditModal
        entry={editEntry}
        onClose={() => setEditEntry(null)}
        onSaved={async () => {
          push('success', 'FAQ 已更新，缓存已同步刷新')
          setEditEntry(null)
          await mutate()
        }}
      />

      <Modal
        open={deleteEntry !== null}
        title="删除 FAQ"
        description="删除后该问答将立即从缓存中移除，不可恢复。"
        widthClass="max-w-md"
        onClose={() => setDeleteEntry(null)}
        footer={
          <>
            <Button onClick={() => setDeleteEntry(null)}>取消</Button>
            <Button variant="primary" className="bg-rose-600 hover:bg-rose-700" onClick={doDelete}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          确定删除 FAQ
          <span className="mx-1 font-medium text-slate-800">「{deleteEntry?.question}」</span>
          吗？
        </p>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function EntryEditModal({
  entry,
  onClose,
  onSaved,
}: {
  entry: FaqEntry | null
  onClose: () => void
  onSaved: () => void
}) {
  return (
    <Modal
      open={entry !== null}
      widthClass="max-w-2xl"
      title="编辑 FAQ"
      onClose={onClose}
    >
      {entry ? <EntryEditForm key={entry.id} entry={entry} onClose={onClose} onSaved={onSaved} /> : null}
    </Modal>
  )
}

function EntryEditForm({
  entry,
  onClose,
  onSaved,
}: {
  entry: FaqEntry
  onClose: () => void
  onSaved: () => void
}) {
  const [question, setQuestion] = useState(entry.question)
  const [answer, setAnswer] = useState(entry.answer)
  const [category, setCategory] = useState(entry.category)
  const [enabled, setEnabled] = useState(entry.enabled)
  const [cacheEnabled, setCacheEnabled] = useState(entry.cache_enabled)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!question.trim() || !answer.trim()) {
      setError('问题与标准答案都不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.put(`/faq/entries/${entry.id}`, {
        question: question.trim(),
        answer: answer.trim(),
        category: category.trim() || '通用',
        enabled,
        cache_enabled: cacheEnabled,
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
      <Field label="标准问题" required hint="修改问题会重新计算向量，缓存同步刷新">
        <TextArea value={question} onChange={(e) => setQuestion(e.target.value)} />
      </Field>
      <Field label="标准答案" required>
        <TextArea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          className="min-h-[140px]"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="分类">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} />
        </Field>
        <Field label="启用状态">
          <Select
            value={enabled ? '1' : '0'}
            onChange={(e) => setEnabled(e.target.value === '1')}
          >
            <option value="1">启用</option>
            <option value="0">停用</option>
          </Select>
        </Field>
        <Field label="缓存生效">
          <Select
            value={cacheEnabled ? '1' : '0'}
            onChange={(e) => setCacheEnabled(e.target.value === '1')}
          >
            <option value="1">缓存生效</option>
            <option value="0">不进入缓存</option>
          </Select>
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
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
