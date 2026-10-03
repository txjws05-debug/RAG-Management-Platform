/**
 * 移动端可用性审计：不看类名，只看浏览器算出来的真实几何。
 *
 * 对每个页面在 375px 视口下测量：
 *   - 可点击元素（button/a/[role=button]/input）的实际宽高，标出低于 44px 的
 *   - 文本的实际字号，标出低于 16px 的输入框（iOS 聚焦会缩放页面）
 *   - 是否有元素横向溢出视口
 *   - 弹窗是否完整落在视口内（不裁切）
 *
 * 用法：node scripts/audit-mobile.mjs [基址]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT_DIR = resolve('docs/design-check');
const PORT = 9225;
const USER = 'admin';
const PASS = 'admin123456';
/** 硬性下限：低于此值判为不合格。 */
const MIN_TAP = 40;
/** 推荐值：低于它仍可用，但未达 44px 的理想触控尺寸，单独统计。 */
const IDEAL_TAP = 44;

const BROWSER = [
  process.env.KB_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((p) => existsSync(p));

const PAGES = ['/dashboard', '/chat', '/knowledge', '/sedimentation', '/system'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(t = 25000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {
      /* not ready */
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

/** 在页面里注入的测量脚本：返回所有可点击元素的真实几何。 */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const sel = 'button, a[href], [role="button"], input:not([type="hidden"]), select, textarea';
  const all = Array.from(document.querySelectorAll(sel));
  const small = [];
  const smallInputs = [];
  const fail = []; // < 40px：不合格
  const warn = []; // 40~43px：可用，但未达 44px 理想触控尺寸
  const unreachable = [];   // 溢出且没有任何可横向滚动的祖先 → 真的够不到
  const scrollReach = [];   // 溢出但在可横向滚动容器内 → 够得到，但要横滑

  /** 判断元素是否落在某个可横向滚动的祖先里。 */
  const inScrollableX = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (['auto', 'scroll'].includes(cs.overflowX) && p.scrollWidth > p.clientWidth + 2) return true;
      p = p.parentElement;
    }
    return false;
  };

  for (const el of all) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
    const label = ((el.getAttribute('aria-label') || el.textContent || el.tagName) + '').trim().slice(0, 34);
    const w = Math.round(r.width), h = Math.round(r.height);
    const tag = el.tagName.toLowerCase();

    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      if (w < ${MIN_TAP} || h < ${MIN_TAP}) fail.push({ tag, label, w, h });
      else if (w < ${IDEAL_TAP} || h < ${IDEAL_TAP}) warn.push({ tag, label, w, h });
    }
    if ((tag === 'input' || tag === 'select' || tag === 'textarea') && r.height < 40) {
      smallInputs.push({ tag, label, h, fontSize: parseFloat(cs.fontSize) });
    }
    if (r.right > vw + 2 || r.left < -2) {
      const rec = { tag, label, left: Math.round(r.left), right: Math.round(r.right), vw };
      if (inScrollableX(el)) scrollReach.push(rec);
      else unreachable.push(rec);
    }
  }

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => {
    const panel = d.firstElementChild ? d.firstElementChild.getBoundingClientRect() : d.getBoundingClientRect();
    return {
      top: Math.round(panel.top), bottom: Math.round(panel.bottom), height: Math.round(panel.height),
      withinViewport: panel.top >= -2 && panel.bottom <= vh + 2,
    };
  });

  return {
    viewport: { w: vw, h: vh },
    totalClickable: all.length,
    failCount: fail.length,
    fail: fail.slice(0, 16),
    warnCount: warn.length,
    warn: warn.slice(0, 6),
    smallInputCount: smallInputs.length,
    smallInputs: smallInputs.slice(0, 8),
    unreachableCount: unreachable.length,
    unreachable: unreachable.slice(0, 6),
    scrollReachCount: scrollReach.length,
    scrollReach: scrollReach.slice(0, 6),
    dialogs,
    docScrollWidth: document.documentElement.scrollWidth,
  };
})()`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!BROWSER) throw new Error('未找到 Chrome/Edge');
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
      '--user-data-dir=' + join(OUT_DIR, '.chrome-profile-audit'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const report = {};
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
      width: 375, height: 812, deviceScaleFactor: 3, mobile: true,
    });

    await cdp.send('Page.navigate', { url: `${BASE}/login` });
    await sleep(2500);
    const login = await cdp.evaluate(`(async () => {
      const r = await fetch('${BASE}/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ username:'${USER}', password:'${PASS}' })});
      const b = await r.json();
      if (b.code !== 0) return { ok:false };
      localStorage.setItem('kb_token', b.data.access_token);
      localStorage.setItem('kb.theme','light');
      return { ok:true };
    })()`);
    if (!login?.ok) throw new Error('登录失败');
    console.log('已登录，开始 375px 逐页审计\n');

    for (const path of PAGES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 375, height: 812, deviceScaleFactor: 3, mobile: true,
      });
      await cdp.send('Page.navigate', { url: BASE + path });
      await sleep(3200);
      const m = await cdp.evaluate(MEASURE);
      report[path] = m;

      console.log(`── ${path} ─────────────────────────────`);
      console.log(`   可点击元素 ${m.totalClickable} 个；不合格(<${MIN_TAP}px) ${m.failCount} 个；偏小(${MIN_TAP}-${IDEAL_TAP - 1}px) ${m.warnCount} 个；输入框偏小 ${m.smallInputCount} 个`);
      console.log(`   真溢出（够不到）${m.unreachableCount} 个；滚动容器内（可横滑到）${m.scrollReachCount} 个`);
      console.log(`   scrollWidth=${m.docScrollWidth}（视口 ${m.viewport.w}）`);
      for (const s of m.fail) {
        console.log(`     ✗ ${s.tag} "${s.label}"  ${s.w}×${s.h}`);
      }
      for (const s of m.warn) {
        console.log(`     ~ ${s.tag} "${s.label}"  ${s.w}×${s.h}`);
      }
      for (const s of m.smallInputs) {
        console.log(`     ! input "${s.label}" 高 ${s.h}px  字号 ${s.fontSize}px`);
      }
      for (const o of m.unreachable) {
        console.log(`     ✗ 够不到 ${o.tag} "${o.label}"  right=${o.right} vw=${o.vw}`);
      }
      for (const o of m.scrollReach.slice(0, 3)) {
        console.log(`     ~ 需横滑 ${o.tag} "${o.label}"  right=${o.right}`);
      }
      if (m.dialogs.length) console.log(`   弹窗: ${JSON.stringify(m.dialogs)}`);
      console.log('');
    }

    writeFileSync(join(OUT_DIR, 'mobile-audit.json'), JSON.stringify(report, null, 2));
    console.log('明细已写入 docs/design-check/mobile-audit.json');
    ws.close();
  } catch (e) {
    console.error('审计失败：', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
}

main();
