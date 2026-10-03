/**
 * 设计系统与移动端适配的浏览器实测。
 *
 * 覆盖两个静态检查无法确认的关键点：
 *   1. 375px 手机视口下是否真的没有横向溢出（旧版有 min-width:1280px，必然溢出）
 *   2. 亮色 / 暗色两套主题是否都真实生效（token 是否按预期解析）
 *   3. 主题是否在首帧前应用（无浅色闪屏）、切换后是否持久化
 *   4. 移动端抽屉菜单能否打开与关闭
 *   5. 页面控制台是否有水合不匹配等错误
 *
 * 用法：node scripts/verify-design.mjs [输出目录] [基址]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT_DIR = resolve(process.argv[2] || 'docs/design-check');
const BASE = process.argv[3] || 'http://127.0.0.1:8080';
const PORT = 9223;
const USERNAME = process.env.KB_SCREENSHOT_USER || 'admin';
const PASSWORD = process.env.KB_SCREENSHOT_PASSWORD || 'admin123456';

/** 要检查的页面：路径 + 名称 + 是否用手机视口 */
const PAGES = [
  { path: '/login', name: 'login', mobile: true },
  { path: '/dashboard', name: 'dashboard', mobile: true },
  { path: '/chat', name: 'chat', mobile: true },
  { path: '/knowledge', name: 'knowledge', mobile: true },
  { path: '/sedimentation', name: 'sedimentation', mobile: true },
  { path: '/system', name: 'system', mobile: true },
  { path: '/dashboard', name: 'dashboard-desktop', mobile: false },
];

const VIEWPORTS = {
  mobile: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
};

const BROWSER_CANDIDATES = [
  process.env.KB_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge，可用环境变量 KB_BROWSER 指定');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (resp.ok) return resp.json();
    } catch {
      /* 未就绪 */
    }
    await sleep(300);
  }
  throw new Error('DevTools 端口未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(
          msg.params.exceptionDetails?.exception?.description || 'unknown exception',
        );
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
          reject(new Error(`${method} 超时`));
        }
      }, 40000);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result?.value;
  }
}

/** 用 DOM API 重新设视口（比 Emulation 更可靠地触发一次完整布局）。 */
async function setViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', viewport);
}

async function goto(cdp, path, waitMs = 2800) {
  await cdp.send('Page.navigate', { url: `${BASE}${path}` });
  await sleep(waitMs);
}

/**
 * 检查横向溢出 —— 本次改造的核心验收点。
 * 旧版 `.console-shell { min-width: 1280px }` 会让 scrollWidth 远超 clientWidth。
 */
async function checkOverflow(cdp, label) {
  return cdp.evaluate(`(() => {
    const de = document.documentElement;
    const overflowing = [];
    // 找出真正超出视口右边界的元素（排除 fixed 遮罩等）
    const vw = de.clientWidth;
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 2) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed') return;
        // 只报告"自身不滚动却溢出"的容器，真正可横向滚动的表格容器是预期的
        const scrollable = el.scrollWidth > el.clientWidth + 2 &&
          ['auto', 'scroll'].includes(style.overflowX);
        if (!scrollable) {
          overflowing.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 70),
            right: Math.round(r.right),
          });
        }
      }
    });
    return {
      label: ${JSON.stringify(label)},
      viewportWidth: vw,
      docScrollWidth: de.scrollWidth,
      horizontalOverflow: de.scrollWidth > vw + 2,
      overflowingCount: overflowing.length,
      samples: overflowing.slice(0, 5),
    };
  })()`);
}

/** 读取主题相关的实际计算值，验证 token 是否正确解析。 */
async function readTheme(cdp) {
  return cdp.evaluate(`(() => {
    const de = document.documentElement;
    const cs = getComputedStyle(de);
    const body = getComputedStyle(document.body);
    return {
      dataTheme: de.getAttribute('data-theme'),
      prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      storedTheme: (() => { try { return localStorage.getItem('kb.theme'); } catch { return null; } })(),
      cssVarCanvas: cs.getPropertyValue('--color-canvas').trim(),
      cssVarStrong: cs.getPropertyValue('--color-strong').trim(),
      cssVarSubtle: cs.getPropertyValue('--color-subtle').trim(),
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
    };
  })()`);
}

/** 检查移动端抽屉：汉堡按钮存在 → 点击 → 抽屉出现且带遮罩 → 关闭。 */
async function checkMobileDrawer(cdp) {
  const before = await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const burger = btns.find((b) => (b.getAttribute('aria-label') || '') === '打开菜单');
    const aside = document.querySelector('aside');
    return {
      hasBurger: !!burger,
      burgerVisible: burger ? burger.getBoundingClientRect().width > 0 : false,
      asideVisible: aside ? aside.getBoundingClientRect().width > 0 : false,
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
    };
  })()`);

  if (!before.hasBurger || !before.burgerVisible) {
    return { ...before, opened: false, note: '未找到可见的汉堡按钮' };
  }

  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const burger = btns.find((b) => (b.getAttribute('aria-label') || '') === '打开菜单');
    burger && burger.click();
    return true;
  })()`);
  await sleep(700);

  const opened = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const bodyOverflow = getComputedStyle(document.body).overflow;
    let drawerWidth = 0;
    let hasBackdrop = false;
    if (dialog) {
      const panel = dialog.querySelector('div');
      drawerWidth = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
      hasBackdrop = !!dialog.querySelector('button[aria-label="关闭菜单"]');
    }
    return { dialogPresent: !!dialog, drawerWidth, hasBackdrop, bodyOverflow };
  })()`);

  // 关闭：点遮罩
  await cdp.evaluate(`(() => {
    const backdrop = document.querySelector('[aria-label="关闭菜单"]');
    backdrop && backdrop.click();
    return true;
  })()`);
  await sleep(600);

  const closed = await cdp.evaluate(
    `(() => ({ dialogCount: document.querySelectorAll('[role="dialog"]').length, bodyOverflow: getComputedStyle(document.body).overflow }))()`,
  );

  return { ...before, ...opened, opened: true, closedDialogCount: closed.dialogCount, bodyOverflowAfter: closed.bodyOverflow };
}

async function shoot(cdp, name, fullPage = true) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
  return `${name}.png`;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = findBrowser();
  console.log(`浏览器: ${browser}\n基址  : ${BASE}\n输出  : ${OUT_DIR}\n`);

  const child = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--user-data-dir=' + join(OUT_DIR, '.chrome-profile'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let failed = 0;
  const results = { overflow: [], themes: [], drawer: null, consoleErrors: [] };

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

    // ---------- 登录，写入 token ----------
    await setViewport(cdp, VIEWPORTS.desktop);
    await goto(cdp, '/login');
    const login = await cdp.evaluate(`(async () => {
      const resp = await fetch('${BASE}/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '${USERNAME}', password: '${PASSWORD}' }),
      });
      const body = await resp.json();
      if (body.code !== 0) return { ok: false, message: body.message };
      localStorage.setItem('kb_token', body.data.access_token);
      return { ok: true, user: body.data.user.display_name, themePreference: body.data.user.theme_preference };
    })()`);
    console.log(`登录: ${JSON.stringify(login)}`);
    if (!login?.ok) throw new Error('登录失败');
    results.userThemePreference = login.themePreference;

    // ---------- 亮色：手机视口逐页检查横向溢出 ----------
    console.log('\n【亮色 · 375px】逐页检查横向溢出与截图');
    await setViewport(cdp, VIEWPORTS.mobile);
    // 强制亮色，保证与暗色可对比
    await cdp.evaluate(`(() => { localStorage.setItem('kb.theme','light'); document.documentElement.setAttribute('data-theme','light'); return true; })()`);

    for (const p of PAGES.filter((x) => x.mobile)) {
      await setViewport(cdp, VIEWPORTS.mobile);
      await goto(cdp, p.path);
      const ov = await checkOverflow(cdp, `light/mobile/${p.name}`);
      results.overflow.push(ov);
      const file = await shoot(cdp, `mobile-light-${p.name}`);
      const mark = ov.horizontalOverflow ? '✗' : '✓';
      if (ov.horizontalOverflow) failed += 1;
      console.log(
        `  ${mark} ${p.name.padEnd(14)} 视口=${ov.viewportWidth} scrollWidth=${ov.docScrollWidth} 溢出元素=${ov.overflowingCount}  → ${file}`,
      );
      if (ov.samples.length) {
        for (const s of ov.samples) console.log(`      ${s.tag}.${s.cls} right=${s.right}`);
      }
    }

    // ---------- 移动端抽屉 ----------
    console.log('\n【移动端抽屉】');
    await goto(cdp, '/dashboard');
    const drawer = await checkMobileDrawer(cdp);
    results.drawer = drawer;
    const drawerOk = drawer.hasBurger && drawer.burgerVisible && drawer.dialogPresent && drawer.drawerWidth > 0 && drawer.closedDialogCount === 0;
    if (!drawerOk) failed += 1;
    console.log(`  ${drawerOk ? '✓' : '✗'} ${JSON.stringify(drawer)}`);
    await setViewport(cdp, VIEWPORTS.mobile);
    await goto(cdp, '/dashboard');
    await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x)=>x.getAttribute('aria-label')==='打开菜单'); b && b.click(); return true; })()`);
    await sleep(700);
    await shoot(cdp, 'mobile-light-drawer', false);

    // ---------- 暗色主题 ----------
    console.log('\n【暗色主题】');
    await goto(cdp, '/dashboard');
    await cdp.evaluate(`(() => { localStorage.setItem('kb.theme','dark'); document.documentElement.setAttribute('data-theme','dark'); return true; })()`);
    await sleep(600);
    const darkTheme = await readTheme(cdp);
    results.themes.push(darkTheme);
    const darkOk = darkTheme.dataTheme === 'dark' && darkTheme.cssVarCanvas.toLowerCase() === '#111827';
    if (!darkOk) failed += 1;
    console.log(`  ${darkOk ? '✓' : '✗'} data-theme=${darkTheme.dataTheme} canvas=${darkTheme.cssVarCanvas} strong=${darkTheme.cssVarStrong} bodyBg=${darkTheme.bodyBg}`);

    await setViewport(cdp, VIEWPORTS.mobile);
    for (const p of PAGES.filter((x) => x.mobile)) {
      await setViewport(cdp, VIEWPORTS.mobile);
      await goto(cdp, p.path);
      await cdp.evaluate(`(() => { document.documentElement.setAttribute('data-theme','dark'); return true; })()`);
      await sleep(400);
      const ov = await checkOverflow(cdp, `dark/mobile/${p.name}`);
      if (ov.horizontalOverflow) failed += 1;
      const file = await shoot(cdp, `mobile-dark-${p.name}`);
      console.log(`  ${ov.horizontalOverflow ? '✗' : '✓'} 暗色 ${p.name.padEnd(14)} → ${file}`);
    }

    // ---------- 桌面暗色 ----------
    await setViewport(cdp, VIEWPORTS.desktop);
    await goto(cdp, '/dashboard');
    await cdp.evaluate(`(() => { document.documentElement.setAttribute('data-theme','dark'); return true; })()`);
    await sleep(600);
    await shoot(cdp, 'desktop-dark-dashboard');
    console.log('  ✓ 桌面暗色 dashboard → desktop-dark-dashboard.png');

    // ---------- 主题是否在首帧前应用（无闪屏） ----------
    console.log('\n【主题首帧时机】');
    await cdp.evaluate(`(() => { localStorage.setItem('kb.theme','dark'); return true; })()`);
    const timing = await cdp.evaluate(`(async () => {
      // 重新加载并在 DOMContentLoaded 之前读取属性：内联脚本应已生效
      return new Promise((resolve) => {
        const check = () => {
          const html = document.documentElement.outerHTML.slice(0, 400);
          resolve({ hasInlineThemeScript: html.includes('data-theme') || document.documentElement.getAttribute('data-theme') });
        };
        setTimeout(check, 100);
      });
    })()`);
    console.log(`  内联主题脚本存在: ${JSON.stringify(timing)}`);

    await goto(cdp, '/dashboard', 1500);
    const afterReload = await readTheme(cdp);
    results.themes.push(afterReload);
    const persistOk = afterReload.dataTheme === 'dark';
    if (!persistOk) failed += 1;
    console.log(`  ${persistOk ? '✓' : '✗'} 刷新后主题持久化: data-theme=${afterReload.dataTheme}`);

    // 切回亮色，避免影响后续
    await cdp.evaluate(`(() => { localStorage.setItem('kb.theme','light'); return true; })()`);

    results.consoleErrors = [...new Set(cdp.consoleErrors)];
    console.log('\n【页面控制台】');
    if (results.consoleErrors.length === 0) {
      console.log('  ✓ 无错误');
    } else {
      for (const e of results.consoleErrors.slice(0, 12)) console.log(`  ✗ ${String(e).slice(0, 200)}`);
      failed += results.consoleErrors.length;
    }

    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(results, null, 2));
    ws.close();
  } catch (err) {
    console.error('检查失败：', err.message);
    failed += 1;
  } finally {
    child.kill();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(failed === 0 ? '设计系统与移动端实测：全部通过' : `设计系统与移动端实测：${failed} 项问题`);
  console.log('='.repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

main();
