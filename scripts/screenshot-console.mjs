/**
 * 控制台界面截图工具（Chrome DevTools Protocol，零外部依赖）。
 *
 * 用途：对已启动的 http://127.0.0.1:8080 做真实浏览器渲染截图，
 * 用于验证 9 项验收标准里的界面部分（登录、问答工作台、看板、台账、沉淀、系统配置）。
 *
 * 用法：
 *   node scripts/screenshot-console.mjs [输出目录] [基址]
 * 依赖：本机已安装 Chrome 或 Edge；Node.js >= 22（内置 fetch 与 WebSocket）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT_DIR = resolve(process.argv[2] || 'docs/screenshots');
const BASE = process.argv[3] || 'http://127.0.0.1:8080';
const PORT = 9222;
const USERNAME = process.env.KB_SCREENSHOT_USER || 'admin';
const PASSWORD = process.env.KB_SCREENSHOT_PASSWORD || 'admin123456';

const BROWSER_CANDIDATES = [
  process.env.KB_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const path of BROWSER_CANDIDATES) {
    if (existsSync(path)) return path;
  }
  throw new Error('未找到 Chrome/Edge，可通过环境变量 KB_BROWSER 指定可执行文件路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (resp.ok) return await resp.json();
    } catch {
      /* 尚未就绪 */
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
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
      }, 45000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常: ${JSON.stringify(result.exceptionDetails.exception?.description)}`);
    }
    return result.result?.value;
  }
}

async function capture(cdp, name, url, { waitMs = 2600, fullPage = false, setup = null } = {}) {
  await cdp.send('Page.navigate', { url });
  await sleep(waitMs);
  if (setup) {
    await setup(cdp);
    await sleep(waitMs);
  }
  if (fullPage) {
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: Math.min(Math.ceil(size.height), 6000),
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`  已保存 ${name}.png`);
  if (fullPage) {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
  return shot;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = findBrowser();
  console.log(`浏览器: ${browser}`);
  console.log(`基址  : ${BASE}`);
  console.log(`输出  : ${OUT_DIR}\n`);

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
      '--window-size=1600,1000',
      '--user-data-dir=' + join(OUT_DIR, '.chrome-profile'),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  let exitCode = 0;
  try {
    await waitForDevtools();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到可用的页面目标');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails?.exception?.description || 'unknown exception');
      }
    });

    console.log('1) 登录页');
    await capture(cdp, '01-login', `${BASE}/login`);

    console.log('2) 执行登录（真实调用后端）');
    const loginResult = await cdp.evaluate(`(async () => {
      const resp = await fetch('${BASE}/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '${USERNAME}', password: '${PASSWORD}' }),
      });
      const body = await resp.json();
      if (body.code !== 0) return { ok: false, status: resp.status, message: body.message };
      localStorage.setItem('kb_token', body.data.access_token);
      return { ok: true, user: body.data.user.display_name, permissions: body.data.user.permissions.length };
    })()`);
    console.log(`   ${JSON.stringify(loginResult)}`);
    if (!loginResult?.ok) throw new Error('登录失败，无法继续截图');

    console.log('3) 运营看板');
    await capture(cdp, '02-dashboard', `${BASE}/dashboard`, { waitMs: 4200 });

    console.log('4) AI 问答工作台');
    await capture(cdp, '03-chat', `${BASE}/chat`, { waitMs: 3200 });

    console.log('5) 在问答工作台真实发起一次提问（含 SSE 流式渲染）');
    // 先新建会话，确保截图呈现的是「本轮最新问答」而不是历史消息回放。
    // 注意：新会话按钮可能带二次确认，这里点击后若出现确认按钮则一并确认。
    const newSession = await cdp.evaluate(`(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /新会话/.test(b.textContent || ''));
      if (!btn) return { ok: false, reason: '未找到新会话按钮' };
      btn.click();
      await new Promise((r) => setTimeout(r, 800));
      const dialogText = document.body.innerText.slice(0, 0);
      const confirm = Array.from(document.querySelectorAll('button')).find((b) =>
        /^(确定|确认|清空|是)$/.test((b.textContent || '').trim()),
      );
      if (confirm) { confirm.click(); await new Promise((r) => setTimeout(r, 800)); }
      return { ok: true, confirmed: Boolean(confirm) };
    })()`);
    console.log(`   新建会话: ${JSON.stringify(newSession)}`);
    await sleep(1800);
    const asked = await cdp.evaluate(`(async () => {
      const areas = Array.from(document.querySelectorAll('textarea, input[type=text]'));
      const box = areas.find((el) => el.offsetParent !== null);
      if (!box) return { ok: false, reason: '未找到输入框' };
      const setter = Object.getOwnPropertyDescriptor(
        box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(box, '差旅报销标准里，一线城市住宿费上限是多少？');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const afterType = { value: box.value, disabled: box.disabled };
      const send = Array.from(document.querySelectorAll('button')).find((b) => {
        const text = (b.textContent || '').trim();
        // 必须精确匹配，否则会误选到含「提交」二字的历史会话条目
        return text === '发送' || text === '提问' || text === '提交';
      });
      if (!send) return { ok: false, reason: '未找到发送按钮', afterType };
      const sendState = { text: (send.textContent || '').trim(), disabled: send.disabled };
      send.click();
      await new Promise((r) => setTimeout(r, 1200));
      const busy = Array.from(document.querySelectorAll('button')).some((b) =>
        /停止|生成中|取消/.test(b.textContent || ''),
      );
      return { ok: true, afterType, sendState, busyAfterClick: busy };
    })()`);
    console.log(`   ${JSON.stringify(asked)}`);
    await sleep(8000);
    const diagnostics = await cdp.evaluate(`(() => {
      const out = [];
      const cards = Array.from(document.querySelectorAll('div,li,article')).filter((el) => {
        const t = el.innerText || '';
        return /相关度/.test(t) && t.length < 220;
      });
      for (const c of cards.slice(-8)) {
        out.push((c.innerText || '').replace(/\\n+/g, ' | ').trim());
      }
      const answer = Array.from(document.querySelectorAll('*'))
        .filter((el) => /知识引用溯源/.test(el.textContent || ''))
        .map((el) => el.closest('div')?.innerText || '');
      return { citations: out, tail: (answer.slice(-1)[0] || '').slice(0, 400) };
    })()`);
    console.log('   引用卡片实测内容：');
    for (const line of diagnostics.citations || []) console.log('     -', line);
    console.log('   答案区尾部：', String(diagnostics.tail || '').replace(/\n+/g, ' | ').slice(0, 260));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(OUT_DIR, '04-chat-answer.png'), Buffer.from(shot.data, 'base64'));
    console.log('  已保存 04-chat-answer.png');

    console.log('6) 知识维护与导入中心');
    await capture(cdp, '05-knowledge', `${BASE}/knowledge`, { waitMs: 3200 });

    console.log('7) 知识沉淀与运营管理');
    await capture(cdp, '06-sedimentation', `${BASE}/sedimentation`, { waitMs: 3200 });

    console.log('8) 组织架构与系统配置');
    await capture(cdp, '07-system', `${BASE}/system`, { waitMs: 3200 });

    if (errors.length) {
      console.log('\n页面控制台错误：');
      for (const e of [...new Set(errors)].slice(0, 15)) console.log('  -', String(e).slice(0, 240));
    } else {
      console.log('\n页面控制台无错误。');
    }
    ws.close();
  } catch (error) {
    console.error('截图失败：', error.message);
    exitCode = 1;
  } finally {
    child.kill();
  }
  process.exit(exitCode);
}

main();
