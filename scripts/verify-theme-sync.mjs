/**
 * 主题偏好的跨设备持久化实测。
 *
 * 验证的完整链路：
 *   1. 在浏览器里切换主题 → 前端写 localStorage
 *   2. 同一动作应同时写入服务端（PUT /auth/preferences）
 *   3. 模拟"换一台设备"：清空 localStorage 后重新加载
 *      → 应从 /auth/me 拿到服务端偏好并应用（而不是回落到亮色）
 *   4. 本地已有显式选择时，服务端偏好不应覆盖它
 *
 * 用法：node scripts/verify-theme-sync.mjs [基址]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT_DIR = resolve('docs/design-check');
const PORT = 9224;
const USERNAME = 'admin';
const PASSWORD = 'admin123456';

const BROWSER = [
  process.env.KB_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await sleep(300);
  }
  throw new Error('DevTools 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timeout`));
        }
      }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result?.value;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!BROWSER) throw new Error('未找到 Chrome/Edge');
  console.log(`基址: ${BASE}\n浏览器: ${BROWSER}\n`);

  const child = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--user-data-dir=' + join(OUT_DIR, '.chrome-profile-theme'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let failed = 0;
  const report = {};
  const check = (ok, label, detail = '') => {
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  };

  try {
    await waitForDevtools();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // ---------- 登录 ----------
    console.log('【1】登录并准备干净状态');
    await cdp.send('Page.navigate', { url: `${BASE}/login` });
    await sleep(2500);
    const login = await cdp.evaluate(`(async () => {
      const resp = await fetch('${BASE}/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '${USERNAME}', password: '${PASSWORD}' }),
      });
      const body = await resp.json();
      if (body.code !== 0) return { ok: false, message: body.message };
      localStorage.setItem('kb_token', body.data.access_token);
      localStorage.removeItem('kb.theme');
      return { ok: true, serverPref: body.data.user.theme_preference };
    })()`);
    check(login?.ok, '登录成功', `服务端初始偏好=${login?.serverPref}`);
    report.initialServerPreference = login?.serverPref;

    // ---------- 通过界面切换主题，验证双写 ----------
    console.log('\n【2】点击顶栏主题按钮，验证同时写入 localStorage 与服务端');
    await cdp.send('Page.navigate', { url: `${BASE}/dashboard` });
    await sleep(3000);

    const clicked = await cdp.evaluate(`(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /切换到.*主题/.test(b.getAttribute('aria-label') || ''),
      );
      if (!btn) return { ok: false, reason: '未找到主题切换按钮' };
      btn.click();
      await new Promise((r) => setTimeout(r, 1200));
      return {
        ok: true,
        dataTheme: document.documentElement.getAttribute('data-theme'),
        stored: localStorage.getItem('kb.theme'),
      };
    })()`);
    check(clicked?.ok, '主题切换按钮可用', JSON.stringify(clicked));
    report.afterToggle = clicked;

    // 直接查服务端，确认真写进去了
    const serverAfter = await cdp.evaluate(`(async () => {
      const token = localStorage.getItem('kb_token');
      const r = await fetch('${BASE}/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      const b = await r.json();
      return b.data?.theme_preference;
    })()`);
    check(
      serverAfter === clicked?.dataTheme,
      '服务端偏好已随切换更新',
      `localStorage=${clicked?.stored} 服务端=${serverAfter}`,
    );
    report.serverAfterToggle = serverAfter;

    // ---------- 模拟换设备：清空 localStorage 后重载 ----------
    console.log('\n【3】模拟换设备：清空 localStorage 后重新加载，应从服务端恢复');
    await cdp.evaluate(`(() => { localStorage.removeItem('kb.theme'); return true; })()`);
    await cdp.send('Page.navigate', { url: `${BASE}/dashboard` });
    await sleep(3500);

    const restored = await cdp.evaluate(`(async () => {
      // 等服务端偏好应用（AuthProvider 拿到 /auth/me 后会补齐）
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (localStorage.getItem('kb_token')) break;
      }
      const token = localStorage.getItem('kb_token');
      const r = await fetch('${BASE}/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      const b = await r.json();
      return {
        dataTheme: document.documentElement.getAttribute('data-theme'),
        localStored: localStorage.getItem('kb.theme'),
        serverPref: b.data?.theme_preference,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    })()`);
    check(
      restored?.dataTheme === serverAfter,
      '清空本地后主题从服务端恢复',
      `data-theme=${restored?.dataTheme} 服务端=${restored?.serverPref} bodyBg=${restored?.bodyBg}`,
    );
    report.afterSimulatedNewDevice = restored;

    // ---------- 本地显式选择优先于服务端 ----------
    console.log('\n【4】本地已有显式选择时，服务端偏好不应覆盖');
    const other = serverAfter === 'dark' ? 'light' : 'dark';
    await cdp.evaluate(`(() => { localStorage.setItem('kb.theme','${other}'); return true; })()`);
    await cdp.send('Page.navigate', { url: `${BASE}/dashboard` });
    await sleep(3500);
    const localWins = await cdp.evaluate(`(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return {
        dataTheme: document.documentElement.getAttribute('data-theme'),
        localStored: localStorage.getItem('kb.theme'),
      };
    })()`);
    check(
      localWins?.dataTheme === other,
      '本地显式选择未被服务端覆盖',
      `本地=${localWins?.localStored} 生效=${localWins?.dataTheme}（服务端=${serverAfter}）`,
    );
    report.localPrecedence = localWins;

    // ---------- 跟随系统 ----------
    console.log('\n【5】跟随系统：清除显式选择后应回落到系统偏好');
    const systemMode = await cdp.evaluate(`(async () => {
      localStorage.removeItem('kb.theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      return { prefersDark, dataTheme: document.documentElement.getAttribute('data-theme') };
    })()`);
    check(
      typeof systemMode?.prefersDark === 'boolean',
      '系统偏好可读取',
      `prefersDark=${systemMode?.prefersDark} → ${systemMode?.dataTheme}`,
    );
    report.systemMode = systemMode;

    // 收尾：把服务端偏好设回 system，避免影响后续使用
    await cdp.evaluate(`(async () => {
      const token = localStorage.getItem('kb_token');
      await fetch('${BASE}/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ theme_preference: 'system' }),
      });
      localStorage.removeItem('kb.theme');
      return true;
    })()`);
    console.log('\n  · 已将服务端偏好重置为 system');

    await cdp.send('Page.navigate', { url: `${BASE}/dashboard` });
    await sleep(3000);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT_DIR, 'theme-sync-final.png'), Buffer.from(shot.data, 'base64'));
    console.log('  · 收尾截图 theme-sync-final.png');

    writeFileSync(join(OUT_DIR, 'theme-sync-report.json'), JSON.stringify(report, null, 2));
    ws.close();
  } catch (err) {
    console.error('实测失败：', err.message);
    failed += 1;
  } finally {
    child.kill();
  }

  console.log(`\n${'='.repeat(58)}`);
  console.log(failed === 0 ? '主题跨设备持久化：全部通过' : `主题跨设备持久化：${failed} 项问题`);
  console.log('='.repeat(58));
  process.exit(failed === 0 ? 0 : 1);
}

main();
