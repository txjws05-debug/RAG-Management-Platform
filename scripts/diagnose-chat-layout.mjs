/**
 * 聊天页移动端布局诊断：量出容器与滚动区的真实高度关系。
 *
 * 要回答的问题：section 是否超出视口？消息滚动区是否被内容撑高而不是内部滚动？
 * sticky 输入区是否与内容重叠？
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT_DIR = resolve('docs/design-check');
const PORT = 9226;
const BROWSER = [
  process.env.KB_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((p) => existsSync(p));

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

mkdirSync(OUT_DIR, { recursive: true });
if (!BROWSER) throw new Error('未找到浏览器');
const child = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
    '--user-data-dir=' + join(OUT_DIR, '.chrome-profile-chat'),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  await waitForDevtools();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
  });

  await cdp.send('Page.navigate', { url: `${BASE}/login` });
  await sleep(2500);
  await cdp.evaluate(`(async () => {
    const r = await fetch('${BASE}/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username:'admin', password:'admin123456' })});
    const b = await r.json();
    localStorage.setItem('kb_token', b.data.access_token);
    localStorage.setItem('kb.theme','light');
  })()`);
  await cdp.send('Page.navigate', { url: `${BASE}/chat` });
  await sleep(3500);

  const info = await cdp.evaluate(`(() => {
    const vh = window.innerHeight;
    const main = document.querySelector('main');
    const section = main ? main.querySelector('section') : null;
    const scrollArea = section ? section.querySelector('.overflow-y-auto') : null;
    const inputBar = section ? section.lastElementChild : null;
    const pick = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom),
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        overflowY: cs.overflowY, minH: cs.minHeight, height: cs.height, flex: cs.flex,
      };
    };
    // 空态卡片与输入框是否重叠
    let overlap = null;
    if (scrollArea && inputBar) {
      const a = scrollArea.getBoundingClientRect(), b = inputBar.getBoundingClientRect();
      overlap = { scrollBottom: Math.round(a.bottom), inputTop: Math.round(b.top), overlaps: a.bottom > b.top + 1 };
    }
    return {
      viewportHeight: vh,
      bodyScrollHeight: document.body.scrollHeight,
      pageScrolls: document.documentElement.scrollHeight > vh + 2,
      main: pick(main), section: pick(section), scrollArea: pick(scrollArea), inputBar: pick(inputBar),
      overlap,
    };
  })()`);

  console.log('视口高度        :', info.viewportHeight);
  console.log('body 滚动高度   :', info.bodyScrollHeight, info.pageScrolls ? '(页面整体可滚 → 不是内部滚动)' : '(页面不滚)');
  for (const key of ['main', 'section', 'scrollArea', 'inputBar']) {
    const v = info[key];
    if (!v) { console.log(`${key.padEnd(12)}: 未找到`); continue; }
    console.log(
      `${key.padEnd(12)}: 高=${String(v.h).padStart(5)}  top=${String(v.top).padStart(4)} bottom=${String(v.bottom).padStart(5)}  ` +
      `scrollH=${v.scrollH} clientH=${v.clientH}  overflowY=${v.overflowY} minH=${v.minH} flex=${v.flex}`,
    );
  }
  console.log('重叠检查        :', JSON.stringify(info.overlap));

  ws.close();
} catch (e) {
  console.error('诊断失败：', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
