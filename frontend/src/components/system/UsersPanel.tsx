'use client'

/** 用户账号面板：搜索、分页、新增/编辑、分配部门与角色、禁用。 */
import { useState } from 'react'
import useSWR from 'swr'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
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
  cn,
  formatDateTime,
  formatNumber,
  useDebounced,
  useNotice,
} from '@/components/ui/kit'
import type { DepartmentNode, RoleDetail, UserPage, UserRow } from './types'

const PAGE_SIZE = 20

export interface UsersPanelProps {
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

export default function UsersPanel({ can }: UsersPanelProps) {
  const { user: currentUser } = useAuth()
  const [keyword, setKeyword] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [disableTarget, setDisableTarget] = useState<UserRow | null>(null)
  const [busy, setBusy] = useState(false)
  const debouncedKeyword = useDebounced(keyword, 400)
  const { push, node: noticeNode } = useNotice(6000)

  const canManage = can('system:manage')

  const { data, error, isLoading, mutate } = useSWR(
    ['/users', debouncedKeyword, departmentId, page],
    () =>
      api.get<UserPage>('/users', {
        keyword: debouncedKeyword.trim() || undefined,
        department_id: departmentId ? Number(departmentId) : undefined,
        page,
        page_size: PAGE_SIZE,
      }),
    { keepPreviousData: true },
  )

  const { data: tree } = useSWR('/departments/tree', () => api.get<DepartmentNode[]>('/departments/tree'))
  const { data: roles } = useSWR('/roles', () => api.get<RoleDetail[]>('/roles'))

  const deptOptions = flatten(tree ?? [])

  const doDisable = async () => {
    if (!disableTarget) return
    const target = disableTarget
    setBusy(true)
    try {
      await api.delete(`/users/${target.id}`)
      push('success', `账号「${target.username}」已禁用`)
      setDisableTarget(null)
      await mutate()
    } catch (err) {
      push('error', errorMessage(err, '禁用失败'))
      setDisableTarget(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {noticeNode}

      <Card
        title="用户账号"
        description="账号需分配部门与角色；角色决定功能权限，部门决定知识单元的数据权限"
        bodyClassName="space-y-3"
        actions={
          <>
            <Input
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value)
                setPage(1)
              }}
              placeholder="搜索用户名或姓名"
              className="h-8 w-48 text-xs"
            />
            <Select
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value)
                setPage(1)
              }}
              className="h-8 text-xs"
            >
              <option value="">全部部门</option>
              {deptOptions.map(({ node, depth }) => (
                <option key={node.id} value={node.id}>
                  {'　'.repeat(depth)}
                  {node.name}
                </option>
              ))}
            </Select>
            {canManage ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setEditing(null)
                  setFormOpen(true)
                }}
              >
                新增用户
              </Button>
            ) : null}
          </>
        }
      >
        {isLoading && !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Spinner /> 正在加载用户…
          </div>
        ) : null}
        {error ? <ErrorNote>{errorMessage(error, '用户列表加载失败')}</ErrorNote> : null}

        {data && data.items.length === 0 && !isLoading ? (
          <EmptyState title="没有匹配的用户" description="可调整搜索条件或新增账号" />
        ) : null}

        {(data?.items ?? []).length > 0 ? (
          <>
            <TableWrap minWidthClass="min-w-[980px]">
              <thead>
                <tr>
                  <Th className="w-[90px]">ID</Th>
                  <Th>账号</Th>
                  <Th className="w-[150px]">姓名</Th>
                  <Th className="w-[150px]">所属部门</Th>
                  <Th>角色</Th>
                  <Th className="w-[90px]">状态</Th>
                  <Th className="w-[140px]">创建时间</Th>
                  <Th className="w-[140px]">操作</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((u) => {
                  const isSelf = currentUser?.id === u.id
                  return (
                    <tr key={u.id} className={cn('hover:bg-slate-50/70', !u.enabled && 'opacity-60')}>
                      <Td className="text-xs text-slate-500">{u.id}</Td>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-800">{u.username}</span>
                          {u.is_superuser ? <Badge tone="violet">超级管理员</Badge> : null}
                          {isSelf ? <Badge tone="sky">当前账号</Badge> : null}
                        </div>
                        {u.email ? (
                          <p className="mt-0.5 text-xs text-slate-400">{u.email}</p>
                        ) : null}
                      </Td>
                      <Td className="text-sm text-slate-700">{u.display_name}</Td>
                      <Td className="text-xs text-slate-600">
                        {u.department ? (
                          <>
                            {u.department.name}
                            <span className="ml-1 text-slate-400">{u.department.code}</span>
                          </>
                        ) : (
                          <span className="text-slate-400">未分配</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {u.roles.length > 0 ? (
                            u.roles.map((r) => (
                              <Badge key={`${u.id}-${r.id}`} tone="indigo">
                                {r.name}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-xs text-slate-400">无角色</span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={u.enabled ? 'emerald' : 'rose'}>
                          {u.enabled ? '正常' : '已禁用'}
                        </Badge>
                      </Td>
                      <Td className="text-xs text-slate-500">{formatDateTime(u.created_at)}</Td>
                      <Td>
                        {canManage ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => {
                                setEditing(u)
                                setFormOpen(true)
                              }}
                            >
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={!u.enabled || u.is_superuser || isSelf}
                              title={
                                u.is_superuser
                                  ? '超级管理员账号不允许删除'
                                  : isSelf
                                    ? '不能删除当前登录账号'
                                    : '禁用该账号'
                              }
                              onClick={() => setDisableTarget(u)}
                            >
                              禁用
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">只读</span>
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

      <UserFormModal
        open={formOpen}
        editing={editing}
        deptOptions={deptOptions}
        roles={roles ?? []}
        onClose={() => setFormOpen(false)}
        onSaved={async (tip) => {
          push('success', tip)
          setFormOpen(false)
          await mutate()
        }}
      />

      <Modal
        open={disableTarget !== null}
        title="禁用账号"
        widthClass="max-w-md"
        description="禁用后该账号将无法登录，历史数据保留。"
        onClose={() => setDisableTarget(null)}
        footer={
          <>
            <Button onClick={() => setDisableTarget(null)}>取消</Button>
            <Button variant="primary" loading={busy} onClick={doDisable}>
              确认禁用
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          确定禁用账号
          <span className="mx-1 font-medium text-slate-800">「{disableTarget?.username}」</span>
          （{disableTarget?.display_name}）吗？
        </p>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function UserFormModal({
  open,
  editing,
  deptOptions,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: UserRow | null
  deptOptions: FlatDept[]
  roles: RoleDetail[]
  onClose: () => void
  onSaved: (tip: string) => void
}) {
  return (
    <Modal
      open={open}
      widthClass="max-w-xl"
      title={editing ? `编辑用户 · ${editing.username}` : '新增用户'}
      description="角色决定功能权限，部门参与四维数据权限判定"
      onClose={onClose}
    >
      <UserForm
        key={editing ? `edit-${editing.id}` : `create-${open ? 1 : 0}`}
        editing={editing}
        deptOptions={deptOptions}
        roles={roles}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  )
}

function UserForm({
  editing,
  deptOptions,
  roles,
  onClose,
  onSaved,
}: {
  editing: UserRow | null
  deptOptions: FlatDept[]
  roles: RoleDetail[]
  onClose: () => void
  onSaved: (tip: string) => void
}) {
  const [username, setUsername] = useState(editing?.username ?? '')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState(editing?.display_name ?? '')
  const [email, setEmail] = useState(editing?.email ?? '')
  const [departmentId, setDepartmentId] = useState(
    editing?.department ? String(editing.department.id) : '',
  )
  const [roleIds, setRoleIds] = useState<number[]>(editing ? editing.roles.map((r) => r.id) : [])
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleRole = (id: number, on: boolean) => {
    setRoleIds((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)))
  }

  const submit = async () => {
    setError(null)
    if (!editing) {
      if (username.trim().length < 2) {
        setError('用户名至少 2 个字符')
        return
      }
      if (password.length < 6) {
        setError('密码至少 6 位')
        return
      }
    } else if (password && password.length < 6) {
      setError('新密码至少 6 位')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        const payload: Record<string, unknown> = {
          display_name: displayName.trim() || undefined,
          email: email.trim() || null,
          department_id: departmentId ? Number(departmentId) : null,
          role_ids: roleIds,
          enabled,
        }
        if (password) payload.password = password
        await api.put(`/users/${editing.id}`, payload)
        onSaved(`用户「${editing.username}」已更新`)
      } else {
        await api.post('/users', {
          username: username.trim(),
          password,
          display_name: displayName.trim() || username.trim(),
          email: email.trim() || null,
          department_id: departmentId ? Number(departmentId) : null,
          role_ids: roleIds,
          enabled,
        })
        onSaved(`用户「${username.trim()}」已创建`)
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
        <Field label="用户名" required hint={editing ? '用户名创建后不可修改' : '登录账号，至少 2 个字符'}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={Boolean(editing)}
            placeholder="例如：finance01"
          />
        </Field>
        <Field
          label={editing ? '重置密码（可选）' : '初始密码'}
          required={!editing}
          hint={editing ? '留空表示不修改密码' : '至少 6 位'}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={editing ? '不修改请留空' : '至少 6 位'}
            autoComplete="new-password"
          />
        </Field>
        <Field label="显示姓名">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例如：财务专员·小李"
          />
        </Field>
        <Field label="邮箱">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
          />
        </Field>
        <Field label="所属部门" hint="不选择表示不分配部门">
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">未分配</option>
            {deptOptions.map(({ node, depth }) => (
              <option key={node.id} value={node.id}>
                {'　'.repeat(depth)}
                {node.name}（{node.code}）
              </option>
            ))}
          </Select>
        </Field>
        <Field label="账号状态">
          <Select value={enabled ? '1' : '0'} onChange={(e) => setEnabled(e.target.value === '1')}>
            <option value="1">正常</option>
            <option value="0">禁用</option>
          </Select>
        </Field>
      </div>

      <Field label="分配角色" hint={`已选 ${roleIds.length} 个角色`}>
        <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
          {roles.map((role) => (
            <label
              key={role.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                checked={roleIds.includes(role.id)}
                onChange={(e) => toggleRole(role.id, e.target.checked)}
              />
              <span className="text-sm text-slate-700">{role.name}</span>
              <span className="text-xs text-slate-400">{role.code}</span>
            </label>
          ))}
          {roles.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-slate-400">暂无可用角色</p>
          ) : null}
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
