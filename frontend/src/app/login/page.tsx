'use client';

/**
 * 登录页：用户名 / 密码登录。
 * 登录成功后把 access_token 写入 localStorage（key = kb_token）并跳转 /dashboard。
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
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-10">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[1.05fr_1fr]">
        {/* 品牌介绍区 */}
        <section className="hidden flex-col justify-between bg-indigo-600 p-8 text-indigo-50 lg:flex">
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
        <section className="p-8">
          <h1 className="text-lg font-semibold text-slate-800">账号登录</h1>
          <p className="mt-1 text-xs text-slate-500">请使用管理员分配的账号登录控制台</p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-600">用户名</span>
              <Input
                name="username"
                value={username}
                autoComplete="username"
                autoFocus
                placeholder="请输入用户名"
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-600">密码</span>
              <Input
                name="password"
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder="请输入密码"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <Button type="submit" variant="primary" size="lg" loading={submitting} className="w-full">
              {submitting ? '登录中…' : '登录'}
            </Button>
          </form>

          {/* 演示账号提示 */}
          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <Icon name="sparkles" className="h-3.5 w-3.5 text-indigo-500" />
              演示账号（点击可自动填充）
            </p>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.username}
                  type="button"
                  onClick={() => {
                    setUsername(account.username);
                    setPassword(account.password);
                    setError('');
                  }}
                  className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left text-[11px] transition-colors hover:border-indigo-200 hover:bg-indigo-50/50"
                >
                  <span className="font-mono text-slate-700">{account.username}</span>
                  <span className="text-slate-400">{account.role}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              演示账号密码见上表；超级管理员 admin 的初始密码由后端环境变量
              BOOTSTRAP_ADMIN_PASSWORD 决定。
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
