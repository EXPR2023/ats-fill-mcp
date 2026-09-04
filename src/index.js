#!/usr/bin/env node
/**
 * ats-fill-mcp — 通用网申表单 AI 自动填写 MCP 服务器
 * ============================================================================
 * 定位：把“Agent 语义规划 + 页内批量执行”的混合方案固化为可复用服务。
 *   - Agent/LLM（即 MCP 客户端，如 Copilot）负责“语义规划”：
 *       调 inspect_form 看表单 → 结合简历给出 ops（按 msg/id/name 寻址、别名归一）
 *   - 本服务负责“快且稳的执行”：页内 native setter、select/radio/cascade/date/addRow。
 *
 * 浏览器接入（二选一）：
 *   1) 推荐 connectOverCDP —— 复用你“已登录”的 Chrome（需 --remote-debugging-port=9222）
 *       启动示例：chrome.exe --remote-debugging-port=9222（使用已登录网申站的用户目录）
 *   2) ALLOW_LAUNCH=1 时回退为自行 launch Chromium（未登录场景）
 *
 * 环境变量：CDP_URL（默认 http://127.0.0.1:9222）、ALLOW_LAUNCH、RESUME_PATH（可选，语义规划参考）
 *
 * 用法（MCP 客户端侧工作流）：
 *   1) inspect_form { url }              → 返回字段清单（msg/类型/当前值/选项/添加按钮）
 *   2) fill_form { ops: [...] }          → 按 ops 批量执行
 *   3) verify_form { msgs: [...] }       → 回读关键字段，确认已落值
 *
 * ops 支持类型（target 用 id / name / msg 任一寻址，优先级 id>name>msg）：
 *   {op:'text',   id|name|msg, value}           文本/textarea
 *   {op:'clear',  id|name|msg}                  清空
 *   {op:'date',   id|name|msg, value}           文本+回车(兼容日期控件)
 *   {op:'select', id|name|msg, value}           原生下拉（按选项文本模糊匹配）
 *   {op:'radio',  name|msg, label}              单选项组按标签勾选
 *   {op:'check',  name|msg, on:boolean}         checkbox
 *   {op:'cascade', cityId|cityName, provSub, citySub}  省市两级：自动定位 firstLevl+cityId 省级下拉
 *   {op:'addRow', text:'实习经历'(关键词), times} 点击“增加更多/继续添加 xxx”
 * ============================================================================
 */
import { chromium } from 'playwright-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = readFileSync(path.join(__dirname, 'engine.js'), 'utf8');

/* ============================== 浏览器 ============================== */
let browser = null;

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  const cdp = process.env.CDP_URL || 'http://127.0.0.1:9222';
  try {
    browser = await chromium.connectOverCDP(cdp);
  } catch (e) {
    if (process.env.ALLOW_LAUNCH === '1') {
      browser = await chromium.launch({ headless: false });
    } else {
      throw new Error(
        `无法连接浏览器 ${cdp}（${e.message}）。请用已登录的 Chrome 启动远程调试后重试：\n` +
        `chrome.exe --remote-debugging-port=9222`
      );
    }
  }
  return browser;
}

async function pageFor(url) {
  const b = await ensureBrowser();
  const ctx = b.contexts()[0] || (await b.newContext());
  let pages = ctx.pages().filter((p) => !p.isClosed());
  if (url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { /* noop */ }
    let p = pages.find((x) => { try { return new URL(x.url()).hostname === host; } catch (e) { return false; } });
    if (!p) p = await ctx.newPage();
    if (p.url() !== url) {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await p.waitForTimeout(1500);
    }
    return p;
  }
  const real = pages.find((p) => { try { const u = p.url(); return u && !/^(about:|chrome|devtools)/.test(u); } catch (e) { return false; } });
  return real || (await ctx.newPage());
}

async function injectEngine(page) {
  await page.evaluate(`try{delete window.__NC_AI__}catch(e){}`);
  await page.evaluate(ENGINE_SRC);
}

/* ============================== 页内脚本体 ============================== */
const INSPECT_BODY = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const c = window.__NC_AI__ ? window.__NC_AI__.capture() : null;
  const fields = [];
  const seen = {};
  document.querySelectorAll('input,select,textarea').forEach((el) => {
    if ((el.getAttribute('type') || '').toLowerCase() === 'hidden') return;
    const msg = el.getAttribute('msg');
    const ty = (el.getAttribute('type') || el.tagName).toLowerCase();
    let cur = '', lab = '', opts = [];
    if (el.tagName === 'SELECT') {
      const so = el.options[el.selectedIndex];
      cur = so ? clean(so.text) : '';
      opts = Array.from(el.options).map((o) => clean(o.text)).filter(Boolean).slice(0, 80);
    } else if (el.type === 'radio' || el.type === 'checkbox') {
      cur = el.checked ? 1 : 0;
      lab = clean(el.parentElement.innerText).slice(0, 8);
    } else {
      cur = clean(el.value).slice(0, 60);
    }
    if (msg) {
      const key = msg + '|' + (el.name || el.id || '') + '|' + ty;
      if (!seen[key]) {
        seen[key] = 1;
        fields.push({ msg, tag: el.tagName.toLowerCase(), type: ty, name: el.name || '', id: el.id || '', cur, lab, opts });
      }
    }
  });
  return {
    url: location.href,
    title: document.title,
    engineFields: c ? c.fields.length : 0,
    msgFields: fields,
    addButtons: c ? c.addButtons : [],
  };
};

const FILL_BODY = async (ops) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const fire = (el, t) => { try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) { /*noop*/ } };
  const out = [];
  const push = (o) => out.push(o);

  function resolve(spec) {
    if (spec.id) { const e = document.getElementById(spec.id); if (e) return e; }
    if (spec.name) { const e = document.querySelector('[name="' + spec.name + '"]'); if (e) return e; }
    if (spec.msg) {
      const list = Array.from(document.querySelectorAll('input,select,textarea'))
        .filter((el) => el.getAttribute('msg') === spec.msg && (el.getAttribute('type') || '') !== 'hidden' && (el.type !== 'radio' || el.checked || true));
      if (list.length) return list[0];
    }
    return null;
  }

  function groupName(spec) {
    const el = resolve(spec);
    if (!el) return '';
    if (el.name) return el.name;
    if (spec.msg) {
      const r = document.querySelector('input[type=radio][msg="' + spec.msg + '"]');
      return r ? r.name : '';
    }
    return '';
  }

  function doText(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, String(v)); else el.value = String(v);
    fire(el, 'input'); fire(el, 'change');
  }

  function doSelect(el, want) {
    const opts = Array.from(el.options);
    let o = opts.find((x) => clean(x.text) === want);
    if (!o) o = opts.find((x) => clean(x.text).indexOf(want) >= 0 && want.length >= 2);
    if (!o) return null;
    el.value = o.value;
    fire(el, 'input'); fire(el, 'change');
    return { chosen: clean(o.text).slice(0, 30) };
  }

  async function doCascade(op) {
    const city = op.cityId ? document.getElementById(op.cityId)
      : (op.cityName ? document.querySelector('[name="' + op.cityName + '"]') : resolve(op));
    if (!city) return { ok: false, note: '城市下拉未找到' };
    let prov = null;
    if (city.name) prov = document.getElementById('firstLevl' + city.name);
    if (!prov) {
      const m = city.getAttribute('msg');
      if (m) {
        const sels = Array.from(document.querySelectorAll('select')).filter((s) => s.getAttribute('msg') === m);
        prov = sels.find((s) => s !== city && s.options.length >= 15) || sels.find((s) => s !== city);
      }
    }
    if (!prov) return { ok: false, note: '省级下拉未找到(firstLevl+cityId)' };
    const pops = Array.from(prov.options);
    let po = pops.find((x) => clean(x.text).indexOf(op.provSub) >= 0 && clean(x.text).length >= 2);
    if (!po) return { ok: false, note: '省级无匹配:' + op.provSub, sample: pops.slice(0, 10).map((x) => clean(x.text)) };
    prov.value = po.value; fire(prov, 'input'); fire(prov, 'change');
    await sleep(1000);
    let co = null;
    for (let i = 0; i < 6; i++) {
      const cops = Array.from(city.options).filter((x) => clean(x.text) !== '请选择');
      co = cops.find((x) => clean(x.text).indexOf(op.citySub) >= 0);
      if (co) break;
      await sleep(400);
    }
    if (!co) return { ok: false, note: '市级无匹配:' + op.citySub, prov: clean(po.text), sample: Array.from(city.options).slice(0, 12).map((x) => clean(x.text)) };
    city.value = co.value; fire(city, 'input'); fire(city, 'change');
    return { ok: true, prov: clean(po.text).slice(0, 14), city: clean(co.text).slice(0, 14) };
  }

  async function doAddRow(op) {
    const times = op.times || 1;
    let clicked = 0;
    for (let k = 0; k < times; k++) {
      const all = Array.from(document.querySelectorAll('body *')).filter((el) => {
        if (el.children.length > 3 || el.querySelector('input,select,textarea')) return false;
        const t = clean(el.innerText || '');
        if (!t || t.length > 40) return false;
        if (!/^(增加更多|继续添加|添加|新增)/.test(t)) return false;
        if (op.text && t.indexOf(op.text) < 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const btn = all[all.length - 1];
      if (!btn) return { ok: false, clicked, note: '找不到添加按钮: ' + (op.text || '') };
      try { btn.click(); } catch (e) { return { ok: false, clicked, note: String(e && e.message || e) }; }
      clicked++;
      await sleep(600);
    }
    return { ok: true, clicked };
  }

  for (const op of (ops || [])) {
    try {
      switch (op.op) {
        case 'text':
        case 'clear': {
          const el = resolve(op);
          if (!el) { push({ op: op.op, ok: false, note: '控件未找到' }); break; }
          doText(el, op.op === 'clear' ? '' : (op.value == null ? '' : op.value));
          fire(el, 'blur');
          push({ op: op.op, ok: true, after: clean(el.value).slice(0, 40) });
          break;
        }
        case 'date': {
          const el = resolve(op);
          if (!el) { push({ op: 'date', ok: false, note: '控件未找到' }); break; }
          const v = String(op.value || '');
          el.focus();
          doText(el, v);
          try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true })); } catch (e) { /*noop*/ }
          fire(el, 'change'); fire(el, 'blur');
          let after = clean(el.value);
          if (!after && v.indexOf('-') >= 0) { doText(el, v.replace(/-/g, '/')); fire(el, 'change'); fire(el, 'blur'); after = clean(el.value); }
          push({ op: 'date', ok: !!after, after: after.slice(0, 20) });
          break;
        }
        case 'select': {
          const el = resolve(op);
          if (!el || el.tagName !== 'SELECT') { push({ op: 'select', ok: false, note: '非原生select或未找到' }); break; }
          const r = doSelect(el, op.value);
          if (!r) push({ op: 'select', ok: false, note: '无匹配选项:' + op.value, sample: Array.from(el.options).slice(0, 15).map((x) => clean(x.text)) });
          else push({ op: 'select', ok: true, chosen: r.chosen, after: el.value });
          break;
        }
        case 'radio': {
          const nm = op.name || groupName(op);
          const rs = Array.from(document.querySelectorAll('input[type=radio][name="' + nm + '"]'));
          let hit = false;
          for (const r of rs) {
            const lab = clean(r.parentElement.innerText) || r.value;
            if (lab.indexOf(op.label) >= 0 || r.value === op.label) {
              if (!r.checked) { try { r.click(); } catch (e) { r.checked = true; fire(r, 'change'); } }
              push({ op: 'radio', ok: true, label: op.label, chosen: lab.slice(0, 8) });
              hit = true; break;
            }
          }
          if (!hit) push({ op: 'radio', ok: false, label: op.label, note: '无匹配', opts: rs.map((r) => (clean(r.parentElement.innerText) || r.value).slice(0, 8)) });
          break;
        }
        case 'check': {
          const el = resolve(op);
          if (!el || el.type !== 'checkbox') { push({ op: 'check', ok: false, note: '非checkbox或未找到' }); break; }
          const want = !!op.on;
          if (want && !el.checked) el.click();
          else if (!want && el.checked) el.click();
          push({ op: 'check', ok: true, checked: el.checked });
          break;
        }
        case 'cascade': {
          const r = await doCascade(op);
          push(Object.assign({ op: 'cascade' }, r));
          break;
        }
        case 'addRow': {
          const r = await doAddRow(op);
          push(Object.assign({ op: 'addRow' }, r));
          break;
        }
        default:
          push({ op: op.op, ok: false, note: '未知操作' });
      }
    } catch (e) {
      push({ op: op.op, ok: false, note: String(e && e.message || e) });
    }
  }
  const okN = out.filter((x) => x.ok).length;
  return { total: out.length, success: okN, fail: out.length - okN, results: out };
};

const VERIFY_BODY = (msgs) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = {};
  (msgs || []).forEach((m) => {
    const hits = Array.from(document.querySelectorAll('input,select,textarea'))
      .filter((el) => el.getAttribute('msg') === m && (el.getAttribute('type') || '') !== 'hidden');
    if (m === '*') {
      // 全量：按 msg 取首个，radio 记录整组
    }
    hits.forEach((el, idx) => {
      if (idx > 0 && (el.type !== 'radio')) return;
      let v;
      if (el.tagName === 'SELECT') { const so = el.options[el.selectedIndex]; v = so ? clean(so.text) : ''; }
      else if (el.type === 'radio' || el.type === 'checkbox') { v = el.checked ? 1 : 0; }
      else v = clean(el.value);
      if (el.type === 'radio') {
        const lab = clean(el.parentElement.innerText);
        out[m + ':' + lab] = v;
      } else if (!(m in out)) {
        out[m] = v;
      }
    });
    if (!hits.length) out[m] = '(无该字段)';
  });
  return out;
};

/* ============================== MCP Server ============================== */
const server = new McpServer({ name: 'ats-fill-mcp', version: '0.1.0' });

server.tool(
  'navigate',
  '打开/聚焦目标网申页面并注入执行引擎，返回页面标题与控件数。',
  { url: z.string().describe('目标网申表单 URL') },
  async ({ url }) => {
    const page = await pageFor(url);
    await injectEngine(page);
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      controls: document.querySelectorAll('input,select,textarea').length,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(info, null, 1) }] };
  }
);

server.tool(
  'inspect_form',
  '采集当前(或给定 url)网申表单结构：带 msg 语义的字段清单、当前值、下拉选项、可用的“添加更多”按钮。用于 Agent 语义规划。',
  { url: z.string().optional().describe('可选：要导航并采集的表单 URL') },
  async ({ url }) => {
    const page = await pageFor(url);
    await injectEngine(page);
    const data = await page.evaluate(INSPECT_BODY);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] };
  }
);

server.tool(
  'fill_form',
  '按 ops 批量执行填写/纠错。支持 text/date/select/radio/check/cascade/addRow；控件用 id/name/msg 寻址。返回每项成功与否与回读值。',
  { ops: z.array(z.any()).describe('填写操作数组，见工具说明') },
  async ({ ops }) => {
    const page = await pageFor();
    await injectEngine(page);
    const data = await page.evaluate(FILL_BODY, ops);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] };
  }
);

server.tool(
  'verify_form',
  '回读指定 msg 字段当前真实值，用于填写后校验。传 ["*"] 可返回全部。',
  { msgs: z.array(z.string()).describe('要校验的字段语义(msg)，如 ["姓名","民族","企业名称"] 或 ["*"]') },
  async ({ msgs }) => {
    const page = await pageFor();
    await injectEngine(page);
    let out;
    if (msgs.length === 1 && msgs[0] === '*') {
      out = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const map = {};
        document.querySelectorAll('input,select,textarea').forEach((el) => {
          if ((el.getAttribute('type') || '') === 'hidden') return;
          const msg = el.getAttribute('msg');
          if (!msg) return;
          if (el.type === 'radio') {
            const lab = clean(el.parentElement.innerText);
            if (el.checked) map[msg] = (map[msg] ? map[msg] + ';' : '') + lab;
          } else if (el.type === 'checkbox') {
            if (!(msg in map)) map[msg] = el.checked ? '☑' : '☐';
          } else if (el.tagName === 'SELECT') {
            if (!(msg in map)) { const so = el.options[el.selectedIndex]; map[msg] = so ? clean(so.text) : ''; }
          } else if (!(msg in map)) {
            map[msg] = clean(el.value).slice(0, 40);
          }
        });
        return map;
      });
    } else {
      out = await page.evaluate(VERIFY_BODY, msgs);
    }
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
  }
);

/* ============================== 启动 ============================== */
const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error('[ats-fill-mcp] running (stdio). CDP=' + (process.env.CDP_URL || 'http://127.0.0.1:9222'));
