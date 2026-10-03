'use client';

/**
 * 登录页：用户名 / 密码登录。
 * 登录成功后把 access_token 写入 localStorage（key = kb_token）并跳转 /dashboard。
 *
 * 移动端要点：卡片窄屏铺满并收紧内边距；输入框与主按钮统一 h-11（触屏 44px 目标），
 * 输入框字号用 text-base —— iOS Safari 在字号小于 16px 时聚焦会自动放大整页。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Icon } from '@/components/Icons';
import { Button, ErrorNote, Input } from '@/components/primitives';
import { errorMessage } from '@/lib/api';
import { FullPageLoading, useAuth } from '@/lib/auth';

/** 演示账号（与后端 seed 数据一致，便于验收演示）。 */
const DEMO_ACCOUNTS: ReadonlyArray<{ username: string; password: string; role: string }> = [
  { username: 'kadmin', password: 'kadmin123456', role: '知识管理员' },
  { username: 'finance01', password: 'demo123456', role: '财务专员' },
  { username: 'hr01', password: 'demo123456', role: '人力资源专员' },
  { username: 'cs01', password: 'demo123456', role: '客服专员' },
  { username: 'sales01', password: 'demo123456', role: '业务人员' },
  { username: 'manager01', password: 'demo123456', role: '管理层' },
];

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, login } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // 已登录用户直接进入控制台
  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password) {
      setError('请输入用户名与密码');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await login(username, password);
      router.replace('/dashboard');
    } catch (err) {
      setError(errorMessage(err, '登录失败，请检查用户名与密码'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <FullPageLoading text="正在校验登录态…" />;
  if (user) return <FullPageLoading text="已登录，正在进入控制台…" />;

  return (
    // 窄屏去掉外层大内边距，让卡片用满可视宽度，避免手机上压迫内容区
    <main className="flex min-h-screen items-center justify-center bg-canvas px-3 py-6 sm:px-6 sm:py-10">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-line bg-canvas shadow-sm lg:grid-cols-[1.05fr_1fr]">
        {/* 品牌介绍区：仅宽屏展示，窄屏完全隐藏以保证表单首屏可见 */}
        <section className="hidden flex-col justify-between bg-brand p-8 text-indigo-50 lg:flex">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
                <Icon name="knowledge" className="h-5 w-5" />
              </span>
              <span className="text-base font-semibold tracking-wide">知识库管理平台</span>
            </div>
            <p className="mt-6 text-sm leading-relaxed text-indigo-100/90">
              知识多源维护 · 四维细粒度权限鉴权 · AI 鉴权检索问答 · 运营数据看板 · 知识自动沉淀
            </p>
          </div>
          <ul className="mt-10 space-y-3 text-xs text-indigo-100/90">
            {[
              '混合检索（向量 + 关键词）后按部门 / 角色 / 个人做数据权限隔离',
              '命中无权查阅的制度文档时输出权限缺失提示，杜绝越权泄露',
              'SSE 流式回答 + 引用溯源卡片 + FAQ 缓存毫秒级直出',
              'PV/UV、Token 消耗、响应延时分布与高频提问排行一屏总览',
            ].map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Icon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-200" />
                <span className="leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 登录表单区 */}
        <section className="w-full px-5 py-6 sm:px-8 sm:py-8">
          <h1 className="text-lg font-semibold text-strong">账号登录</h1>
          <p className="mt-1 text-xs text-muted">请使用管理员分配的账号登录控制台</p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-body">用户名</span>
              <Input
                name="username"
                value={username}
                autoComplete="username"
                autoFocus
                placeholder="请输入用户名"
                // text-base（16px）+ h-11：既满足触屏点击目标，也避开 iOS 聚焦缩放
                className="h-11 text-base"
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-body">密码</span>
              <Input
                name="password"
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder="请输入密码"
                className="h-11 text-base"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submitting}
              className="h-11 w-full touch-target"
            >
              {submitting ? '登录中…' : '登录'}
            </Button>
          </form>

          {/* 演示账号提示 */}
          <div className="mt-6 rounded-lg border border-line bg-subtle p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-body">
              <Icon name="sparkles" className="h-3.5 w-3.5 text-brand-ink" />
              演示账号（点击可自动填充）
            </p>
            {/* 窄屏单列、宽屏两列：账号名较长时单列可避免横向溢出 */}
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.username}
                  type="button"
                  onClick={() => {
                    setUsername(account.username);
                    setPassword(account.password);
                    setError('');
                  }}
                  className="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-2 py-1.5 text-left text-[11px] transition-colors hover:border-brand-ink/30 hover:bg-brand-soft/50"
                >
                  <span className="truncate font-mono text-body">{account.username}</span>
                  <span className="shrink-0 text-faint">{account.role}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              演示账号密码见上表；超级管理员 admin 的初始密码由后端环境变量
              BOOTSTRAP_ADMIN_PASSWORD 决定。
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
