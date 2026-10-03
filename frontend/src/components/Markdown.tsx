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
    <div className="my-3 overflow-hidden rounded-lg border border-line bg-subtle text-strong">
      <div className="flex items-center justify-between border-b border-line bg-subtle/80 px-3 py-1.5">
        <span className="text-[11px] font-medium tracking-wide text-muted">代码</span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors touch-target',
            copied
              ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
              : 'border-line bg-canvas text-muted hover:text-brand-ink',
          )}
        >
          <Icon name={copied ? 'check' : 'copy'} className="h-3 w-3" />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* overflow-x-auto + min-w-0：长代码行在窄屏横向滚动，而不是把气泡撑宽 */}
      <pre className="min-w-0 overflow-x-auto px-3 py-3 text-xs leading-relaxed">{children}</pre>
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
      className="break-words text-brand-ink underline decoration-brand-ink/40 underline-offset-2 hover:text-brand-dark"
    >
      {children}
    </a>
  ),
  // 用 globals.css 的 .table-scroll（含 -webkit-overflow-scrolling）包一层，窄屏不撑破气泡
  table: ({ children }) => (
    <div className="table-scroll my-3">
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
