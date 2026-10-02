'use client'

/**
 * 四维数据权限分配弹窗：全局公开 / 部门树多选 / 角色多选 / 人员多选。
 * 满足任意一个权限实体即可访问（OR 逻辑）。
 */
import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { api } from '@/lib/api'
import {
  Badge,
  Button,
  Checkbox,
  ErrorNote,
  Field,
  InfoNote,
  Input,
  Modal,
  Spinner,
  cn,
  errText,
  useNotice,
} from '@/components/ui/kit'
import type {
  DepartmentNode,
  GrantConfigView,
  GrantSaveResult,
  Paged,
  RoleOption,
  UserOption,
} from './types'

interface Props {
  open: boolean
  documentId: number | null
  documentTitle?: string
  onClose: () => void
  /** 保存成功后回调（用于刷新台账列表） */
  onSaved?: (result: GrantSaveResult) => void
}

/* ---------------- 部门树 ---------------- */

function collectIds(node: DepartmentNode): number[] {
  return [node.id, ...node.children.flatMap(collectIds)]
}

function TreeCheckbox({
  node,
  selected,
  onCommit,
  depth,
}: {
  node: DepartmentNode
  selected: Set<number>
  onCommit: (next: Set<number>) => void
  depth: number
}) {
  const [open, setOpen] = useState(true)
  const ids = useMemo(() => collectIds(node), [node])
  const checkedCount = ids.filter((id) => selected.has(id)).length
  const checked = checkedCount === ids.length && ids.length > 0
  const indeterminate = checkedCount > 0 && !checked

  const toggle = (next: boolean) => {
    const draft = new Set(selected)
    for (const id of ids) {
      if (next) draft.add(id)
      else draft.delete(id)
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
          <span className="shrink-0 text-xs text-slate-400">{node.code}</span>
          <span className="shrink-0 text-xs text-slate-400">（{node.user_count} 人）</span>
          {!node.enabled ? (
            <Badge tone="slate" className="shrink-0">
              已停用
            </Badge>
          ) : null}
        </label>
      </div>
      {open
        ? node.children.map((child) => (
            <TreeCheckbox
              key={child.id}
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

/* ---------------- 主体 ---------------- */

export default function GrantDialog({
  open,
  documentId,
  documentTitle,
  onClose,
  onSaved,
}: Props) {
  const [globalPublic, setGlobalPublic] = useState(false)
  const [deptIds, setDeptIds] = useState<Set<number>>(new Set())
  const [roleIds, setRoleIds] = useState<Set<number>>(new Set())
  const [userIds, setUserIds] = useState<Set<number>>(new Set())
  const [userKeyword, setUserKeyword] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { push, node: noticeNode } = useNotice()

  const { data: tree, isLoading: treeLoading } = useSWR(
    open ? '/departments/tree' : null,
    () => api.get<DepartmentNode[]>('/departments/tree'),
  )
  const { data: roles, isLoading: rolesLoading } = useSWR(open ? '/roles' : null, () =>
    api.get<RoleOption[]>('/roles'),
  )
  const { data: users, isLoading: usersLoading } = useSWR(
    open ? ['/users', 'grant-picker'] : null,
    () => api.get<Paged<UserOption>>('/users', { page: 1, page_size: 200 }),
  )

  const { data: grants, isLoading: grantsLoading, mutate: mutateGrants } = useSWR(
    open && documentId ? ['/knowledge/documents/grants', documentId] : null,
    () => api.get<GrantConfigView>(`/knowledge/documents/${documentId}/grants`),
  )

  // 载入已有权限
  useEffect(() => {
    if (!open) return
    setLoadError(null)
    setUserKeyword('')
  }, [open, documentId])

  useEffect(() => {
    if (!grants) return
    setGlobalPublic(grants.global_public)
    setDeptIds(new Set(grants.department_ids))
    setRoleIds(new Set(grants.role_ids))
    setUserIds(new Set(grants.user_ids))
  }, [grants])

  const loading = treeLoading || rolesLoading || usersLoading || grantsLoading

  const filteredUsers = useMemo(() => {
    const list = users?.items ?? []
    const kw = userKeyword.trim().toLowerCase()
    if (!kw) return list
    return list.filter(
      (u) =>
        u.username.toLowerCase().includes(kw) ||
        u.display_name.toLowerCase().includes(kw) ||
        (u.department?.name ?? '').toLowerCase().includes(kw),
    )
  }, [users, userKeyword])

  const toggleIn = (set: Set<number>, id: number, on: boolean) => {
    const draft = new Set(set)
    if (on) draft.add(id)
    else draft.delete(id)
    return draft
  }

  const totalSelected = deptIds.size + roleIds.size + userIds.size + (globalPublic ? 1 : 0)

  const save = async () => {
    if (!documentId) return
    setSaving(true)
    setLoadError(null)
    try {
      const result = await api.put<GrantSaveResult>(
        `/knowledge/documents/${documentId}/grants`,
        {
          global_public: globalPublic,
          department_ids: Array.from(deptIds),
          role_ids: Array.from(roleIds),
          user_ids: Array.from(userIds),
        },
      )
      push(
        'success',
        `权限已保存：共 ${result.grant_count} 条授权（${result.grant_summary}）`,
      )
      await mutateGrants()
      onSaved?.(result)
      onClose()
    } catch (err) {
      setLoadError(errText(err, '权限保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      widthClass="max-w-4xl"
      title={`四维数据权限配置${documentTitle ? ` · ${documentTitle}` : ''}`}
      description="按 全局 / 部门 / 角色 / 人员 四个维度授权，满足任意一个权限实体即可访问（OR 逻辑）"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-slate-500">
            已选择 {totalSelected} 项授权实体
          </span>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={loading}>
            保存权限
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {noticeNode}
        {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}

        <InfoNote>
          满足任意一个权限实体即可访问（OR 逻辑）。<strong>默认状态下知识单元无任何公开访问权限</strong>
          ，仅管理员可见；如需全员可检索，请打开下方「全局公开」。
        </InfoNote>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Spinner /> 正在加载组织架构与已有权限…
          </div>
        ) : null}

        {/* 全局公开 */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3">
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox
              checked={globalPublic}
              onChange={(e) => setGlobalPublic(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">
                全局公开（所有登录用户可见）
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                打开后该知识单元对所有已登录账号开放检索，不受部门/角色/人员限制。
              </span>
            </span>
          </label>
        </div>

        <div
          className={cn(
            'grid gap-4 md:grid-cols-2',
            globalPublic && 'pointer-events-none opacity-60',
          )}
        >
          {/* 部门 */}
          <div className="rounded-lg border border-slate-200">
            <header className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-700">
                按部门 <span className="text-xs font-normal text-slate-400">可多选（含子部门）</span>
              </h4>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">已选 {deptIds.size}</span>
                <button
                  type="button"
                  className="text-indigo-600 hover:underline"
                  onClick={() => setDeptIds(new Set())}
                >
                  清空
                </button>
              </div>
            </header>
            <div className="max-h-64 overflow-y-auto px-2 py-2">
              {tree && tree.length > 0 ? (
                tree.map((node) => (
                  <TreeCheckbox
                    key={node.id}
                    node={node}
                    selected={deptIds}
                    onCommit={setDeptIds}
                    depth={0}
                  />
                ))
              ) : (
                <p className="px-2 py-3 text-xs text-slate-400">暂无部门数据</p>
              )}
            </div>
          </div>

          {/* 角色 */}
          <div className="rounded-lg border border-slate-200">
            <header className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-700">按角色</h4>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">已选 {roleIds.size}</span>
                <button
                  type="button"
                  className="text-indigo-600 hover:underline"
                  onClick={() => setRoleIds(new Set())}
                >
                  清空
                </button>
              </div>
            </header>
            <div className="max-h-64 space-y-0.5 overflow-y-auto px-3 py-2">
              {(roles ?? []).map((role) => (
                <label
                  key={role.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-slate-50"
                >
                  <Checkbox
                    checked={roleIds.has(role.id)}
                    onChange={(e) => setRoleIds((prev) => toggleIn(prev, role.id, e.target.checked))}
                  />
                  <span className="text-sm text-slate-700">{role.name}</span>
                  <span className="text-xs text-slate-400">{role.code}</span>
                </label>
              ))}
              {!rolesLoading && (roles ?? []).length === 0 ? (
                <p className="px-1 py-3 text-xs text-slate-400">暂无角色数据</p>
              ) : null}
            </div>
          </div>
        </div>

        {/* 人员 */}
        <div
          className={cn('rounded-lg border border-slate-200', globalPublic && 'pointer-events-none opacity-60')}
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
            <h4 className="text-sm font-semibold text-slate-700">按人员</h4>
            <div className="flex items-center gap-2">
              <Input
                value={userKeyword}
                onChange={(e) => setUserKeyword(e.target.value)}
                placeholder="搜索用户名 / 姓名 / 部门"
                className="h-8 w-56 text-xs"
              />
              <span className="text-xs text-slate-400">已选 {userIds.size}</span>
              <button
                type="button"
                className="text-xs text-indigo-600 hover:underline"
                onClick={() => setUserIds(new Set())}
              >
                清空
              </button>
            </div>
          </header>
          <div className="grid max-h-64 gap-0.5 overflow-y-auto px-3 py-2 sm:grid-cols-2 lg:grid-cols-3">
            {filteredUsers.map((u) => (
              <label
                key={u.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-slate-50"
              >
                <Checkbox
                  checked={userIds.has(u.id)}
                  onChange={(e) => setUserIds((prev) => toggleIn(prev, u.id, e.target.checked))}
                />
                <span className="truncate text-sm text-slate-700">{u.display_name}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {u.department?.name ?? '未分配'}
                </span>
              </label>
            ))}
            {!usersLoading && filteredUsers.length === 0 ? (
              <p className="px-1 py-3 text-xs text-slate-400">没有匹配的人员</p>
            ) : null}
          </div>
        </div>

        {/* 当前已有权限明细 */}
        {grants && grants.details.length > 0 ? (
          <Field label="当前授权明细（保存前）">
            <div className="flex flex-wrap gap-1.5">
              {grants.details.map((d) => (
                <Badge
                  key={`${d.scope}-${d.subject_id}`}
                  tone={
                    d.scope === 'global'
                      ? 'violet'
                      : d.scope === 'department'
                        ? 'sky'
                        : d.scope === 'role'
                          ? 'indigo'
                          : 'emerald'
                  }
                >
                  {{ global: '全局', department: '部门', role: '角色', user: '人员' }[d.scope]}·
                  {d.subject_name}
                </Badge>
              ))}
            </div>
          </Field>
        ) : null}
      </div>
    </Modal>
  )
}
