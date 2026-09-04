/**
 * ats-fill-mcp 端到端冒烟测试
 * 步骤：1) 用本机 Chrome 以 --remote-debugging-port 启动 headless
 *       2) 启动真实 MCP server (stdio) 并完成 JSON-RPC 握手
 *       3) 对 file:// 迷你表单调用 navigate / inspect_form / fill_form / verify_form
 * 用法：node smoke.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9333;
const CDP = `http://127.0.0.1:${PORT}`;

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chrome = chromeCandidates.find((c) => c && existsSync(c));
if (!chrome) {
  console.error('未找到 Chrome/Edge，跳过端到端冒烟（代码烟测已通过）。');
  process.exit(0);
}

const userDir = mkdtempSync(path.join(tmpdir(), 'ats-smoke-'));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>smoke form</title></head><body>
<div>
  <div class="mdf-table-cell-l"><span>*</span>姓名</div><input msg="姓名" id="11_2_1" name="11_2_1">
  <div class="mdf-table-cell-l">证件号码</div><input msg="证件号码" id="11_100_1" name="11_100_1">
  <div class="mdf-table-cell-l">民族</div>
  <select msg="民族" id="11_23_1" name="11_23_1"><option value="">请选择</option><option>汉族</option><option>壮族</option></select>
  <div class="mdf-table-cell-l">性别</div>
  <label><input type="radio" msg="性别" name="11_20_1" value="m">男</label>
  <label><input type="radio" msg="性别" name="11_20_1" value="f">女</label>
  <div class="mdf-table-cell-l">同意</div><label><input type="checkbox" msg="同意声明" name="agree"></label>
  <div class="mdf-table-cell-l">籍贯(级联)</div>
  <select id="firstLevl11_245_1"><option value="">请选择</option><option value="hb">湖北</option></select>
  <select msg="籍贯" id="11_245_1" name="11_245_1"><option value="">请选择</option></select>
  <div class="mdf-table-cell-l">工作描述</div><textarea msg="工作描述" name="desc"></textarea>
  <button type="button">继续添加 实习经历</button>
</div>
</body></html>`;
const htmlFile = path.join(userDir, 'form.html');
writeFileSync(htmlFile, html);

// ---- 1) 启动 headless Chrome（远程调试）
const chromeProc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' });

async function waitCdp(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(CDP + '/json/version'); if (r.ok) return; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP 未就绪');
}

// ---- 2) 简单 JSON-RPC over stdio
function startMcp() {
  const p = spawn(process.execPath, [path.join(__dirname, 'src', 'index.js')], {
    env: { ...process.env, CDP_URL: CDP },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const pending = [];
  const idSeq = { n: 0 };
  const waiter = (ms) => new Promise((r) => setTimeout(r, ms));
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const w = pending.shift();
      if (w && w.id === msg.id) w.resolve(msg);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++idSeq.n;
    pending.push({ id, resolve, reject });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { const i = pending.findIndex((x) => x.id === id); if (i >= 0) { pending.splice(i, 1); reject(new Error('超时: ' + method)); } }, 30000);
  });
  return { p, call, waiter };
}

let code = 1;
try {
  await waitCdp();
  const m = startMcp();
  await m.waiter(600);
  const url = 'file:///' + htmlFile.replace(/\\/g, '/');

  const init = await m.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  console.log('initialize:', init.result && init.result.serverInfo);

  const nav = await m.call('tools/call', { name: 'navigate', arguments: { url } });
  const navText = JSON.parse(nav.result.content[0].text);
  console.log('navigate ok:', navText.title === 'smoke form');

  const insp = await m.call('tools/call', { name: 'inspect_form', arguments: {} });
  const inspText = JSON.parse(insp.result.content[0].text);
  console.log('inspect has 民族/籍贯/工作描述:', /民族/.test(JSON.stringify(inspText.msgFields)), /籍贯/.test(JSON.stringify(inspText.msgFields)), /工作描述/.test(JSON.stringify(inspText.msgFields)));

  const fill = await m.call('tools/call', {
    name: 'fill_form',
    arguments: {
      ops: [
        { op: 'text', msg: '姓名', value: '张晓峰' },
        { op: 'text', msg: '证件号码', value: '421022200502060614' },
        { op: 'select', msg: '民族', value: '汉族' },
        { op: 'radio', msg: '性别', label: '男' },
        { op: 'check', msg: '同意声明', on: true },
        { op: 'text', msg: '工作描述', value: '协助导师检索 OCR 论文' },
      ],
    },
  });
  const fillText = JSON.parse(fill.result.content[0].text);
  const fillOk = fillText.success === 6 && fillText.fail === 0;
  console.log('fill success(6/6):', fillOk, JSON.stringify(fillText.results.map((r) => ({ op: r.op, ok: r.ok, note: r.note || r.after || r.chosen || '' }))));

  const verify = await m.call('tools/call', { name: 'verify_form', arguments: { msgs: ['姓名', '民族', '性别', '工作描述'] } });
  const vText = JSON.parse(verify.result.content[0].text);
  console.log('verify 姓名:', vText['姓名'], '| 民族:', vText['民族'], '| 性别:', JSON.stringify(vText), '| 工作描述:', vText['工作描述']);
  const vOk = vText['姓名'] === '张晓峰' && vText['民族'] === '汉族' && vText['工作描述'] === '协助导师检索 OCR 论文';

  code = (fillOk && vOk) ? 0 : 1;
  m.p.kill();
} catch (e) {
  console.error('SMOKE FAIL:', e.message);
}
try { chromeProc.kill(); } catch (e) { /*noop*/ }
process.exit(code);
