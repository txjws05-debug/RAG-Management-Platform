'use client';

/**
 * 知识引用溯源卡片。
 *
 * 交互：鼠标悬浮自动展开原文片段，点击卡片可固定展开（再次点击收起）。
 * 兼容 FAQ 缓存直出的引用（document_id === 0，标题为「FAQ 标准答案库」）。
 */
import { useState } from 'react';

import { Icon } from '@/components/Icons';
import { cn } from '@/components/primitives';
import type { Citation } from '@/lib/api';

/** 相关度百分比：后端 score 为 0~1 的相似度。 */
function scorePercent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  const normalized = score > 1 ? score / 100 : score;
  return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

function scoreTone(percent: number): { bar: string; text: string } {
  if (percent >= 80) return { bar: 'bg-emerald-500', text: 'text-emerald-600' };
  if (percent >= 60) return { bar: 'bg-indigo-500', text: 'text-indigo-600' };
  if (percent >= 40) return { bar: 'bg-amber-500', text: 'text-amber-600' };
  return { bar: 'bg-slate-400', text: 'text-slate-500' };
}

export function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  const [pinned, setPinned] = useState(false);
  const percent = scorePercent(citation.score);
  const tone = scoreTone(percent);
  const isFaq = citation.document_id === 0;

  return (
    <article
      className={cn(
        'group rounded-lg border bg-white p-3 transition-colors',
        pinned ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-200 hover:border-indigo-200',
      )}
    >
      <button
        type="button"
        onClick={() => setPinned((value) => !value)}
        aria-expanded={pinned}
        className="w-full text-left"
      >
        <div className="flex items-start gap-2">
          <span
            className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold',
              isFaq ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-100 text-indigo-700',
            )}
          >
            {citation.index || index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-slate-800" title={citation.document_title}>
              {citation.document_title || '未命名知识单元'}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className={cn('text-[11px] font-medium', tone.text)}>相关度 {percent}%</span>
              <span className="h-1 w-16 overflow-hidden rounded-full bg-slate-100">
                <span
                  className={cn('block h-full rounded-full', tone.bar)}
                  style={{ width: `${percent}%` }}
                />
              </span>
              {isFaq ? (
                <span className="rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-600">
                  FAQ 缓存
                </span>
              ) : (
                <span className="text-[11px] text-slate-400">第 {citation.ordinal} 片</span>
              )}
            </div>
          </div>
          <Icon
            name="chevronDown"
            className={cn(
              'mt-1 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
              pinned ? 'rotate-180' : 'group-hover:rotate-180',
            )}
          />
        </div>
      </button>

      {/* 悬浮或点击展开原文片段 */}
      <div
        className={cn(
          'mt-2 rounded-md border border-slate-100 bg-slate-50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-600',
          pinned ? 'block' : 'hidden group-hover:block',
        )}
      >
        {citation.snippet ? (
          <p className="whitespace-pre-wrap">{citation.snippet}</p>
        ) : (
          <p className="text-slate-400">该切片暂无原文片段</p>
        )}
        <p className="mt-1.5 text-[10px] text-slate-400">
          文档 #{citation.document_id} · 切片 #{citation.chunk_id}
        </p>
      </div>
    </article>
  );
}

export interface CitationsProps {
  citations: readonly Citation[];
  className?: string;
  /** 折叠标题文案。 */
  title?: string;
}

export default function Citations({ citations, className, title = '知识引用溯源' }: CitationsProps) {
  if (!citations || citations.length === 0) return null;

  return (
    <section className={cn('mt-3', className)}>
      <header className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <Icon name="file" className="h-3.5 w-3.5" />
        <span>
          {title} · {citations.length} 条
        </span>
        <span className="text-slate-300">（悬浮或点击查看原文片段）</span>
      </header>
      <div className="grid gap-2 sm:grid-cols-2">
        {citations.map((citation, index) => (
          <CitationCard
            key={`${citation.document_id}-${citation.chunk_id}-${citation.index}-${index}`}
            citation={citation}
            index={index}
          />
        ))}
      </div>
    </section>
  );
}
