/** 知识维护与导入中心：API 响应类型定义。 */

export type DocumentStatus = 'pending' | 'parsing' | 'ready' | 'failed'
export type GrantScope = 'global' | 'department' | 'role' | 'user'

export interface GrantView {
  scope: GrantScope
  subject_id: number
  subject_name: string
}

export interface DocumentRow {
  id: number
  code: string
  title: string
  file_type: string
  category: string
  status: DocumentStatus
  enabled: boolean
  chunk_count: number
  char_count: number
  file_size: number
  error_message: string | null
  created_at: string | null
  updated_at: string | null
  grants: GrantView[]
  grant_summary: string
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface DocumentQuery {
  keyword?: string
  category?: string
  file_type?: string
  status?: string
  page: number
  page_size: number
  [key: string]: string | number | boolean | null | undefined
}

export interface CategoryCount {
  name: string
  count: number
}

export interface UploadResult {
  id: number
  title: string
  file_type: string
  status: DocumentStatus
  chunk_count: number
  char_count: number
  message: string
}

export interface BatchUploadResult {
  accepted: UploadResult[]
  failed: { filename: string; message: string }[]
  accepted_count: number
  failed_count: number
}

export interface ChunkRow {
  id: number
  ordinal: number
  content: string
  char_count: number
}

export interface GrantDetail {
  scope: GrantScope
  subject_id: number
  subject_name: string
}

export interface GrantConfigView {
  global_public: boolean
  department_ids: number[]
  role_ids: number[]
  user_ids: number[]
  details: GrantDetail[]
}

export interface GrantSaveResult {
  document_id: number
  grant_count: number
  grant_summary: string
  updated_at: string
}

/* ---- 权限选择器所需的组织数据（/departments/tree 所有登录用户可读） ---- */

export interface DepartmentNode {
  id: number
  name: string
  code: string
  parent_id: number | null
  sort_order: number
  enabled: boolean
  user_count: number
  children: DepartmentNode[]
}

export interface RoleOption {
  id: number
  name: string
  code: string
  description?: string | null
  enabled?: boolean
  is_builtin?: boolean
  permission_codes?: string[]
}

export interface UserOption {
  id: number
  username: string
  display_name: string
  email: string | null
  department: { id: number; name: string; code: string } | null
  roles: { id: number; name: string; code: string }[]
  enabled: boolean
  is_superuser: boolean
  created_at: string | null
}
