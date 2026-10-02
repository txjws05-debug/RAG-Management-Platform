/** 知识沉淀与运营：API 响应类型定义。 */

export type CandidateStatus = 'pending' | 'approved' | 'rejected'
export type GapStatus = 'open' | 'task_created' | 'resolved'

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface MiningResult {
  scanned_questions: number
  clusters: number
  new_candidates: number
  updated_candidates: number
  new_gaps: number
  message: string
}

export interface FaqCandidate {
  id: number
  canonical_question: string
  sample_questions: string[]
  frequency: number
  suggested_answer: string | null
  confidence: number
  status: CandidateStatus | string
  related_documents: string[]
  created_at: string | null
}

export interface FaqCacheStats {
  enabled: boolean
  cached_entries: number
  loaded_at: string | null
  version: number
  match_threshold: number
}

export interface FaqEntry {
  id: number
  question: string
  answer: string
  category: string
  enabled: boolean
  cache_enabled: boolean
  hit_count: number
  published_at: string | null
}

export interface FaqEntryPage extends Paged<FaqEntry> {
  cache: FaqCacheStats
}

export interface FaqReviewResult {
  id: number
  status: string
  faq_entry_id?: number
  cache?: FaqCacheStats
}

export interface KnowledgeGap {
  id: number
  question_text: string
  department_name: string | null
  frequency: number
  max_similarity: number
  suggested_category: string
  status: GapStatus | string
  last_seen_at: string | null
  task_note: string | null
}

export interface MiningConfig {
  cluster_similarity: number
  min_frequency: number
  cache_enabled: boolean
  cache_ttl_seconds: number
  confidence_threshold: number
}

export interface GapTaskResult {
  id: number
  status: string
  task_note: string
}
