'use client'

/** 组织架构与系统配置：部门树 / 用户账号 / 角色功能权限树 / 模型配置。 */
import { useState } from 'react'
import { useAuth } from '@/lib/auth'
import { InfoNote, cn } from '@/components/ui/kit'
import DepartmentPanel from '@/components/system/DepartmentPanel'
import UsersPanel from '@/components/system/UsersPanel'
import RolesPanel from '@/components/system/RolesPanel'
import ModelConfigPanel from '@/components/system/ModelConfigPanel'

type TabKey = 'departments' | 'users' | 'roles' | 'model'

const TABS: { key: TabKey; label: string; description: string }[] = [
  { key: 'departments', label: '组织架构', description: '部门树维护与人数统计' },
  { key: 'users', label: '用户账号', description: '账号、部门与角色分配' },
  { key: 'roles', label: '角色功能权限', description: '权限树勾选与角色维护' },
  { key: 'model', label: '模型接口配置', description: 'LLM / 向量模型只读参数' },
]

export default function SystemPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState<TabKey>('departments')

  const canManageSystem = can('system:manage')

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-slate-800">组织架构与系统配置</h1>
        <p className="mt-1 text-sm text-slate-500">
          维护部门树、用户账号、角色功能权限与底层模型接口参数；部门与角色会直接参与知识单元的四维数据权限判定。
        </p>
      </header>

      {!canManageSystem ? (
        <InfoNote>
          当前账号没有「system:manage」权限码，本页为只读视图（部门树仍可查看，用于权限选择器）。
        </InfoNote>
      ) : null}

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

      {tab === 'departments' ? <DepartmentPanel can={can} /> : null}
      {tab === 'users' ? <UsersPanel can={can} /> : null}
      {tab === 'roles' ? <RolesPanel can={can} /> : null}
      {tab === 'model' ? <ModelConfigPanel /> : null}
    </div>
  )
}
