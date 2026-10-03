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
    <div className="space-y-3 sm:space-y-4">
      {noticeNode}

      <Card
        title="用户账号"
        description="账号需分配部门与角色；角色决定功能权限，部门决定知识单元的数据权限"
        bodyClassName="space-y-3"
        actions={
          // 窄屏筛选控件纵向铺满：控件多且含下拉，横排会被压到无法操作
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Input
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value)
                setPage(1)
              }}
              placeholder="搜索用户名或姓名"
              className="h-9 w-full text-sm sm:h-8 sm:w-48 sm:text-xs"
            />
            <Select
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value)
                setPage(1)
              }}
              className="h-9 w-full text-sm sm:h-8 sm:w-auto sm:text-xs"
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
                className="w-full sm:w-auto"
                onClick={() => {
                  setEditing(null)
                  setFormOpen(true)
                }}
              >
                新增用户
              </Button>
            ) : null}
          </div>
        }
      >
        {isLoading && !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Spinner /> 正在加载用户…
          </div>
        ) : null}
        {error ? <ErrorNote>{errorMessage(error, '用户列表加载失败')}</ErrorNote> : null}

        {data && data.items.length === 0 && !isLoading ? (
          <EmptyState title="没有匹配的用户" description="可调整搜索条件或新增账号" />
        ) : null}

        {(data?.items ?? []).length > 0 ? (
          <>
            {/* TableWrap 自带 overflow-x-auto；表格保持 min-w，由外层横向滚动兜住窄屏 */}
            <TableWrap minWidthClass="min-w-[720px] sm:min-w-[980px]">
              <thead>
                <tr>
                  <Th className="w-[70px] px-2 py-2 sm:w-[90px] sm:px-3 sm:py-2.5">ID</Th>
                  <Th className="px-2 py-2 sm:px-3 sm:py-2.5">账号</Th>
                  <Th className="w-[120px] px-2 py-2 sm:w-[150px] sm:px-3 sm:py-2.5">姓名</Th>
                  <Th className="w-[130px] px-2 py-2 sm:w-[150px] sm:px-3 sm:py-2.5">所属部门</Th>
                  <Th className="px-2 py-2 sm:px-3 sm:py-2.5">角色</Th>
                  <Th className="w-[80px] px-2 py-2 sm:w-[90px] sm:px-3 sm:py-2.5">状态</Th>
                  <Th className="w-[130px] px-2 py-2 sm:w-[140px] sm:px-3 sm:py-2.5">创建时间</Th>
                  <Th className="w-[130px] px-2 py-2 sm:w-[140px] sm:px-3 sm:py-2.5">操作</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((u) => {
                  const isSelf = currentUser?.id === u.id
                  return (
                    <tr key={u.id} className={cn('hover:bg-subtle/70', !u.enabled && 'opacity-60')}>
                      <Td className="px-2 py-2 text-xs text-muted sm:px-3 sm:py-2.5">{u.id}</Td>
                      <Td className="px-2 py-2 sm:px-3 sm:py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-strong">{u.username}</span>
                          {u.is_superuser ? <Badge tone="violet">超级管理员</Badge> : null}
                          {isSelf ? <Badge tone="sky">当前账号</Badge> : null}
                        </div>
                        {u.email ? (
                          <p className="mt-0.5 text-xs text-faint">{u.email}</p>
                        ) : null}
                      </Td>
                      <Td className="px-2 py-2 text-sm text-body sm:px-3 sm:py-2.5">
                        {u.display_name}
                      </Td>
                      <Td className="px-2 py-2 text-xs text-body sm:px-3 sm:py-2.5">
                        {u.department ? (
                          <>
                            {u.department.name}
                            <span className="ml-1 text-faint">{u.department.code}</span>
                          </>
                        ) : (
                          <span className="text-faint">未分配</span>
                        )}
                      </Td>
                      <Td className="px-2 py-2 sm:px-3 sm:py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.length > 0 ? (
                            u.roles.map((r) => (
                              <Badge key={`${u.id}-${r.id}`} tone="indigo">
                                {r.name}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-xs text-faint">无角色</span>
                          )}
                        </div>
                      </Td>
                      <Td className="px-2 py-2 sm:px-3 sm:py-2.5">
                        <Badge tone={u.enabled ? 'emerald' : 'rose'}>
                          {u.enabled ? '正常' : '已禁用'}
                        </Badge>
                      </Td>
                      <Td className="px-2 py-2 text-xs text-muted sm:px-3 sm:py-2.5">
                        {formatDateTime(u.created_at)}
                      </Td>
                      <Td className="px-2 py-2 sm:px-3 sm:py-2.5">
                        {canManage ? (
                          // 操作列按钮较多，窄屏折行排列而不是把列撑宽
                          <div className="flex flex-wrap items-center gap-1">
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
        <p className="text-sm text-body">
          确定禁用账号
          <span className="mx-1 font-medium text-strong">「{disableTarget?.username}」</span>
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
        <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-2">
          {roles.map((role) => (
            <label
              key={role.id}
              className="flex min-h-11 sm:min-h-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-subtle"
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line-strong text-indigo-600"
                checked={roleIds.includes(role.id)}
                onChange={(e) => toggleRole(role.id, e.target.checked)}
              />
              <span className="text-sm text-body">{role.name}</span>
              <span className="text-xs text-faint">{role.code}</span>
            </label>
          ))}
          {roles.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-faint">暂无可用角色</p>
          ) : null}
        </div>
      </Field>

      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
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
