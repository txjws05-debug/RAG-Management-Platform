'use client'

/** 部门树面板：增删改、层级展示与人数统计。 */
import { useMemo, useState } from 'react'
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
  Select,
  Spinner,
  cn,
  useNotice,
} from '@/components/ui/kit'
import type { DepartmentNode } from './types'

export interface DepartmentPanelProps {
  can: (code: string) => boolean
}

interface FlatDept {
  node: DepartmentNode
  depth: number
}

function flatten(nodes: DepartmentNode[], depth = 0): FlatDept[] {
  const out: FlatDept[] = []
  for (const node of nodes) {
    out.push({ node, depth })
    out.push(...flatten(node.children, depth + 1))
  }
  return out
}

function collectIds(node: DepartmentNode): number[] {
  return [node.id, ...node.children.flatMap(collectIds)]
}

export default function DepartmentPanel({ can }: DepartmentPanelProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<DepartmentNode | null>(null)
  const [presetParent, setPresetParent] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DepartmentNode | null>(null)
  const { push, node: noticeNode } = useNotice(6000)

  const canManage = can('system:manage')

  const { data, error, isLoading, mutate } = useSWR('/departments/tree', () =>
    api.get<DepartmentNode[]>('/departments/tree'),
  )

  const flat = useMemo(() => flatten(data ?? []), [data])
  const totalUsers = flat.reduce((sum, item) => sum + item.node.user_count, 0)

  const openCreate = (parent: DepartmentNode | null) => {
    setEditing(null)
    setPresetParent(parent?.id ?? null)
    setFormOpen(true)
  }

  const openEdit = (node: DepartmentNode) => {
    setEditing(node)
    setPresetParent(node.parent_id)
    setFormOpen(true)
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    try {
      await api.delete(`/departments/${deleteTarget.id}`)
      push('success', `部门「${deleteTarget.name}」已删除`)
      setDeleteTarget(null)
      if (selectedId === deleteTarget.id) setSelectedId(null)
      await mutate()
    } catch (err) {
      // 有子部门或在职用户时后端会返回具体错误信息，需要展示
      push('error', errorMessage(err, '部门删除失败'))
      setDeleteTarget(null)
    }
  }

  return (
    <div className="space-y-4">
      {noticeNode}

      <Card
        title="组织架构（部门树）"
        description="部门用于四维数据权限中的「部门」维度；删除前需先移除子部门与在职用户"
        actions={
          <>
            <Button size="sm" onClick={() => void mutate()}>
              刷新
            </Button>
            {canManage ? (
              <Button size="sm" variant="primary" onClick={() => openCreate(null)}>
                新增一级部门
              </Button>
            ) : null}
          </>
        }
        bodyClassName="space-y-3"
      >
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <Spinner /> 正在加载部门树…
          </div>
        ) : null}
        {error ? <ErrorNote>{errorMessage(error, '部门树加载失败')}</ErrorNote> : null}

        {data && data.length === 0 && !isLoading ? (
          <EmptyState title="暂无部门" description="可点击「新增一级部门」创建组织架构" />
        ) : null}

        {flat.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Badge tone="indigo">部门总数 {flat.length}</Badge>
              <Badge tone="slate">在册用户（部门归属计数）{totalUsers}</Badge>
            </div>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {flat.map(({ node, depth }) => (
                <li
                  key={node.id}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 hover:bg-slate-50/70',
                    selectedId === node.id && 'bg-indigo-50/60',
                    !node.enabled && 'opacity-60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(node.id === selectedId ? null : node.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    style={{ paddingLeft: depth * 20 }}
                  >
                    <span className="text-slate-300">{depth === 0 ? '▣' : '└'}</span>
                    <span className="truncate text-sm font-medium text-slate-800">{node.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">{node.code}</span>
                    <Badge tone={node.user_count > 0 ? 'indigo' : 'slate'}>
                      {node.user_count} 人
                    </Badge>
                    {!node.enabled ? <Badge tone="rose">已停用</Badge> : null}
                  </button>
                  {canManage ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button size="sm" onClick={() => openCreate(node)}>
                        新增子部门
                      </Button>
                      <Button size="sm" onClick={() => openEdit(node)}>
                        编辑
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleteTarget(node)}>
                        删除
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Card>

      <DepartmentFormModal
        open={formOpen}
        editing={editing}
        presetParentId={presetParent}
        flat={flat}
        onClose={() => setFormOpen(false)}
        onSaved={async (tip) => {
          push('success', tip)
          setFormOpen(false)
          await mutate()
        }}
      />

      <Modal
        open={deleteTarget !== null}
        title="删除部门"
        widthClass="max-w-md"
        description="若该部门仍有子部门或在职用户，后端会拒绝删除并返回具体原因。"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="primary" className="bg-rose-600 hover:bg-rose-700" onClick={doDelete}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          确定删除部门
          <span className="mx-1 font-medium text-slate-800">「{deleteTarget?.name}」</span>
          （{deleteTarget?.code}）吗？
        </p>
        {deleteTarget && deleteTarget.user_count > 0 ? (
          <p className="mt-2 text-xs text-rose-600">
            该部门下仍有 {deleteTarget.user_count} 个用户，请先迁移或删除用户。
          </p>
        ) : null}
        {deleteTarget && deleteTarget.children.length > 0 ? (
          <p className="mt-2 text-xs text-rose-600">
            该部门下仍有 {deleteTarget.children.length} 个直属子部门，请先处理子部门。
          </p>
        ) : null}
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function DepartmentFormModal({
  open,
  editing,
  presetParentId,
  flat,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: DepartmentNode | null
  presetParentId: number | null
  flat: FlatDept[]
  onClose: () => void
  onSaved: (tip: string) => void
}) {
  return (
    <Modal
      open={open}
      widthClass="max-w-md"
      title={editing ? '编辑部门' : '新增部门'}
      onClose={onClose}
    >
      <DepartmentForm
        key={editing ? `edit-${editing.id}` : `create-${presetParentId ?? 'root'}-${open ? 1 : 0}`}
        editing={editing}
        presetParentId={presetParentId}
        flat={flat}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  )
}

function DepartmentForm({
  editing,
  presetParentId,
  flat,
  onClose,
  onSaved,
}: {
  editing: DepartmentNode | null
  presetParentId: number | null
  flat: FlatDept[]
  onClose: () => void
  onSaved: (tip: string) => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [code, setCode] = useState(editing?.code ?? '')
  const [parentId, setParentId] = useState<string>(presetParentId ? String(presetParentId) : '')
  const [sortOrder, setSortOrder] = useState(String(editing?.sort_order ?? 0))
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 不能把部门挂到自身或自己的后代下
  const blockedIds = editing ? new Set(collectIds(editing)) : new Set<number>()

  const submit = async () => {
    if (!name.trim() || !code.trim()) {
      setError('部门名称与编码都不能为空')
      return
    }
    setSaving(true)
    setError(null)
    const payload = {
      name: name.trim(),
      code: code.trim(),
      parent_id: parentId ? Number(parentId) : null,
      sort_order: Number(sortOrder) || 0,
      enabled,
    }
    try {
      if (editing) {
        await api.put(`/departments/${editing.id}`, payload)
        onSaved(`部门「${payload.name}」已更新`)
      } else {
        await api.post('/departments', payload)
        onSaved(`部门「${payload.name}」已创建`)
      }
    } catch (err) {
      setError(errorMessage(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Field label="部门名称" required>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：财务部" />
      </Field>
      <Field label="部门编码" required hint="编码需全局唯一，创建后不建议修改">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="例如：FIN"
        />
      </Field>
      <Field label="上级部门" hint="选择「顶级部门」即作为一级部门">
        <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">顶级部门</option>
          {flat
            .filter(({ node }) => !blockedIds.has(node.id))
            .map(({ node, depth }) => (
              <option key={node.id} value={node.id}>
                {'　'.repeat(depth)}
                {node.name}（{node.code}）
              </option>
            ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="排序号" hint="数值越小越靠前">
          <Input
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            inputMode="numeric"
          />
        </Field>
        <Field label="启用状态">
          <Select value={enabled ? '1' : '0'} onChange={(e) => setEnabled(e.target.value === '1')}>
            <option value="1">启用</option>
            <option value="0">停用</option>
          </Select>
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button onClick={onClose} disabled={saving}>
          取消
        </Button>
        <Button variant="primary" onClick={submit} loading={saving}>
          保存
        </Button>
      </div>
    </div>
  )
}
