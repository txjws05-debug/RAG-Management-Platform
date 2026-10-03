'use client'

/** 模型接口配置：只读展示 GET /config/model，密钥是否配置用绿/红标签标注。 */
import type { ReactNode } from 'react'
import useSWR from 'swr'
import { api, errorMessage } from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  InfoNote,
  Spinner,
  TableWrap,
  Td,
  Th,
  formatNumber,
} from '@/components/ui/kit'
import type { ModelConfig, PermissionsCatalog } from './types'

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    // 窄屏改为纵向堆叠：左右分布时长 base_url 这类无空格字符串会把布局撑破
    <div className="flex flex-col gap-1 border-b border-line py-2 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-body">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-faint">{hint}</p> : null}
      </div>
      <div className="min-w-0 text-left text-sm text-strong sm:shrink-0 sm:text-right">{value}</div>
    </div>
  )
}

function KeyBadge({ configured }: { configured: boolean }) {
  return (
    <Badge tone={configured ? 'emerald' : 'rose'}>
      {configured ? '已配置密钥' : '未配置密钥'}
    </Badge>
  )
}

export default function ModelConfigPanel() {
  const { data, error, isLoading, mutate } = useSWR('/config/model', () =>
    api.get<ModelConfig>('/config/model'),
  )
  const { data: catalog } = useSWR('/config/permissions-catalog', () =>
    api.get<PermissionsCatalog>('/config/permissions-catalog'),
  )

  return (
    <div className="space-y-3 sm:space-y-4">
      <InfoNote>
        模型接口参数为<strong>只读展示</strong>，来源于服务端环境变量；
        <strong>修改请编辑 .env 后重启服务</strong>。
      </InfoNote>

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted">
          <Spinner /> 正在加载模型配置…
        </div>
      ) : null}
      {error ? <ErrorNote>{errorMessage(error, '模型配置加载失败')}</ErrorNote> : null}

      {data ? (
        <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
          <Card
            title="大语言模型（LLM）"
            description="用于生成答案与候选 FAQ 推荐答案"
            actions={
              <>
                <KeyBadge configured={data.llm_key_configured} />
                <Button size="sm" onClick={() => void mutate()}>
                  刷新
                </Button>
              </>
            }
            bodyClassName="py-1"
          >
            <Row
              label="接口地址 base_url"
              value={<span className="font-mono text-xs break-all">{data.llm_base_url}</span>}
            />
            <Row
              label="对话模型 chat_model"
              value={<span className="font-mono text-xs break-all">{data.llm_chat_model}</span>}
            />
            <Row label="温度 temperature" value={data.llm_temperature.toFixed(2)} />
            <Row label="最大输出 Token" value={formatNumber(data.llm_max_tokens)} />
            <Row
              label="API Key"
              hint="是否配置由环境变量 LLM_API_KEY 决定"
              value={<KeyBadge configured={data.llm_key_configured} />}
            />
          </Card>

          <Card title="向量模型（Embedding）" description="用于切片向量化与语义检索" bodyClassName="py-1">
            <Row
              label="接口地址 base_url"
              value={<span className="font-mono text-xs break-all">{data.embedding_base_url}</span>}
            />
            <Row
              label="向量模型"
              value={<span className="font-mono text-xs break-all">{data.embedding_model}</span>}
            />
            <Row
              label="向量维度"
              value={formatNumber(data.embedding_dim)}
              hint="维度变化后需要重新索引全部知识单元"
            />
            <Row
              label="运行模式"
              value={
                <Badge tone={data.embedding_mode === 'remote' ? 'indigo' : 'amber'}>
                  {data.embedding_mode === 'remote' ? '远程模型' : data.embedding_mode}
                </Badge>
              }
              hint="remote 表示调用远程接口，其余为本地离线向量化"
            />
            <Row
              label="API Key"
              hint="是否配置由环境变量 EMBEDDING_API_KEY 决定"
              value={<KeyBadge configured={data.embedding_key_configured} />}
            />
          </Card>

          <Card title="检索与问答" description="影响召回条数与兜底策略" bodyClassName="py-1">
            <Row label="检索 Top K" value={formatNumber(data.retrieve_top_k)} />
            <Row
              label="置信度阈值"
              value={data.confidence_threshold.toFixed(2)}
              hint="低于该阈值的提问会记入知识缺口"
            />
            <Row
              label="FAQ 缓存"
              value={
                <Badge tone={data.faq_cache_enabled ? 'emerald' : 'slate'}>
                  {data.faq_cache_enabled ? '已启用' : '未启用'}
                </Badge>
              }
            />
            <Row label="FAQ 最小频次" value={formatNumber(data.faq_min_frequency)} />
          </Card>

          <Card title="切片与入库" description="文档切分参数，修改后需重新索引生效" bodyClassName="py-1">
            <Row label="切片长度 chunk_size" value={formatNumber(data.chunk_size)} />
            <Row label="切片重叠 chunk_overlap" value={formatNumber(data.chunk_overlap)} />
          </Card>
        </div>
      ) : null}

      {/* 权限点目录 */}
      {catalog ? (
        <Card
          title="功能权限点目录"
          description="与后端 require_permission 一一对应，用于角色配置与按钮级鉴权"
          bodyClassName="space-y-3"
        >
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">菜单级权限</p>
            <TableWrap minWidthClass="min-w-[420px] sm:min-w-[520px]">
              <thead>
                <tr>
                  <Th className="w-[140px] px-2 py-2 sm:w-[180px] sm:px-3 sm:py-2.5">菜单编码</Th>
                  <Th className="px-2 py-2 sm:px-3 sm:py-2.5">菜单名称</Th>
                  <Th className="w-[140px] px-2 py-2 sm:w-[180px] sm:px-3 sm:py-2.5">所需权限码</Th>
                </tr>
              </thead>
              <tbody>
                {catalog.menus.map((menu) => (
                  <tr key={menu.code}>
                    <Td className="px-2 py-2 font-mono text-xs text-muted sm:px-3 sm:py-2.5">
                      {menu.code}
                    </Td>
                    <Td className="px-2 py-2 text-sm text-body sm:px-3 sm:py-2.5">{menu.name}</Td>
                    <Td className="px-2 py-2 sm:px-3 sm:py-2.5">
                      <Badge tone="indigo">{menu.permission}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">操作级权限（按钮级鉴权）</p>
            <div className="flex flex-wrap gap-1.5">
              {catalog.operations.map((op) => (
                <span
                  key={op.code}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-1 text-xs"
                >
                  <span className="font-mono text-muted">{op.code}</span>
                  <span className="text-body">{op.name}</span>
                </span>
              ))}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
