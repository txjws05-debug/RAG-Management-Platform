/**
 * 统一 API 客户端。
 *
 * 后端契约（FastAPI，经 Nginx 反代到 `/api`）：
 *   统一响应体 { code: number; message: string; data: T }
 *   - code === 0 视为成功，返回 data
 *   - code !== 0 视为失败，抛出 ApiError(message)（HTTP 401/403 等错误同样是这个包体）
 *
 * 鉴权：localStorage 保存 access_token（key = kb_token），每次请求带
 * `Authorization: Bearer <token>`。后端同时下发 HttpOnly Cookie，但前端不依赖它，
 * 以免跨端口 / 跨域场景丢失登录态。
 */

/* ------------------------------------------------------------------ */
/* 基础常量与 token 存取                                               */
/* ------------------------------------------------------------------ */

/** 浏览器可见的 API 前缀：构建期由 NEXT_PUBLIC_API_BASE 注入，默认同源 /api。 */
export const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? '/api').replace(/\/+$/, '');

/** localStorage key：与需求约定保持一致。 */
export const TOKEN_KEY = 'kb_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 错误类型                                                            */
/* ------------------------------------------------------------------ */

/** 业务/HTTP 错误：message 直接来自后端 message 字段，可直接展示给用户。 */
export class ApiError extends Error {
  readonly code: number;
  readonly status: number;
  readonly path: string;

  constructor(message: string, code = -1, status = 0, path = '') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.path = path;
    // 低版本降级编译时保证 instanceof 仍然成立
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/** 把任意异常转成可展示的中文文案。 */
export function errorMessage(err: unknown, fallback = '请求失败，请稍后重试'): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

/** 401/403 判定，便于调用方决定是否跳转登录页。 */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.code === 40100);
}

/* ------------------------------------------------------------------ */
/* 统一响应体与查询串                                                  */
/* ------------------------------------------------------------------ */

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

function buildUrl(path: string, params?: QueryParams): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

/** 组装请求头（含 Bearer token），FormData 场景不设置 Content-Type。 */
export function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (json) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  params?: QueryParams;
  formData?: FormData;
  signal?: AbortSignal;
  /** 跳过 Authorization（仅登录接口需要）。 */
  anonymous?: boolean;
}

/**
 * 核心请求方法：解析统一响应体，code !== 0 一律抛 ApiError。
 * 注意：即使 HTTP 状态是 401/403/422，后端返回的仍是同一种包体。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, params, formData, signal, anonymous } = options;

  const headers = authHeaders(formData === undefined && body !== undefined);
  if (anonymous) delete headers.Authorization;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, params), {
      method,
      headers,
      signal,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('网络请求失败，请检查网络或后端服务是否可用', -1, 0, path);
  }

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }

  const envelope = parsed as ApiEnvelope<T> | null;
  if (!envelope || typeof envelope.code !== 'number') {
    // 非统一包体（例如 Nginx 502 HTML、SSE 误用等）
    const snippet = raw.slice(0, 120).replace(/\s+/g, ' ');
    throw new ApiError(
      `服务返回了无法解析的内容（HTTP ${response.status}）${snippet ? `：${snippet}` : ''}`,
      -1,
      response.status,
      path,
    );
  }

  if (envelope.code !== 0) {
    if (response.status === 401) clearToken();
    throw new ApiError(envelope.message || '请求失败', envelope.code, response.status, path);
  }

  return envelope.data;
}

/* ------------------------------------------------------------------ */
/* 便捷方法：api.get / post / put / patch / delete / upload            */
/* ------------------------------------------------------------------ */

export const api = {
  /** GET，第二参数为查询串对象（null/undefined/'' 会被忽略）。 */
  get<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<T> {
    return request<T>(path, { method: 'GET', params, signal });
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body });
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'PUT', body });
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body });
  },
  delete<T>(path: string, params?: QueryParams): Promise<T> {
    return request<T>(path, { method: 'DELETE', params });
  },
  /** 文件上传：自动使用 multipart/form-data 并携带 token。 */
  upload<T>(path: string, formData: FormData): Promise<T> {
    return request<T>(path, { method: 'POST', formData });
  },
};

/** SWR 通用 fetcher：`useSWR<Foo>('/path', swrFetcher)`。 */
export function swrFetcher<T>(path: string): Promise<T> {
  return request<T>(path);
}

/** 带查询串的 SWR key 构造（SWR 数组 key 的替代，便于缓存命中）。 */
export function withQuery(path: string, params: QueryParams): string {
  return buildUrl(path, params);
}

/* ------------------------------------------------------------------ */
/* 数据类型：与后端 pydantic schema 一一对应                            */
/* ------------------------------------------------------------------ */

export interface DepartmentBrief {
  id: number;
  name: string;
  code: string;
}

export interface RoleBrief {
  id: number;
  name: string;
  code: string;
}

export interface UserProfile {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  is_superuser: boolean;
  department: DepartmentBrief | null;
  roles: RoleBrief[];
  permissions: string[];
  /**
   * 界面主题偏好，存于服务端以跨设备保持一致。
   * 前端仍会在 localStorage 缓存一份，因为首帧渲染前拿不到接口数据。
   */
  theme_preference?: 'system' | 'light' | 'dark';
}

export interface LoginResult {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: UserProfile;
}

export interface Citation {
  index: number;
  document_id: number;
  document_title: string;
  chunk_id: number;
  ordinal: number;
  score: number;
  snippet: string;
}

/** 回答来源：大模型 / FAQ 缓存直出 / 离线降级。 */
export type AnswerSource = 'llm' | 'faq_cache' | 'offline' | string;

export interface ConversationRow {
  session_key: string;
  title: string;
  message_count: number;
  updated_at: string | null;
}

export interface ChatMessageRow {
  id: number;
  role: 'user' | 'assistant' | string;
  content: string;
  citations?: Citation[];
  restricted_notice?: boolean;
  answer_source?: AnswerSource;
  latency_ms?: number;
  total_tokens?: number;
  top_score?: number;
  created_at?: string | null;
}

export interface ConversationDetail {
  session_key: string;
  title: string;
  messages: ChatMessageRow[];
}

export interface ChatAskRequest {
  question: string;
  session_key?: string | null;
  top_k?: number | null;
  use_faq_cache?: boolean;
}

export interface TrendPoint {
  label: string;
  value: number;
}

/** 访问趋势额外带 uv 字段。 */
export interface VisitTrendPoint extends TrendPoint {
  uv?: number;
}

export interface NamedCount {
  name: string;
  value: number;
}

export interface DashboardOverview {
  pv: number;
  uv: number;
  question_count: number;
  document_count: number;
  chunk_count: number;
  ready_document_count: number;
  faq_count: number;
  faq_cache_hit_rate: number;
  gap_count: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_tokens: number;
  knowledge_coverage: number;
}

export interface DashboardPayload {
  overview: DashboardOverview;
  token_trend: TrendPoint[];
  latency_distribution: TrendPoint[];
  top_questions: NamedCount[];
  top_documents: NamedCount[];
  visit_trend: VisitTrendPoint[];
  department_question_rank: NamedCount[];
}

/* ------------------------------------------------------------------ */
/* 业务接口封装                                                        */
/* ------------------------------------------------------------------ */

export const authApi = {
  login(username: string, password: string): Promise<LoginResult> {
    return request<LoginResult>('/auth/login', {
      method: 'POST',
      body: { username, password },
      anonymous: true,
    });
  },
  me(): Promise<UserProfile> {
    return request<UserProfile>('/auth/me');
  },
  /**
   * 保存界面偏好（当前只有主题）。
   * 与 localStorage 双写：本地那份保证首帧不闪烁，服务端这份保证换设备后仍在。
   */
  savePreferences(themePreference: 'system' | 'light' | 'dark'): Promise<{ theme_preference: string }> {
    return request<{ theme_preference: string }>('/auth/preferences', {
      method: 'PUT',
      body: { theme_preference: themePreference },
    });
  },
  logout(): Promise<{ message: string }> {
    return request<{ message: string }>('/auth/logout', { method: 'POST' });
  },
};

export const chatApi = {
  conversations(): Promise<ConversationRow[]> {
    return request<ConversationRow[]>('/chat/conversations');
  },
  conversation(sessionKey: string): Promise<ConversationDetail> {
    return request<ConversationDetail>(`/chat/conversations/${encodeURIComponent(sessionKey)}`);
  },
  removeConversation(sessionKey: string): Promise<{ session_key: string }> {
    return request<{ session_key: string }>(
      `/chat/conversations/${encodeURIComponent(sessionKey)}`,
      { method: 'DELETE' },
    );
  },
  suggestions(keyword?: string): Promise<string[]> {
    return request<string[]>('/chat/suggestions', {
      params: { keyword: keyword?.trim() ? keyword.trim() : undefined },
    });
  },
};

export const dashboardApi = {
  all(days: number): Promise<DashboardPayload> {
    return request<DashboardPayload>('/dashboard/all', { params: { days } });
  },
};
