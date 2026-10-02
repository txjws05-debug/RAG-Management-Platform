'use client'

/** 角色功能权限面板：角色增删改 + 权限树勾选（父节点联动子节点，保存为扁平 permission_codes）。 */
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
  Switch,
  TextArea,
  cn,
  useNotice,
} from '@/components/ui/kit'
import type { PermissionNode, RoleDetail } from './types'

export interface RolesPanelProps {
  can: (code: string) => boolean
}

function collectCodes(node: PermissionNode): string[] {
  return [node.code, ...node.children.flatMap(collectCodes)]
}

function countLeaves(node: PermissionNode): number {
  if (node.children.length === 0) return 1
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0)
}

export default function RolesPanel({ can }: RolesPanelProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<RoleDetail | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RoleDetail | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const { push, node: noticeNode } = useNotice(6000)

  const canManage = can('system:manage')

  const { data: roles, error, isLoading, mutate } = useSWR('/roles', () =>
    api.get<RoleDetail[]>('/roles'),
  )

  const { data: tree, isLoading: treeLoading } = useSWR('/permissions/tree', () =>
    api.get<PermissionNode[]>('/permissions/tree'),
  )

  const toggleEnabled = async (role: RoleDetail, enabled: boolean) => {
    setBusyId(role.id)
    try {
      await api.put(`/roles/${role.id}`, { enabled })
      push('success', `角色「${role.name}」已${enabled ? '启用' : '停用'}`)
      await mutate()
    } catch (err) {
      push('error', errorMessage(err, '更新失败'))
    } finally {
      setBusyId(null)
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    const role = deleteTarget
    setBusyId(role.id)
    try {
      await api.delete(`/roles/${role.id}`)
      push('success', `角色「${role.name}」已删除`)
      setDeleteTarget(null)
      await mutate()
    } catch (err) {
      push('error', errorMessage(err, '删除失败'))
      setDeleteTarget(null)
    } finally {
      setBusyId(null)
    }
  }

  const permissionTotal = useMemo(
    () => (tree ?? []).reduce((sum, node) => sum + collectCodes(node).length, 0),
    [tree],
  )

  return (
    <div className="space-y-4">
      {noticeNode}

      <Card
        title="角色与功能权限"
        description="权限树勾选后保存为扁平 permission_codes 数组；勾选父节点会联动其全部子节点"
        bodyClassName="space-y-3"
        actions={
          <>
            <Button size="sm" onClick={() => void mutate()}>
              刷新
            </Button>
            {canManage ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setEditing(null)
                  setFormOpen(true)
                }}
              >
                新增角色
              </Button>
            ) : null}
          </>
        }
      >
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Spinner /> 正在加载角色…
          </div>
        ) : null}
        {error ? <ErrorNote>{errorMessage(error, '角色加载失败')}</ErrorNote> : null}

        {roles && roles.length === 0 && !isLoading ? (
          <EmptyState title="暂无角色" description="可新增角色并勾选功能权限" />
        ) : null}

        {(roles ?? []).length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-400">
              权限点共 {permissionTotal} 个（含菜单级与操作级）
            </p>
            {(roles ?? []).map((role) => (
              <div
                key={role.id}
                className={cn(
                  'rounded-xl border border-slate-200 bg-white px-4 py-3',
                  !role.enabled && 'opacity-60',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-semibold text-slate-800">{role.name}</h4>
                      <span className="font-mono text-xs text-slate-400">{role.code}</span>
                      {role.is_builtin ? <Badge tone="violet">内置角色</Badge> : null}
                      <Badge tone={role.enabled ? 'emerald' : 'slate'}>
                        {role.enabled ? '启用中' : '已停用'}
                      </Badge>
                      <Badge tone="indigo">{role.permission_codes.length} 个权限点</Badge>
                    </div>
                    {role.description ? (
                      <p className="mt-1 text-xs text-slate-500">{role.description}</p>
                    ) : null}
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Switch
                        checked={role.enabled}
                        disabled={busyId === role.id}
                        title={role.enabled ? '停用角色' : '启用角色'}
                        onChange={(next) => void toggleEnabled(role, next)}
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          setEditing(role)
                          setFormOpen(true)
                        }}
                      >
                        编辑权限
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={role.is_builtin}
                        title={role.is_builtin ? '内置角色不允许删除' : '删除角色'}
                        onClick={() => setDeleteTarget(role)}
                      >
                        删除
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {role.permission_codes.length > 0 ? (
                    role.permission_codes.map((code) => (
                      <Badge key={`${role.id}-${code}`} tone="slate">
                        {code}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-slate-400">未分配任何权限点</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <RoleFormModal
        open={formOpen}
        editing={editing}
        tree={tree ?? []}
        treeLoading={treeLoading}
        onClose={() => setFormOpen(false)}
        onSaved={async (tip) => {
          push('success', tip)
          setFormOpen(false)
          await mutate()
        }}
      />

      <Modal
        open={deleteTarget !== null}
        title="删除角色"
        widthClass="max-w-md"
        description="内置角色不允许删除；若仍有用户绑定该角色，后端会拒绝删除。"
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
          确定删除角色
          <span className="mx-1 font-medium text-slate-800">「{deleteTarget?.name}」</span>
          （{deleteTarget?.code}）吗？
        </p>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 权限树                                                              */
/* ------------------------------------------------------------------ */

function PermissionTreeItem({
  node,
  selected,
  onCommit,
  depth,
}: {
  node: PermissionNode
  selected: Set<string>
  onCommit: (next: Set<string>) => void
  depth: number
}) {
  const [open, setOpen] = useState(true)
  const codes = useMemo(() => collectCodes(node), [node])
  const checkedCount = codes.filter((code) => selected.has(code)).length
  const checked = checkedCount === codes.length && codes.length > 0
  const indeterminate = checkedCount > 0 && !checked

  const toggle = (next: boolean) => {
    const draft = new Set(selected)
    for (const code of codes) {
      if (next) draft.add(code)
      else draft.delete(code)
    }
    onCommit(draft)
  }

  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-slate-50"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="w-4 shrink-0 text-xs text-slate-400 hover:text-slate-600"
            aria-label={open ? '折叠' : '展开'}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-2 focus:ring-indigo-200"
            checked={checked}
            ref={(el) => {
              if (el) el.indeterminate = indeterminate
            }}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span className="truncate text-sm text-slate-700">{node.name}</span>
          <span className="shrink-0 font-mono text-xs text-slate-400">{node.code}</span>
          {node.kind === 'menu' ? (
            <Badge tone="sky" className="shrink-0">
              菜单
            </Badge>
          ) : (
            <Badge tone="slate" className="shrink-0">
              操作
            </Badge>
          )}
          {node.children.length > 0 ? (
            <span className="shrink-0 text-xs text-slate-400">{countLeaves(node)} 项</span>
          ) : null}
        </label>
      </div>
      {open
        ? node.children.map((child) => (
            <PermissionTreeItem
              key={child.code}
              node={child}
              selected={selected}
              onCommit={onCommit}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 角色表单                                                            */
/* ------------------------------------------------------------------ */

function RoleFormModal({
  open,
  editing,
  tree,
  treeLoading,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: RoleDetail | null
  tree: PermissionNode[]
  treeLoading: boolean
  onClose: () => void
  onSaved: (tip: string) => void
}) {
  return (
    <Modal
      open={open}
      widthClass="max-w-3xl"
      title={editing ? `编辑角色 · ${editing.name}` : '新增角色'}
      description="勾选功能权限点：父节点勾选会联动全部子节点，保存为扁平 permission_codes"
      onClose={onClose}
    >
      <RoleForm
        key={editing ? `edit-${editing.id}` : `create-${open ? 1 : 0}`}
        editing={editing}
        tree={tree}
        treeLoading={treeLoading}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  )
}

function RoleForm({
  editing,
  tree,
  treeLoading,
  onClose,
  onSaved,
}: {
  editing: RoleDetail | null
  tree: PermissionNode[]
  treeLoading: boolean
  onClose: () => void
  onSaved: (tip: string) => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [code, setCode] = useState(editing?.code ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [selected, setSelected] = useState<Set<string>>(new Set(editing?.permission_codes ?? []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allCodes = useMemo(() => tree.flatMap(collectCodes), [tree])

  const submit = async () => {
    setError(null)
    if (!name.trim()) {
      setError('角色名称不能为空')
      return
    }
    if (!editing && !code.trim()) {
      setError('角色编码不能为空')
      return
    }
    setSaving(true)
    const permissionCodes = allCodes.filter((item) => selected.has(item))
    try {
      if (editing) {
        await api.put(`/roles/${editing.id}`, {
          name: name.trim(),
          description: description.trim() || null,
          enabled,
          permission_codes: permissionCodes,
        })
        onSaved(`角色「${name.trim()}」已更新，共 ${permissionCodes.length} 个权限点`)
      } else {
        await api.post('/roles', {
          name: name.trim(),
          code: code.trim(),
          description: description.trim() || null,
          enabled,
          permission_codes: permissionCodes,
        })
        onSaved(`角色「${name.trim()}」已创建，共 ${permissionCodes.length} 个权限点`)
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="角色名称" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：知识管理员" />
        </Field>
        <Field label="角色编码" required hint={editing ? '编码创建后不可修改' : '全局唯一，例如 knowledge_admin'}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={Boolean(editing)}
            placeholder="例如：knowledge_admin"
          />
        </Field>
      </div>
      <Field label="角色描述">
        <TextArea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="说明该角色的职责范围"
          className="min-h-[60px]"
        />
      </Field>
      <Field label="启用状态">
        <Select value={enabled ? '1' : '0'} onChange={(e) => setEnabled(e.target.value === '1')}>
          <option value="1">启用</option>
          <option value="0">停用</option>
        </Select>
      </Field>

      <Field
        label="功能权限树"
        hint={`已选 ${selected.size} / ${allCodes.length} 个权限点（含自动联动的父节点）`}
      >
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/50 px-2 py-2">
          {treeLoading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-slate-500">
              <Spinner className="h-3.5 w-3.5" /> 正在加载权限树…
            </div>
          ) : tree.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-400">暂无权限点数据</p>
          ) : (
            tree.map((node) => (
              <PermissionTreeItem
                key={node.code}
                node={node}
                selected={selected}
                onCommit={setSelected}
                depth={0}
              />
            ))
          )}
        </div>
      </Field>

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
