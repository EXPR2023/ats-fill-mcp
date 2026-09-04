/*!
 * NC-AI Autofill Engine v1.0.0
 * 页内“采集 + 批量执行”引擎（继承牛客自动填表脚本的控件处理能力，并修复其“几何错位”缺陷）。
 *
 * 设计：Agent/LLM 负责“语义规划”（读简历 → 字段→值、别名归一、行数决策），
 *       本引擎只负责“快”：整页批量、native setter、下拉/日期/勾选/加行。
 *
 * 注入后暴露：window.__NC_AI__ = { version, capture(), exec(ops), helpers }
 *  - capture(): 返回 { ok, url, title, fields[], addButtons[] }，并在内部缓存 fid→元素 引用。
 *  - exec(ops): 批量执行；ops 元素见各函数注释。fid 必须来自“最近一次 capture”且 DOM 未大变。
 *  - 变更行数（clickAddN）后必须先重新 capture 再填值（fid 会移位）。
 *
 * 事件兼容：React/Vue/原生 输入框用 descriptor setter + input/change/keyboard 事件。
 * 下拉兼容：原生 select、以及 el-select/ant-select/role=combobox 等通用自定义下拉。
 */
(function () {
  'use strict';
  if (window.__NC_AI__) return window.__NC_AI__;

  var VERSION = '1.0.0';

  // ---------------- 基础工具 ----------------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function qsa(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }
  function norm(s) { return String(s == null ? '' : s).replace(/[\s\u00a0\u3000]/g, '').replace(/[*＊]/g, '').toLowerCase(); }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function fire(el, type) { try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) { /*noop*/ } }
  function fireKey(el, key, code) {
    try { el.dispatchEvent(new KeyboardEvent('keydown', { key: key, keyCode: code, which: code, bubbles: true })); } catch (e) { /*noop*/ }
    try { el.dispatchEvent(new KeyboardEvent('keyup', { key: key, keyCode: code, which: code, bubbles: true })); } catch (e) { /*noop*/ }
  }
  function isHidden(el) {
    try {
      var st = window.getComputedStyle(el);
      if (!st) return false;
      if (st.display === 'none' || st.visibility === 'hidden') return true;
      if (st.opacity === '0') return true;
      var r = el.getBoundingClientRect();
      return r.width < 2 || r.height < 2;
    } catch (e) { return true; }
  }
  function ownText(el) {
    var t = '';
    try {
      var kids = el.childNodes;
      for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 3) t += kids[i].nodeValue || '';
    } catch (e) { /*noop*/ }
    return clean(t);
  }
  function dirText(el) { try { return clean(el.innerText || el.textContent || ''); } catch (e) { return ''; } }
  function closestBy(el, fn, max) {
    var n = el, d = 0, m = max == null ? 8 : max;
    while (n && d <= m) { try { if (fn(n)) return n; } catch (e) { /*noop*/ } n = n.parentElement; d++; }
    return null;
  }

  // 控件/下拉通用选择器（大易 WinTalent、北森、智联、牛客等常见框架）
  var COMBO_CSS = [
    '[role="combobox"]', '.el-select', '.el-cascader', '.el-date-editor',
    '.ant-select', '.ant-picker', '.kuma-select', '.lxselect',
    '.select2-container', '.atsx-select', '.ivu-select', '.ui-select',
    '[class*="select-container"]', '[class*="dropdown-trigger"]'
  ].join(', ');
  var NON_TEXT = ['button', 'submit', 'reset', 'hidden', 'file', 'image'];

  // ---------------- 状态缓存 ----------------
  var lastEls = [];    // fid -> element
  var lastAdd = [];    // [{el, text}]

  // ---------------- 字段标签识别 ----------------
  function fieldLabel(el) {
    var t;
    // label[for]
    if (el.id) {
      try {
        var lf = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lf) { t = clean(lf.innerText); if (t) return t.slice(0, 40); }
      } catch (e) { /*noop*/ }
    }
    // 包裹 label
    var wrap = closestBy(el, function (n) { return n.tagName === 'LABEL'; }, 4);
    if (wrap) { t = clean(wrap.innerText); if (t) return t.slice(0, 40); }
    // aria
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label')).slice(0, 40);
    var al = el.getAttribute('aria-labelledby');
    if (al) { var n = document.getElementById(al); if (n) return clean(n.innerText).slice(0, 40); }
    // placeholder
    if (el.getAttribute && el.getAttribute('placeholder')) return clean(el.getAttribute('placeholder')).slice(0, 40);
    // 前向兄弟短文本（1-3 个）
    var sib = el.previousElementSibling;
    for (var i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
      if (sib && !sib.querySelector('input,select,textarea')) {
        t = clean(sib.innerText);
        if (t && t.length <= 30) return t.slice(0, 40);
      }
    }
    return '';
  }

  // 行/区块上下文（供 LLM 语义判断，截断 150 字）
  function blockCtx(el) {
    var n = el;
    for (var d = 0; d < 6 && n; d++, n = n.parentElement) {
      if (n === document.body || n === document.documentElement) break;
      var t = dirText(n);
      if (t.length > 6 && t.length < 220) return t.slice(0, 150);
    }
    return '';
  }

  function inferType(el) {
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    var ty = (el.getAttribute('type') || 'text').toLowerCase();
    if (ty === 'checkbox') return 'checkbox';
    if (ty === 'radio') return 'radio';
    if (ty === 'date' || ty === 'month' || ty === 'time' || ty === 'datetime-local' || ty === 'week') return 'date';
    if (ty === 'number') return 'number';
    if (ty === 'tel') return 'tel';
    if (ty === 'email') return 'email';
    if (ty === 'url') return 'url';
    if (el.readOnly || el.hasAttribute('readonly')) {
      // 只读输入往往是自定义下拉/日期触发框
      var contR = closestBy(el, function (n) { return n.matches && n.matches(COMBO_CSS); }, 5);
      return contR ? 'pick' : 'readonly';
    }
    var cont = closestBy(el, function (n) { return n.matches && n.matches(COMBO_CSS); }, 5);
    if (cont) {
      var dt = dirText(cont);
      if (/年|月|日|日期|时间/.test(dt) && dt.length <= 24) return 'date';
      return 'pick';
    }
    return 'text';
  }

  // ---------------- 采集 ----------------
  function rowLabel(el) {
    var n = el;
    for (var d = 0; d < 5 && n; d++, n = n.parentElement) {
      if (n === document.body || n === document.documentElement) break;
      var cells = qsa('[class*="cell-l"],[class*="label"],[class*="title"],th,dt,legend', n);
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        if (c.contains(el)) continue;
        var t = clean(c.innerText || '');
        if (t && t.length <= 16) return t.slice(0, 40);
      }
    }
    return '';
  }
  function nearText(el) {
    var lab = closestBy(el, function (n) { return n.tagName === 'LABEL'; }, 3);
    if (lab) { var t = clean(lab.innerText); if (t) return t.slice(0, 20); }
    var p = el.parentElement;
    if (p) {
      var t2 = clean(p.innerText || '').replace(/^\s*\**\s*/, '');
      if (t2 && t2.length <= 12) return t2.slice(0, 20);
    }
    return '';
  }
  function collectControls() {
    var out = [];
    // 下拉：即使视觉上是透明覆盖层也纳入（options>0 且非 display:none 模板行）
    qsa('select').forEach(function (el) {
      if (el.disabled || el.hasAttribute('disabled')) return;
      if (!el.options || el.options.length === 0) return;
      try { if (window.getComputedStyle(el).display === 'none') return; } catch (e) { return; }
      out.push(el);
    });
    qsa('textarea').forEach(function (el) { if (!isHidden(el) && !el.disabled) out.push(el); });
    qsa('input').forEach(function (el) {
      var ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (NON_TEXT.indexOf(ty) >= 0) return;
      if (el.disabled || el.hasAttribute('disabled')) return;
      if (isHidden(el)) return;
      out.push(el);
    });
    return out;
  }

  function listAddButtons() {
    var out = [];
    var all = qsa('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
      if (el.children.length > 3) continue;
      if (el.querySelector('input,select,textarea')) continue;
      var t = clean(el.innerText || el.textContent || '');
      if (!t || t.length > 40) continue;
      if (!/^(添加|新增|继续|增加|更多)/.test(t)) continue;
      // 去重：若祖先已收录则跳过
      var dup = false;
      for (var j = out.length - 1; j >= 0; j--) { try { if (out[j].el.contains(el)) { dup = true; break; } } catch (e) { /*noop*/ } }
      if (dup) continue;
      if (isHidden(el)) continue;
      out.push({ el: el, text: t.slice(0, 40) });
    }
    return out;
  }

  function capture() {
    var els = collectControls();
    var fields = [];
    lastEls = els;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var ty = inferType(el);
      var f = {
        fid: i,
        tag: el.tagName.toLowerCase(),
        type: ty,
        label: (rowLabel(el) || fieldLabel(el)).slice(0, 40),
        ph: clean(el.getAttribute('placeholder') || '').slice(0, 40),
        name: el.getAttribute('name') || '',
        id: el.id || '',
        cur: '',
        opts: [],
        ctx: blockCtx(el).slice(0, 150)
      };
      if (el.tagName === 'SELECT') {
        f.opts = qsa('option', el).map(function (o) { return { t: clean(o.text).slice(0, 60), v: o.value }; });
        f.cur = el.value;
      } else if (el.tagName === 'TEXTAREA') {
        f.cur = el.value;
      } else if (ty === 'checkbox' || ty === 'radio') {
        f.cur = el.checked ? 'checked' : '';
        f.value = el.value;
        f.lab = nearText(el);
      } else {
        f.cur = el.value || '';
      }
      fields.push(f);
    }
    lastAdd = listAddButtons();
    var addButtons = lastAdd.map(function (a, idx) { return { i: idx, text: a.text }; });
    return {
      ok: true,
      engine: VERSION,
      url: location.href,
      title: document.title,
      fields: fields,
      addButtons: addButtons,
      comboHint: 'readonly/含下拉容器的 input 视为 pick；native select 用 select 操作'
    };
  }

  // ---------------- 值写入原语 ----------------
  function nativeSet(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) { d.set.call(el, v); } else { el.value = v; }
    fire(el, 'input');
    fire(el, 'change');
  }

  function curVal(el) { return (el.tagName === 'SELECT' ? el.value : el.value); }

  // ---------------- 各类控件执行 ----------------
  async function execSet(op) {
    var el = lastEls[op.fid];
    if (!el) return { ok: false, note: 'fid 不存在' };
    try {
      el.focus();
      nativeSet(el, String(op.value == null ? '' : op.value));
      fire(el, 'blur');
      return { ok: true, after: curVal(el) };
    } catch (e) { return { ok: false, note: String(e && e.message || e) }; }
  }

  async function execDate(op) {
    var el = lastEls[op.fid];
    if (!el) return { ok: false, note: 'fid 不存在' };
    try {
      var v = String(op.value || '');
      el.focus();
      nativeSet(el, v);
      fireKey(el, 'Enter', 13);
      fire(el, 'change');
      fire(el, 'blur');
      // 部分组件用 yyyy/mm/dd
      var after = curVal(el);
      if (!after && v.indexOf('-') >= 0) {
        nativeSet(el, v.replace(/-/g, '/'));
        fireKey(el, 'Enter', 13);
        fire(el, 'change');
        fire(el, 'blur');
        after = curVal(el);
      }
      return { ok: !!after, after: after };
    } catch (e) { return { ok: false, note: String(e && e.message || e) }; }
  }

  function execSelect(op) {
    var el = lastEls[op.fid];
    if (!el || el.tagName !== 'SELECT') return { ok: false, note: '非 select' };
    var vn = norm(op.value);
    var opts = qsa('option', el);
    var t = null;
    if (vn) {
      t = opts.find(function (o) { return norm(o.text) === vn; }) ||
        opts.find(function (o) { return String(o.value || '') === String(op.value); }) ||
        (vn.length >= 2 ? opts.find(function (o) { return norm(o.text).indexOf(vn) >= 0; }) : null);
    }
    if (!t) return { ok: false, note: '无匹配选项: ' + op.value, options: opts.map(function (o) { return clean(o.text).slice(0, 20); }).slice(0, 30) };
    try {
      el.value = t.value;
      fire(el, 'input'); fire(el, 'change');
      return { ok: true, chosen: clean(t.text).slice(0, 30), after: el.value };
    } catch (e) { return { ok: false, note: String(e && e.message || e) }; }
  }

  async function execPick(op) {
    var el = lastEls[op.fid];
    if (!el) return { ok: false, note: 'fid 不存在' };
    var vn = norm(op.value);
    if (!vn) return { ok: false, note: '空值' };
    try {
      // 1) 容器内若有原生 select 优先
      var cont = closestBy(el, function (n) { return n.matches && n.matches(COMBO_CSS); }, 6) || el;
      var sel = cont.querySelector('select');
      if (sel) {
        var sRes = execSelectDirect(sel, op.value);
        if (sRes.ok) { fire(sel, 'change'); return sRes; }
      }
      // 2) 打开下拉
      var trigger = closestBy(el, function (n) {
        var cs = window.getComputedStyle(n);
        return cs && cs.cursor === 'pointer';
      }, 4) || cont;
      el.focus();
      try { (trigger || cont).click(); } catch (e) { /*noop*/ }
      await sleep(400);
      // 3) 收集可见候选并打分
      var cands = qsa('[role="option"], li, .el-select-dropdown__item, .ant-select-item-option, [class*="option"]', document)
        .filter(function (o) { if (!o.innerText) return false; try { var r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } });
      var best = null, score = -1;
      cands.forEach(function (o) {
        var t = norm(o.innerText);
        if (t === vn) { best = o; score = 3; return; }
        if (t.indexOf(vn) >= 0 && vn.length >= 2 && score < 2) { best = o; score = 2; }
        else if (vn.indexOf(t) >= 0 && t.length >= 2 && score < 1) { best = o; score = 1; }
      });
      if (!best) {
        // 可能要点两次才展开，重试一次
        try { (trigger || cont).click(); } catch (e) { /*noop*/ }
        await sleep(300);
        cands = qsa('[role="option"], li, .el-select-dropdown__item, .ant-select-item-option, [class*="option"]', document)
          .filter(function (o) { if (!o.innerText) return false; try { var rr = o.getBoundingClientRect(); return rr.width > 0 && rr.height > 0; } catch (e) { return false; } });
        cands.forEach(function (o) {
          var t2 = norm(o.innerText);
          if (t2 === vn && !best) { best = o; score = 3; }
          else if (best === null && t2.indexOf(vn) >= 0 && vn.length >= 2) { best = o; score = 2; }
        });
      }
      if (!best) return { ok: false, note: '下拉无匹配: ' + op.value };
      try { best.click(); } catch (e) {
        try {
          best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          best.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } catch (e2) { /*noop*/ }
      }
      await sleep(150);
      var shown = clean(el.value) || clean((trigger || cont).innerText).slice(0, 20);
      return { ok: true, chosen: clean(best.innerText).slice(0, 30), after: shown.slice(0, 30) };
    } catch (e) { return { ok: false, note: String(e && e.message || e) }; }
  }

  function execSelectDirect(sel, value) {
    var vn = norm(value);
    var opts = qsa('option', sel);
    var t = opts.find(function (o) { return norm(o.text) === vn; }) ||
      opts.find(function (o) { return String(o.value || '') === String(value); }) ||
      (vn.length >= 2 ? opts.find(function (o) { return norm(o.text).indexOf(vn) >= 0; }) : null);
    if (!t) return { ok: false, note: '无匹配选项' };
    try { sel.value = t.value; fire(sel, 'input'); fire(sel, 'change'); return { ok: true, chosen: clean(t.text).slice(0, 30) }; }
    catch (e) { return { ok: false, note: String(e && e.message || e) }; }
  }

  function groupLabel(el) {
    var t = fieldLabel(el);
    var lab = closestBy(el, function (n) { return n.tagName === 'LABEL'; }, 3);
    if (lab) { t = t + ' ' + clean(lab.innerText); }
    return norm(t);
  }

  async function execRadio(op) {
    var el = lastEls[op.fid];
    if (!el || el.type !== 'radio') return { ok: false, note: '非 radio' };
    var name = el.name;
    var group = name ? qsa('input[type="radio"][name="' + CSS.escape(name) + '"]', document) : [el];
    var vn = norm(op.value);
    for (var i = 0; i < group.length; i++) {
      var r = group[i];
      var lab = groupLabel(r);
      var rv = norm(r.value);
      if (lab === vn || (vn && lab.indexOf(vn) >= 0) || rv === vn) {
        if (!r.checked) { try { r.click(); } catch (e) { r.checked = true; fire(r, 'change'); } }
        return { ok: true, chosen: clean((closestBy(r, function (n) { return n.tagName === 'LABEL'; }, 3) || {}).innerText || r.value).slice(0, 20) };
      }
    }
    return { ok: false, note: 'radio 无匹配: ' + op.value };
  }

  async function execCheck(op) {
    var el = lastEls[op.fid];
    if (!el || el.type !== 'checkbox') return { ok: false, note: '非 checkbox' };
    var want = op.check === true || op.check === 1 || /^(是|true|1|同意|勾选)$/i.test(String(op.check == null ? '' : op.check));
    try {
      if (want && !el.checked) { el.click(); }
      else if (!want && el.checked) { el.click(); }
      return { ok: true, checked: el.checked };
    } catch (e) { return { ok: false, note: String(e && e.message || e) }; }
  }

  async function execClickAddN(op) {
    var n = op.n || 1;
    var i = op.i;
    var clicked = 0;
    for (var k = 0; k < n; k++) {
      // 优先按上次索引找文本，DOM 刷新后回退到实时列表同文本
      var btn = null;
      if (lastAdd[i]) btn = lastAdd[i].el;
      if (!btn || !btn.isConnected) {
        var live = listAddButtons();
        if (lastAdd[i]) {
          var txt = lastAdd[i].text;
          for (var m = 0; m < live.length; m++) if (live[m].text === txt) { btn = live[m].el; break; }
        }
        if (!btn && live[i]) btn = live[i].el;
      }
      if (!btn) return { ok: false, clicked: clicked, note: '找不到添加按钮' };
      try { btn.click(); } catch (e) { return { ok: false, clicked: clicked, note: String(e && e.message || e) }; }
      clicked++;
      await sleep(500);
    }
    return { ok: true, clicked: clicked };
  }

  // ---------------- 统一执行入口 ----------------
  async function exec(ops) {
    var results = [];
    var list = Array.isArray(ops) ? ops : (ops && ops.ops ? ops.ops : []);
    for (var i = 0; i < list.length; i++) {
      var op = list[i] || {};
      var r;
      try {
        switch (op.op) {
          case 'set': r = await execSet(op); break;
          case 'date': r = await execDate(op); break;
          case 'select': r = execSelect(op); break;
          case 'pick': r = await execPick(op); break;
          case 'radio': r = await execRadio(op); break;
          case 'check': r = await execCheck(op); break;
          case 'clickAddN': r = await execClickAddN(op); break;
          default: r = { ok: false, note: '未知操作: ' + op.op };
        }
      } catch (e) {
        r = { ok: false, note: String(e && e.message || e) };
      }
      if (!r.op) r.op = op.op;
      if (r.fid == null && op.fid != null) r.fid = op.fid;
      results.push(r);
    }
    var okN = results.filter(function (x) { return x.ok; }).length;
    return { ok: true, total: results.length, success: okN, fail: results.length - okN, results: results };
  }

  var API = {
    version: VERSION,
    capture: capture,
    exec: exec,
    helpers: { norm: norm, clean: clean, qsa: qsa, isHidden: isHidden, listAddButtons: listAddButtons },
    // 供外部在 exec 后刷新缓存用（一般用 capture 覆盖即可）
    _flush: function () { lastEls = []; lastAdd = []; }
  };

  window.__NC_AI__ = API;
  return API;
})();
