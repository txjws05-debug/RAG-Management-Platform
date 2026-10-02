/** 组织架构与系统配置：API 响应类型定义。 */

export type PermissionKind = 'menu' | 'operation'

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

export interface PermissionNode {
  code: string
  name: string
  kind: PermissionKind | string
  parent_code: string | null
  children: PermissionNode[]
}

export interface RoleDetail {
  id: number
  name: string
  code: string
  description: string | null
  enabled: boolean
  is_builtin: boolean
  permission_codes: string[]
}

export interface RoleBrief {
  id: number
  name: string
  code: string
}

export interface DepartmentBrief {
  id: number
  name: string
  code: string
}

export interface UserRow {
  id: number
  username: string
  display_name: string
  email: string | null
  department: DepartmentBrief | null
  roles: RoleBrief[]
  enabled: boolean
  is_superuser: boolean
  created_at: string | null
}

export interface UserPage {
  items: UserRow[]
  total: number
  page: number
  page_size: number
}

export interface ModelConfig {
  llm_base_url: string
  llm_chat_model: string
  llm_temperature: number
  llm_max_tokens: number
  llm_key_configured: boolean
  embedding_base_url: string
  embedding_model: string
  embedding_dim: number
  embedding_key_configured: boolean
  embedding_mode: string
  retrieve_top_k: number
  confidence_threshold: number
  faq_cache_enabled: boolean
  faq_min_frequency: number
  chunk_size: number
  chunk_overlap: number
}

export interface PermissionsCatalog {
  menus: { code: string; name: string; permission: string }[]
  operations: { code: string; name: string }[]
}
