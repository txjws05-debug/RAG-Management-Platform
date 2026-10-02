'use client'

/** 知识沉淀与运营管理：FAQ 挖掘审核 / 已发布 FAQ / 知识缺口 三个区块。 */
import { useState } from 'react'
import { useAuth } from '@/lib/auth'
import { Card, cn } from '@/components/ui/kit'
import MiningTab from '@/components/sedimentation/MiningTab'
import PublishedFaqTab from '@/components/sedimentation/PublishedFaqTab'
import GapTab from '@/components/sedimentation/GapTab'

type TabKey = 'mining' | 'published' | 'gaps'

const TABS: { key: TabKey; label: string; description: string }[] = [
  {
    key: 'mining',
    label: 'FAQ 挖掘与审核',
    description: '高频提问聚类 → 候选问题簇 → 人工编辑采纳发布',
  },
  {
    key: 'published',
    label: '已发布 FAQ 知识库',
    description: '已上线问答检索、缓存生效开关与缓存状态',
  },
  {
    key: 'gaps',
    label: '知识缺口清单',
    description: '未命中提问沉淀、转建知识补充任务与闭环',
  },
]

export default function SedimentationPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState<TabKey>('mining')

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-slate-800">知识沉淀与运营管理</h1>
        <p className="mt-1 text-sm text-slate-500">
          从真实提问中挖掘高频 FAQ 与知识缺口，人工审核后发布上线并写入缓存，形成知识运营闭环。
        </p>
      </header>

      {/* Tab 切换 */}
      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm shadow-slate-100">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              'flex-1 rounded-lg px-3 py-2 text-left transition-colors',
              tab === item.key ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50',
            )}
          >
            <span className="block text-sm font-medium">{item.label}</span>
            <span
              className={cn(
                'mt-0.5 block text-xs',
                tab === item.key ? 'text-indigo-500' : 'text-slate-400',
              )}
            >
              {item.description}
            </span>
          </button>
        ))}
      </div>

      {tab === 'mining' ? <MiningTab can={can} /> : null}
      {tab === 'published' ? <PublishedFaqTab can={can} /> : null}
      {tab === 'gaps' ? <GapTab can={can} /> : null}

      <Card title="运营说明" bodyClassName="text-xs leading-relaxed text-slate-500">
        <ul className="list-inside list-disc space-y-1">
          <li>「立即挖掘」会扫描近期提问做向量聚类（参数请在服务端 .env 或挖掘配置中调整）。</li>
          <li>候选 FAQ 需要人工审核：可在线修改标准问题与答案，采纳后立即发布上线并写入 FAQ 缓存。</li>
          <li>置信度不足的提问会沉淀为知识缺口，转建补充任务后可标记已解决以完成闭环。</li>
        </ul>
      </Card>
    </div>
  )
}
