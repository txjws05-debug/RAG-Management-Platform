'use client'

/** ① FAQ 挖掘与审核发布区：立即挖掘、候选问题簇展示、在线编辑后采纳或驳回。 */
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
  InfoNote,
  Input,
  Pagination,
  Select,
  Spinner,
  TextArea,
  cn,
  formatDateTime,
  formatNumber,
  useNotice,
} from '@/components/ui/kit'
import type {
  FaqCandidate,
  FaqReviewResult,
  MiningConfig,
  MiningResult,
  Paged,
} from './types'

const PAGE_SIZE = 10

const STATUS_FILTERS = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已采纳' },
  { value: 'rejected', label: '已驳回' },
  { value: 'all', label: '全部' },
]

const STATUS_META: Record<
  string,
  { label: string; tone: 'slate' | 'emerald' | 'rose' | 'amber' }
> = {
  pending: { label: '待审核', tone: 'amber' },
  approved: { label: '已采纳发布', tone: 'emerald' },
  rejected: { label: '已驳回', tone: 'rose' },
}

export interface MiningTabProps {
  can: (code: string) => boolean
}

export default function MiningTab({ can }: MiningTabProps) {
  const [status, setStatus] = useState('pending')
  const [page, setPage] = useState(1)
  const [days, setDays] = useState(30)
  const [threshold, setThreshold] = useState('')
  const [minFrequency, setMinFrequency] = useState('')
  const [mining, setMining] = useState(false)
  const [lastResult, setLastResult] = useState<MiningResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { push, node: noticeNode } = useNotice(6000)

  const canManage = can('faq:manage')

  const { data, error, isLoading, mutate } = useSWR(
    ['/faq/candidates', status, page],
    ([, statusFilter, pageNo]: [string, string, number]) =>
      api.get<Paged<FaqCandidate>>('/faq/candidates', {
        status: statusFilter,
        page: pageNo,
        page_size: PAGE_SIZE,
      }),
    { keepPreviousData: true },
  )

  const { data: config, mutate: mutateConfig } = useSWR('/mining/config', () =>
    api.get<MiningConfig>('/mining/config'),
  )

  /** 挖掘接口的 days / min_frequency / threshold 都在 query string 上，因此把参数拼进 path。 */
  const runMining = async () => {
    setMining(true)
    setActionError(null)
    try {
      const query = new URLSearchParams({ days: String(days) })
      if (minFrequency.trim()) query.set('min_frequency', minFrequency.trim())
      if (threshold.trim()) query.set('threshold', threshold.trim())
      const result = await api.post<MiningResult>(`/mining/run?${query.toString()}`)
      setLastResult(result)
      push('success', result.message || '挖掘完成')
      setPage(1)
      await Promise.all([mutate(), mutateConfig()])
    } catch (err) {
      setActionError(errorMessage(err, '挖掘执行失败'))
    } finally {
      setMining(false)
    }
  }

  return (
    <div className="space-y-4">
      {noticeNode}
      {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}

      <Card
        title="FAQ 挖掘"
        description="对近段时间的高频提问做向量聚类，生成候选 FAQ；低于置信阈值的提问会进入知识缺口清单"
        bodyClassName="space-y-3"
      >
        {/* 手机上单列：四个字段并排会在 375px 上各自窄到无法辨认 */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="统计天数">
            <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60, 90, 180].map((d) => (
                <option key={d} value={d}>
                  近 {d} 天
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="最小频次（可选）"
            hint={config ? `当前配置：${config.min_frequency}` : undefined}
          >
            <Input
              value={minFrequency}
              onChange={(e) => setMinFrequency(e.target.value)}
              placeholder="留空则用服务端配置"
              inputMode="numeric"
            />
          </Field>
          <Field
            label="聚类相似度阈值（可选）"
            hint={config ? `当前配置：${config.cluster_similarity.toFixed(2)}` : undefined}
          >
            <Input
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="0 ~ 1，留空则用服务端配置"
              inputMode="decimal"
            />
          </Field>
          <div className="flex items-end">
            <Button
              variant="primary"
              className="w-full"
              loading={mining}
              disabled={!canManage}
              onClick={runMining}
            >
              立即挖掘
            </Button>
          </div>
        </div>

        {!canManage ? (
          <InfoNote>当前账号缺少「faq:manage」权限码，挖掘与审核操作为只读。</InfoNote>
        ) : null}

        {config ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>挖掘配置：</span>
            <Badge tone="slate">聚类相似度 {config.cluster_similarity.toFixed(2)}</Badge>
            <Badge tone="slate">最小频次 {config.min_frequency}</Badge>
            <Badge tone={config.cache_enabled ? 'emerald' : 'slate'}>
              FAQ 缓存 {config.cache_enabled ? '已启用' : '未启用'}
            </Badge>
            <Badge tone="slate">缓存 TTL {config.cache_ttl_seconds}s</Badge>
            <Badge tone="slate">置信阈值 {config.confidence_threshold.toFixed(2)}</Badge>
          </div>
        ) : null}

        {lastResult ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5">
            <p className="text-xs font-medium text-emerald-800">本次挖掘结果</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge tone="sky">扫描提问 {formatNumber(lastResult.scanned_questions)}</Badge>
              <Badge tone="indigo">聚类 {formatNumber(lastResult.clusters)}</Badge>
              <Badge tone="emerald">新增候选 {formatNumber(lastResult.new_candidates)}</Badge>
              <Badge tone="amber">更新候选 {formatNumber(lastResult.updated_candidates)}</Badge>
              <Badge tone="rose">新增知识缺口 {formatNumber(lastResult.new_gaps)}</Badge>
            </div>
            <p className="mt-1.5 text-xs text-emerald-700">{lastResult.message}</p>
          </div>
        ) : null}

      </Card>

      <Card
        title="候选 FAQ 审核"
        description="每个候选卡片展示聚类问题簇、聚合频次、关联知识单元、推荐标准答案与置信度"
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
            <Spinner /> 正在加载候选 FAQ…
          </div>
        ) : null}
        {error ? <ErrorNote>{errorMessage(error, '候选 FAQ 加载失败')}</ErrorNote> : null}

        {data && data.items.length === 0 && !isLoading ? (
          <EmptyState
            title="暂无候选 FAQ"
            description="点击上方「立即挖掘」从近期提问中聚类生成候选问题"
          />
        ) : null}

        <div className="space-y-3">
          {(data?.items ?? []).map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              canManage={canManage}
              onReviewed={async (tip, tone) => {
                push(tone, tip)
                await mutate()
              }}
            />
          ))}
        </div>

        {data && data.total > 0 ? (
          <Pagination
            page={data.page}
            pageSize={data.page_size}
            total={data.total}
            onChange={setPage}
          />
        ) : null}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 候选卡片                                                            */
/* ------------------------------------------------------------------ */

function confidenceTone(confidence: number): 'emerald' | 'amber' | 'rose' {
  if (confidence >= 0.8) return 'emerald'
  if (confidence >= 0.6) return 'amber'
  return 'rose'
}

function CandidateCard({
  candidate,
  canManage,
  onReviewed,
}: {
  candidate: FaqCandidate
  canManage: boolean
  onReviewed: (tip: string, tone: 'success' | 'error' | 'info') => Promise<void> | void
}) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState(candidate.canonical_question)
  const [answer, setAnswer] = useState(candidate.suggested_answer ?? '')
  const [category, setCategory] = useState('通用')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const statusMeta = STATUS_META[candidate.status] ?? { label: candidate.status, tone: 'slate' as const }
  const reviewed = candidate.status !== 'pending'

  const review = async (action: 'approve' | 'reject') => {
    setBusy(action)
    setError(null)
    try {
      if (action === 'approve' && !answer.trim()) {
        setError('请先填写标准答案再采纳发布')
        setBusy(null)
        return
      }
      const res = await api.post<FaqReviewResult>(`/faq/candidates/${candidate.id}/review`, {
        action,
        question: question.trim() || undefined,
        answer: answer.trim() || undefined,
        category: category.trim() || undefined,
      })
      if (action === 'approve') {
        await onReviewed(
          `已采纳并发布上线（FAQ #{res.faq_entry_id ?? '—'}），缓存已同步刷新`,
          'success',
        )
      } else {
        await onReviewed('已驳回该候选 FAQ', 'info')
      }
      setOpen(false)
    } catch (err) {
      setError(errorMessage(err, action === 'approve' ? '采纳失败' : '驳回失败'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="rounded-xl border border-line bg-canvas">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
            <Badge tone="indigo">频次 {formatNumber(candidate.frequency)}</Badge>
            <Badge tone={confidenceTone(candidate.confidence)}>
              置信度 {candidate.confidence.toFixed(2)}
            </Badge>
            <span className="text-xs text-faint">创建于 {formatDateTime(candidate.created_at)}</span>
          </div>
          {/* break-words：候选问题是任意用户原话，可能是一串没有空格的专有名词 */}
          <h4 className="mt-2 text-sm font-semibold break-words text-strong">
            {candidate.canonical_question}
          </h4>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? '收起详情' : '查看 / 审核'}
          </Button>
        </div>
      </header>

      <div className="space-y-3 px-4 py-3">
        {/* 置信度条 */}
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-faint">置信度</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
            <div
              className={cn(
                'h-full rounded-full',
                confidenceTone(candidate.confidence) === 'emerald'
                  ? 'bg-emerald-500'
                  : confidenceTone(candidate.confidence) === 'amber'
                    ? 'bg-amber-500'
                    : 'bg-rose-500',
              )}
              style={{ width: `${Math.round(Math.max(0, Math.min(1, candidate.confidence)) * 100)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-xs text-muted">
            {Math.round(candidate.confidence * 100)}%
          </span>
        </div>

        {/* 聚类问题簇 */}
        <div>
          <p className="text-xs font-medium text-muted">
            聚类问题簇（{candidate.sample_questions.length} 条样本）
          </p>
          <ul className="mt-1.5 space-y-1">
            {candidate.sample_questions.slice(0, open ? undefined : 3).map((q, idx) => (
              <li
                key={`${candidate.id}-sample-${idx}`}
                className="rounded-md bg-subtle px-2 py-1 text-xs break-words text-body"
              >
                {q}
              </li>
            ))}
            {candidate.sample_questions.length === 0 ? (
              <li className="text-xs text-faint">无样本问题</li>
            ) : null}
          </ul>
          {!open && candidate.sample_questions.length > 3 ? (
            <button
              type="button"
              className="mt-1 inline-block py-1 text-xs text-brand-ink hover:underline"
              onClick={() => setOpen(true)}
            >
              展开其余 {candidate.sample_questions.length - 3} 条
            </button>
          ) : null}
        </div>

        {/* 关联知识单元 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-faint">关联知识单元：</span>
          {candidate.related_documents.length > 0 ? (
            candidate.related_documents.map((doc) => (
              <Badge key={`${candidate.id}-${doc}`} tone="sky" title={doc}>
                {doc}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-faint">未关联到现有知识单元</span>
          )}
        </div>

        {open ? (
          <div className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Field label="标准问题" hint="可在此修改，采纳后作为上线问题与向量依据">
              <TextArea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={reviewed || !canManage}
              />
            </Field>
            <Field label="标准答案" required hint="可在线编辑推荐答案后再采纳发布">
              <TextArea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                className="min-h-[120px]"
                disabled={reviewed || !canManage}
                placeholder={candidate.suggested_answer ? undefined : '该候选暂无推荐答案，请人工补充'}
              />
            </Field>
            {/* 手机上单列：分类输入与两个按钮并排会被压得点不准 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="FAQ 分类">
                <Input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={reviewed || !canManage}
                />
              </Field>
              <div className="flex flex-wrap items-end gap-2">
                <Button
                  variant="primary"
                  disabled={reviewed || !canManage}
                  loading={busy === 'approve'}
                  onClick={() => void review('approve')}
                >
                  采纳并发布上线
                </Button>
                <Button
                  variant="danger"
                  disabled={reviewed || !canManage}
                  loading={busy === 'reject'}
                  onClick={() => void review('reject')}
                >
                  驳回
                </Button>
              </div>
            </div>
            {reviewed ? (
              <p className="text-xs text-faint">
                该候选已{candidate.status === 'approved' ? '采纳发布' : '驳回'}，不可重复审核。
              </p>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg bg-subtle px-3 py-2">
            <p className="text-xs text-faint">
              推荐标准答案：{candidate.suggested_answer ? '已生成，展开可编辑' : '暂无，需要人工补充'}
            </p>
            {candidate.suggested_answer ? (
              <p className="mt-1 line-clamp-2 text-xs break-words text-body">
                {candidate.suggested_answer}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </article>
  )
}
