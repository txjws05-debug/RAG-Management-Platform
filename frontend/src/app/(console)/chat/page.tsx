'use client';

/**
 * AI 智能问答工作台。
 *
 * - POST /api/chat/ask（SSE over fetch，手动解析，见 src/lib/sse.ts）
 * - 多轮对话：保存 meta 事件返回的 session_key
 * - 流式打字机渲染：react-markdown + 代码高亮 + 复制按钮
 * - 引用溯源卡片（citations）与权限缺失提示气泡（restricted）
 * - 历史会话侧栏（列表 / 切换 / 删除）与智能联想提问
 */
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';

import Citations from '@/components/Citations';
import { Icon } from '@/components/Icons';
import Markdown from '@/components/Markdown';
import RestrictedNotice from '@/components/RestrictedNotice';
import { Badge, Button, EmptyState, ErrorNote, Loading, Modal, Spinner, TextArea, cn } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import {
  chatApi,
  errorMessage,
  type ChatMessageRow,
  type Citation,
  type ConversationRow,
} from '@/lib/api';
import { RequireAuth } from '@/lib/auth';
import { isAbortError, streamChat } from '@/lib/sse';

/** 历史消息里的 restricted_notice 只有布尔值，回放时使用该兜底文案。 */
const DEFAULT_RESTRICTED_MESSAGE = '检测到相关制度文档，但您当前所属部门/角色无权查阅该内容。';

const FALLBACK_SUGGESTIONS: readonly string[] = [
  '差旅报销标准是多少？',
  '生鲜食品破损如何申请退款？',
  '员工入职需要提交哪些材料？',
];

/* ------------------------------------------------------------------ */
/* 本地工具                                                            */
/* ------------------------------------------------------------------ */

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  restricted: boolean;
  restrictedMessage?: string;
  blockedDocumentCount?: number;
  blockedChunkCount?: number;
  answerSource?: string;
  latencyMs?: number;
  totalTokens?: number;
  topScore?: number;
  recalled?: number;
  passed?: number;
  blocked?: number;
  streaming?: boolean;
  error?: string;
  createdAt?: string | null;
}

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function formatLatency(ms?: number): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 回答来源徽标：FAQ 缓存直出需显著标注。 */
function SourceBadge({ source }: { source?: string }) {
  if (source === 'faq_cache') {
    return (
      <Badge tone="emerald" title="命中已发布 FAQ 标准答案，毫秒级直出">
        <Icon name="zap" className="h-3 w-3" />
        FAQ 缓存直出
      </Badge>
    );
  }
  if (source === 'offline') {
    return (
      <Badge tone="amber" title="大模型不可用，返回检索到的制度原文片段">
        <Icon name="alert" className="h-3 w-3" />
        离线降级
      </Badge>
    );
  }
  if (source === 'llm') {
    return (
      <Badge tone="sky" title="由大模型基于授权知识生成">
        <Icon name="sparkles" className="h-3 w-3" />
        模型生成
      </Badge>
    );
  }
  return null;
}

/** 历史消息 → UI 消息。 */
function toUiMessage(row: ChatMessageRow, index: number): UiMessage {
  const isAssistant = row.role === 'assistant';
  return {
    id: `history-${row.id}-${index}`,
    role: isAssistant ? 'assistant' : 'user',
    content: row.content,
    citations: isAssistant ? (row.citations ?? []) : [],
    restricted: Boolean(isAssistant && row.restricted_notice),
    restrictedMessage: row.restricted_notice ? DEFAULT_RESTRICTED_MESSAGE : undefined,
    answerSource: row.answer_source,
    latencyMs: row.latency_ms,
    totalTokens: row.total_tokens,
    topScore: row.top_score,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* 单条消息                                                            */
/* ------------------------------------------------------------------ */

function MessageBubble({ message }: { message: UiMessage }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const isUser = message.role === 'user';

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('复制失败，请手动选择文本');
    }
  };

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[76%] rounded-xl rounded-tr-sm bg-indigo-600 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-white shadow-sm">
          {message.content}
        </div>
      </div>
    );
  }

  const hasMeta =
    message.latencyMs !== undefined ||
    message.totalTokens !== undefined ||
    message.topScore !== undefined ||
    message.recalled !== undefined;

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] min-w-0 rounded-xl rounded-tl-sm border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
        {/* 头部：来源 + 复制 */}
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-indigo-50 text-indigo-600">
              <Icon name="sparkles" className="h-3 w-3" />
            </span>
            <span>AI 助手</span>
          </div>
          {message.content ? (
            <button
              type="button"
              onClick={copyAnswer}
              className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 hover:text-indigo-600"
            >
              <Icon name={copied ? 'check' : 'copy'} className="h-3 w-3" />
              {copied ? '已复制' : '复制回答'}
            </button>
          ) : null}
        </div>

        {/* 权限缺失提示气泡（醒目警示样式，优先于正文展示） */}
        {message.restricted ? (
          <RestrictedNotice
            className="mb-2.5"
            message={message.restrictedMessage}
            blockedDocumentCount={message.blockedDocumentCount}
            blockedChunkCount={message.blockedChunkCount}
          />
        ) : null}

        {/* 正文 */}
        {message.content ? (
          <Markdown content={message.content} className={message.streaming ? 'kb-caret' : undefined} />
        ) : message.streaming ? (
          <p className="flex items-center gap-2 py-1 text-xs text-slate-500">
            <Spinner className="h-3.5 w-3.5 text-indigo-500" />
            正在检索知识库并生成回答…
          </p>
        ) : null}

        {message.error ? <ErrorNote className="mt-2">{message.error}</ErrorNote> : null}

        {/* 引用溯源 */}
        {message.citations.length > 0 ? <Citations citations={message.citations} /> : null}

        {/* 本轮统计 */}
        {hasMeta || message.answerSource ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
            <SourceBadge source={message.answerSource} />
            {message.latencyMs !== undefined ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="clock" className="h-3 w-3" />
                耗时 {formatLatency(message.latencyMs)}
              </span>
            ) : null}
            {message.totalTokens !== undefined ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="trending" className="h-3 w-3" />
                Token {message.totalTokens}
              </span>
            ) : null}
            {message.topScore !== undefined && message.topScore > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="percent" className="h-3 w-3" />
                最高相关度 {(message.topScore > 1 ? message.topScore : message.topScore * 100).toFixed(0)}%
              </span>
            ) : null}
            {message.recalled !== undefined ? (
              <span className="inline-flex items-center gap-1" title="召回 / 鉴权放行 / 鉴权拦截">
                <Icon name="shield" className="h-3 w-3" />
                召回 {message.recalled} · 放行 {message.passed ?? 0} · 拦截 {message.blocked ?? 0}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 工作台                                                              */
/* ------------------------------------------------------------------ */

function ChatWorkbench() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const presetQuestion = searchParams.get('q') ?? '';

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [input, setInput] = useState(presetQuestion);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);

  const conversations = useSWR<ConversationRow[]>(
    '/chat/conversations',
    () => chatApi.conversations(),
    { revalidateOnFocus: false },
  );

  // 智能联想：随输入框关键词变化（防抖 350ms）
  const debouncedInput = useDebounced(input, 350);
  const suggestions = useSWR<string[]>(
    ['/chat/suggestions', debouncedInput],
    () => chatApi.suggestions(debouncedInput),
    { revalidateOnFocus: false, keepPreviousData: true },
  );

  const suggestionList =
    suggestions.data && suggestions.data.length > 0
      ? suggestions.data.slice(0, 8)
      : input.trim()
        ? []
        : [...FALLBACK_SUGGESTIONS];

  /** 局部更新某条消息。 */
  const patchMessage = useCallback(
    (id: string, patch: Partial<UiMessage> | ((prev: UiMessage) => Partial<UiMessage>)) => {
      setMessages((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, ...(typeof patch === 'function' ? patch(item) : patch) }
            : item,
        ),
      );
    },
    [],
  );

  /** 消息区自动贴底。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || sending) return;

      setInput('');
      const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const stamp = Date.now();

      setMessages((prev) => [
        ...prev,
        {
          id: `user-${stamp}`,
          role: 'user',
          content: question,
          citations: [],
          restricted: false,
        },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          citations: [],
          restricted: false,
          streaming: true,
        },
      ]);

      setSending(true);
      activeIdRef.current = assistantId;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat(
          { question, session_key: sessionKey, use_faq_cache: true },
          {
            signal: controller.signal,
            onMeta: (meta) => setSessionKey(meta.session_key),
            onCitations: (citations) => patchMessage(assistantId, { citations }),
            onRestricted: (payload) =>
              patchMessage(assistantId, {
                restricted: true,
                restrictedMessage: payload.message,
                blockedDocumentCount: payload.blocked_document_count,
                blockedChunkCount: payload.blocked_chunk_count,
              }),
            onDelta: (payload) =>
              patchMessage(assistantId, (prev) => ({ content: prev.content + payload.text })),
            onDone: (payload) =>
              patchMessage(assistantId, (prev) => ({
                streaming: false,
                answerSource: payload.answer_source,
                latencyMs: payload.latency_ms,
                totalTokens: payload.total_tokens,
                topScore: payload.top_score,
                recalled: payload.recalled,
                passed: payload.passed,
                blocked: payload.blocked,
                restricted: prev.restricted || payload.restricted,
              })),
            onError: (payload) =>
              patchMessage(assistantId, { streaming: false, error: payload.message }),
            onClose: () => patchMessage(assistantId, { streaming: false }),
          },
        );
        // 首轮问答后刷新历史会话列表
        void conversations.mutate();
      } catch (err) {
        if (isAbortError(err)) {
          patchMessage(assistantId, { streaming: false, error: '已停止生成。' });
        } else {
          const text = errorMessage(err, '问答失败，请稍后重试');
          patchMessage(assistantId, { streaming: false, error: text });
          toast.error(text);
        }
      } finally {
        abortRef.current = null;
        activeIdRef.current = null;
        setSending(false);
      }
    },
    [conversations, patchMessage, sending, sessionKey, toast],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSend(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend(input);
    }
  };

  const stopGenerating = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (activeIdRef.current) {
      patchMessage(activeIdRef.current, { streaming: false });
      activeIdRef.current = null;
    }
    setSending(false);
  };

  const startNewConversation = () => {
    if (sending) {
      toast.warning('请先停止当前生成');
      return;
    }
    setSessionKey(null);
    setMessages([]);
    setInput('');
  };

  const openConversation = async (key: string) => {
    if (sending) {
      toast.warning('请先停止当前生成');
      return;
    }
    if (key === sessionKey) return;
    setLoadingHistory(true);
    try {
      const detail = await chatApi.conversation(key);
      setSessionKey(detail.session_key);
      setMessages(detail.messages.map((row, index) => toUiMessage(row, index)));
    } catch (err) {
      toast.error(errorMessage(err, '会话加载失败'));
    } finally {
      setLoadingHistory(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await chatApi.removeConversation(deleteTarget.session_key);
      toast.success('会话已删除');
      if (deleteTarget.session_key === sessionKey) {
        setSessionKey(null);
        setMessages([]);
      }
      setDeleteTarget(null);
      void conversations.mutate();
    } catch (err) {
      toast.error(errorMessage(err, '删除会话失败'));
    } finally {
      setDeleting(false);
    }
  };

  const conversationList = conversations.data ?? [];

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[560px] gap-4">
      {/* ---------------- 历史会话侧栏 ---------------- */}
      <aside className="flex w-[268px] shrink-0 flex-col rounded-xl border border-slate-200 bg-white">
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <Icon name="history" className="h-3.5 w-3.5 text-indigo-500" />
            历史会话
          </span>
          <Button size="sm" variant="secondary" icon="plus" onClick={startNewConversation}>
            新会话
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-2">
          {conversations.isLoading ? (
            <Loading text="加载会话…" />
          ) : conversations.error ? (
            <ErrorNote>会话列表加载失败：{errorMessage(conversations.error, '未知错误')}</ErrorNote>
          ) : conversationList.length === 0 ? (
            <EmptyState title="暂无历史会话" description="开始提问后，会话会自动保存在这里" icon="chat" />
          ) : (
            <ul className="space-y-1">
              {conversationList.map((conversation) => {
                const active = conversation.session_key === sessionKey;
                return (
                  <li key={conversation.session_key}>
                    <div
                      className={cn(
                        'group flex items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors',
                        active
                          ? 'border-indigo-200 bg-indigo-50/70'
                          : 'border-transparent hover:bg-slate-50',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => void openConversation(conversation.session_key)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p
                          className={cn(
                            'truncate text-xs font-medium',
                            active ? 'text-indigo-700' : 'text-slate-700',
                          )}
                          title={conversation.title}
                        >
                          {conversation.title || '未命名会话'}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {conversation.message_count} 条消息 · {formatDateTime(conversation.updated_at)}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(conversation)}
                        title="删除会话"
                        aria-label={`删除会话 ${conversation.title}`}
                        className="mt-0.5 rounded p-1 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-500"
                      >
                        <Icon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ---------------- 对话主区 ---------------- */}
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Icon name="chat" className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-semibold text-slate-800">AI 智能问答工作台</p>
              <p className="text-[11px] text-slate-400">
                {sessionKey ? `会话 ${sessionKey}` : '新会话（首轮提问后自动创建）'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1">
              <Icon name="shield" className="h-3.5 w-3.5 text-amber-500" />
              检索结果按部门 / 角色做数据权限鉴权
            </span>
          </div>
        </header>

        {/* 消息区 */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {loadingHistory ? (
            <Loading text="正在加载会话记录…" />
          ) : messages.length === 0 ? (
            <div className="mx-auto max-w-2xl py-8">
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-5 py-6 text-center">
                <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                  <Icon name="sparkles" className="h-5 w-5" />
                </span>
                <p className="text-sm font-semibold text-slate-800">向知识库提问</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  回答基于您有权查阅的制度文档生成，并附引用溯源；命中无权内容时会明确提示权限受限，绝不泄露原文。
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {FALLBACK_SUGGESTIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => void handleSend(item)}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition-colors hover:border-indigo-200 hover:text-indigo-600"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
        </div>

        {/* 输入区 */}
        <div className="border-t border-slate-100 px-4 py-3">
          <form onSubmit={handleSubmit}>
            <div className="rounded-xl border border-slate-200 focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100">
              <TextArea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                rows={3}
                placeholder="请输入你的问题，Enter 发送、Shift+Enter 换行"
                className="min-h-[72px] resize-none border-0 focus:ring-0"
                disabled={sending}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-2">
                <span className="text-[11px] text-slate-400">
                  Enter 发送 · Shift+Enter 换行 · 回答基于授权知识生成
                </span>
                <div className="flex items-center gap-2">
                  {sending ? (
                    <Button variant="outline" size="sm" icon="stop" onClick={stopGenerating}>
                      停止生成
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    icon="send"
                    loading={sending}
                    disabled={sending || !input.trim()}
                  >
                    发送
                  </Button>
                </div>
              </div>
            </div>
          </form>

          {/* 智能联想提问 */}
          {suggestionList.length > 0 ? (
            <div className="mt-2.5">
              <p className="mb-1.5 flex items-center gap-1 text-[11px] text-slate-400">
                <Icon name="sparkles" className="h-3 w-3 text-indigo-400" />
                推荐提问
                {suggestions.isValidating ? <span>· 正在联想…</span> : null}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestionList.map((item) => (
                  <button
                    key={item}
                    type="button"
                    disabled={sending}
                    onClick={() => void handleSend(item)}
                    className="max-w-full truncate rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 transition-colors hover:border-indigo-200 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
                    title={item}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* 删除会话确认 */}
      <Modal
        open={deleteTarget !== null}
        title="删除会话"
        description="删除后该会话的对话记录将无法恢复"
        onClose={() => (deleting ? undefined : setDeleteTarget(null))}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="danger" loading={deleting} onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          确认删除会话「{deleteTarget?.title || '未命名会话'}」吗？该会话包含{' '}
          {deleteTarget?.message_count ?? 0} 条消息。
        </p>
      </Modal>
    </div>
  );
}

export default function ChatPage() {
  return (
    <RequireAuth anyOf={['menu:chat', 'ai:chat']}>
      {/* useSearchParams 必须包在 Suspense 内，否则 next build 会报错 */}
      <Suspense fallback={<Loading text="正在加载问答工作台…" />}>
        <ChatWorkbench />
      </Suspense>
    </RequireAuth>
  );
}
