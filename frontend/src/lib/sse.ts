/**
 * SSE over fetch 解析器。
 *
 * 为什么不用 EventSource：`/api/chat/ask` 是 POST，且需要携带
 * `Authorization: Bearer <token>` 头，EventSource 两者都不支持。
 *
 * 后端事件（FastAPI StreamingResponse，`event: xxx\ndata: {json}\n\n`）：
 *   meta      会话与用户信息（session_key / conversation_id）
 *   citations 引用溯源数组
 *   restricted 权限受限提示（命中无权查阅的制度文档）
 *   tool      FAQ 缓存命中明细（faq_cache 阶段）
 *   authz     鉴权分流明细（召回 / 放行 / 拦截）
 *   delta     回答增量文本
 *   done      本轮统计（耗时 / token / 来源 / 召回数）
 *   error     生成失败
 *
 * 关键点：event/data 行可能被 TCP/分块切在任意位置，解析器必须缓冲到
 * 完整事件（空行）后再派发。
 */
import {
  API_BASE,
  ApiError,
  authHeaders,
  type AnswerSource,
  type ChatAskRequest,
  type Citation,
} from '@/lib/api';

/* ------------------------------------------------------------------ */
/* 事件载荷类型                                                        */
/* ------------------------------------------------------------------ */

export interface SseMetaPayload {
  session_key: string;
  conversation_id: number;
  user: { id: number; name: string };
}

export interface SseRestrictedPayload {
  blocked_document_count: number;
  blocked_chunk_count: number;
  message: string;
}

export interface SseToolPayload {
  stage: string;
  matched?: boolean;
  similarity?: number;
  faq_entry_id?: number;
}

export interface SseAuthzPayload {
  user_id: number;
  department_id: number | null;
  role_ids: number[];
  recalled_document_ids: number[];
  allowed_document_ids: number[];
  blocked_document_ids: number[];
  recalled_chunk_count: number;
  allowed_chunk_count: number;
  blocked_chunk_count: number;
  top_score: number;
}

export interface SseDonePayload {
  session_key: string;
  message_id: number | null;
  answer_source: AnswerSource;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens: number;
  top_score: number;
  restricted: boolean;
  recalled: number;
  passed: number;
  blocked: number;
  faq_hit_id?: number | null;
  faq_similarity?: number | null;
  /** 大模型调用失败时的原因（离线降级场景）。 */
  llm_error?: string | null;
}

export interface SseDeltaPayload {
  text: string;
}

export interface SseErrorPayload {
  message: string;
}

export interface SseEventMap {
  meta: SseMetaPayload;
  citations: Citation[];
  restricted: SseRestrictedPayload;
  tool: SseToolPayload;
  authz: SseAuthzPayload;
  delta: SseDeltaPayload;
  done: SseDonePayload;
  error: SseErrorPayload;
}

export type SseEventName = keyof SseEventMap;

/**
 * 事件回调集合（全部可选）。
 * 每个回调的载荷类型都由事件名决定，调用处可以直接拿到完整类型提示。
 */
export interface SseHandlers {
  onMeta?: (payload: SseMetaPayload) => void;
  onCitations?: (payload: Citation[]) => void;
  onRestricted?: (payload: SseRestrictedPayload) => void;
  onTool?: (payload: SseToolPayload) => void;
  onAuthz?: (payload: SseAuthzPayload) => void;
  onDelta?: (payload: SseDeltaPayload) => void;
  onDone?: (payload: SseDonePayload) => void;
  onError?: (payload: SseErrorPayload) => void;
  /** 连接建立（HTTP 200 且拿到 body）。 */
  onOpen?: () => void;
  /** 流结束（正常结束或中断都会触发）。 */
  onClose?: () => void;
  /** 未知事件名，便于后端扩展时前端不崩。 */
  onUnknown?: (event: string, data: string) => void;
  /** 用于「停止生成」。 */
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* 增量解析器                                                          */
/* ------------------------------------------------------------------ */

export interface SseParser {
  /** 喂入一段可能被截断的文本。 */
  push(chunk: string): void;
  /** 流结束时调用，派发缓冲区中最后一个不带空行结尾的事件。 */
  flush(): void;
}

function parseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * 事件分隔符：空行。必须同时支持 LF / CRLF / CR 三种换行，
 * 且不能先把 \r 替换成 \n —— 因为 \r 与 \n 可能被切在两个 chunk 里
 * （那样会产生一个假的空行，把 event: 行吞掉）。
 * 交替顺序把最长的 \r\n\r\n 放在最前，保证优先匹配。
 */
const EVENT_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

/**
 * 创建一个 SSE 增量解析器。
 * 规则遵循 SSE 规范：以空行分隔事件块，`field: value`，`:` 开头为注释。
 */
export function createSseParser(dispatch: (event: string, data: string) => void): SseParser {
  let buffer = '';

  const emitBlock = (block: string): void => {
    if (!block) return;
    let eventName = 'message';
    const dataLines: string[] = [];

    // 块内也可能混用换行风格，三种都切开
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(':')) continue; // 注释 / 心跳
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
      // id / retry 字段对本场景无意义，忽略
    }

    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    // SSE 规范：data 缓冲区为空的事件不派发（例如只有一行 `data:`）
    if (data === '') return;
    dispatch(eventName, data);
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      for (;;) {
        const match = EVENT_SEPARATOR.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        emitBlock(block);
      }
    },
    flush(): void {
      if (buffer.trim()) emitBlock(buffer);
      buffer = '';
    },
  };
}

/* ------------------------------------------------------------------ */
/* 事件派发                                                            */
/* ------------------------------------------------------------------ */

function dispatchEvent(handlers: SseHandlers, event: string, data: string): void {
  switch (event) {
    case 'meta': {
      const payload = parseJson<SseMetaPayload>(data);
      if (payload?.session_key) handlers.onMeta?.(payload);
      break;
    }
    case 'citations': {
      const payload = parseJson<Citation[]>(data);
      if (Array.isArray(payload)) handlers.onCitations?.(payload);
      break;
    }
    case 'restricted': {
      const payload = parseJson<SseRestrictedPayload>(data);
      if (payload) handlers.onRestricted?.(payload);
      break;
    }
    case 'tool': {
      const payload = parseJson<SseToolPayload>(data);
      if (payload) handlers.onTool?.(payload);
      break;
    }
    case 'authz': {
      const payload = parseJson<SseAuthzPayload>(data);
      if (payload) handlers.onAuthz?.(payload);
      break;
    }
    case 'delta': {
      const payload = parseJson<SseDeltaPayload>(data);
      // 容错：万一后端直接下发纯文本，也当作增量
      const text = typeof payload?.text === 'string' ? payload.text : data;
      if (text) handlers.onDelta?.({ text });
      break;
    }
    case 'done': {
      const payload = parseJson<SseDonePayload>(data);
      if (payload) handlers.onDone?.(payload);
      break;
    }
    case 'error': {
      const payload = parseJson<SseErrorPayload>(data);
      handlers.onError?.({ message: payload?.message ?? '生成回答失败' });
      break;
    }
    default:
      handlers.onUnknown?.(event, data);
      break;
  }
}

/** 判断异常是否为主动中断（AbortController）。 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/* ------------------------------------------------------------------ */
/* 发起流式问答                                                        */
/* ------------------------------------------------------------------ */

/**
 * POST /api/chat/ask 并以 SSE 方式消费流。
 * 非 2xx 时按统一响应体解析 message 并抛 ApiError；用户主动中断时静默返回。
 */
export async function streamChat(
  payload: ChatAskRequest,
  handlers: SseHandlers = {},
): Promise<void> {
  const body = {
    question: payload.question,
    session_key: payload.session_key ?? null,
    top_k: payload.top_k ?? null,
    use_faq_cache: payload.use_faq_cache ?? true,
  };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/chat/ask`, {
      method: 'POST',
      headers: { ...authHeaders(true), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: handlers.signal,
    });
  } catch (err) {
    if (isAbortError(err)) return;
    throw new ApiError('无法连接问答服务，请检查网络或后端是否可用', -1, 0, '/chat/ask');
  }

  if (!response.ok) {
    const raw = await response.text();
    let message = `问答请求失败（HTTP ${response.status}）`;
    const envelope = parseJson<{ message?: unknown }>(raw);
    if (typeof envelope?.message === 'string' && envelope.message) message = envelope.message;
    throw new ApiError(message, -1, response.status, '/chat/ask');
  }

  if (!response.body) {
    throw new ApiError('当前浏览器不支持流式响应（ReadableStream 不可用）', -1, 0, '/chat/ask');
  }

  handlers.onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser((event, data) => dispatchEvent(handlers, event, data));

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode()); // 冲掉解码器中残留的多字节字符
    parser.flush();
  } catch (err) {
    if (!isAbortError(err)) throw err;
  } finally {
    handlers.onClose?.();
  }
}
