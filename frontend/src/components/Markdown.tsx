'use client';

/**
 * Markdown 流式渲染：react-markdown + remark-gfm + rehype-highlight。
 * 代码块自带语言标签与「复制」按钮；样式主题见 src/app/globals.css 的 .markdown-body / .hljs-*。
 */
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

import { Icon } from '@/components/Icons';
import { cn } from '@/components/primitives';

/** 递归提取 React 子节点中的纯文本（用于复制代码）。 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => extractText(child as ReactNode)).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return extractText(props?.children);
  }
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100/80 px-3 py-1.5">
        <span className="text-[11px] font-medium tracking-wide text-slate-500">代码</span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
            copied
              ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
              : 'border-slate-200 bg-white text-slate-500 hover:text-indigo-600',
          )}
        >
          <Icon name={copied ? 'check' : 'copy'} className="h-3 w-3" />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 text-xs leading-relaxed">{children}</pre>
    </div>
  );
}

/** 组件与插件都放在模块级，避免每次渲染重新创建导致整篇 Markdown 重解析。 */
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-600 underline decoration-indigo-200 underline-offset-2 hover:text-indigo-700"
    >
      {children}
    </a>
  ),
  // 表格外层包一层横向滚动，窄屏不撑破气泡
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

function MarkdownImpl({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
export default Markdown;
