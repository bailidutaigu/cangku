// ==UserScript==
// @name         学习通 / 超星 网课助手 Pro
// @namespace    https://local.cxhelper
// @version      3.2.0
// @downloadURL  https://example.com/cx-helper.user.js
// @updateURL    https://example.com/cx-helper.user.js
// @description  自动播放 · 自定倍速 · 静音 · 跨frame自动下一节 · AI答题自动提交 · 文档/PPT自动翻页 · 防挂机保活
// @author       local
// @match        *://*.chaoxing.com/*
// @match        *://*.xuexitong.com/*
// @match        *://*.chaoxing.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ==================================================================
   * 0. 环境 / 配置 / 状态
   * ================================================================== */
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const IS_TOP = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
  const TAG = '[CX助手]';
  const TICK = 400;

  const DEFAULTS = {
    enabled: true,
    autoPlay: true,
    mute: true,
    rate: 2,
    forceRate: true,
    skip: false,
    autoNext: true,
    autoQuiz: true,
    autoSubmit: true,
    autoDoc: true,
    antiIdle: true,
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    bankApi: '',
    concurrency: 3,
    timeout: 45000,
    systemPrompt: '你是答题助手。只输出答案本身，不要解释，不要加“答案：”前缀。',
    debug: false
  };

  let cfg = loadCfg();

  function loadCfg() {
    let raw = null;
    try { raw = (typeof GM_getValue === 'function') ? GM_getValue('cx_cfg', null) : localStorage.getItem('cx_cfg'); } catch (e) { }
    let obj = {};
    try { obj = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}; } catch (e) { obj = {}; }
    return Object.assign({}, DEFAULTS, obj);
  }

  function saveCfg() {
    try {
      const s = JSON.stringify(cfg);
      if (typeof GM_setValue === 'function') GM_setValue('cx_cfg', s);
      else localStorage.setItem('cx_cfg', s);
    } catch (e) { }
  }

  const state = {
    solving: false,
    submitted: {},
    finished: {},
    attempts: {},
    qDone: 0,
    qTotal: 0,
    lastIdle: 0,
    lastNext: 0,
    lastFlip: 0,
    lastPopup: 0,
    lastQuizScan: 0,
    logBuf: [],
    noApiWarned: false,
    submitting: false,
    seen: {},
    done: {},
    pendingConfirmUntil: 0,
    lastSubmitEl: null,
    confirmClicks: 0,
    nextStrat: 0,
    nextFail: 0,
    pending: null,
    lastHref: location.href
  };

  let panel = null;

  function log() {
    const s = Array.prototype.slice.call(arguments).join(' ');
    state.logBuf.push(new Date().toLocaleTimeString() + '  ' + s);
    if (state.logBuf.length > 80) state.logBuf.shift();
    if (cfg.debug) console.log(TAG, s);
    paint();
  }

  function paint() {
    if (!panel) return;
    panel.logEl.textContent = state.logBuf.slice(-10).join('\n');
    let status = cfg.enabled ? '运行中' : '已暂停';
    if (!cfg.apiKey && !cfg.bankApi) status = '未配置 API';
    else if (state.solving) status = '答题中 ' + state.qDone + '/' + state.qTotal;
    else if (state.qTotal) status = '待答 ' + state.qTotal + ' 题';
    panel.statusEl.textContent = status;
    panel.statusEl.style.color = (!cfg.apiKey && !cfg.bankApi) ? '#ff7b72'
      : state.solving ? '#f0b400' : '#2ecc71';
  }

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 面板自己和角标绝不能参与任何 DOM 扫描：面板上就有「下一节」「提交」按钮，
     文本匹配会命中它们，导致脚本点自己、页面毫无反应。 */
  function inOwnUI(el) {
    try {
      if (!el || !el.closest) return false;
      return !!(el.closest('#cxh-panel') || el.closest('#cxh-badge'));
    } catch (e) { return false; }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (inOwnUI(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05;
  }

  /* 事件必须用元素自己的 realm 造，否则跨文档 dispatch 会抛 TypeError */
  function viewOf(el) {
    try { return (el.ownerDocument && el.ownerDocument.defaultView) || window; } catch (e) { return window; }
  }

  function safeClick(el) {
    if (!el) return false;
    try {
      const v = viewOf(el);
      const ME = v.MouseEvent || MouseEvent;
      ['mousedown', 'mouseup'].forEach(t => {
        el.dispatchEvent(new ME(t, { bubbles: true, cancelable: true, view: v }));
      });
      if (typeof el.click === 'function') { el.click(); return true; }
      el.dispatchEvent(new ME('click', { bubbles: true, cancelable: true, view: v }));
      return true;
    } catch (e) { return false; }
  }

  function setVal(el, v) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      d.set.call(el, v);
      const Ev = W.Event || Event;
      el.dispatchEvent(new Ev('input', { bubbles: true }));
      el.dispatchEvent(new Ev('change', { bubbles: true }));
    } catch (e) { el.value = v; }
  }

  /* ==================================================================
   * 1. 跨 frame 总线：面板在顶层，视频/题目/翻页按钮都在子 frame 里，
   *    配置改动和按钮动作必须广播下去，否则顶层那份 cfg 改了也没人听。
   * ================================================================== */
  const mkId = () => 'm' + Date.now() + Math.random().toString(36).slice(2, 7);
  const MYID = 'f' + Math.random().toString(36).slice(2, 9);

  function sendMsg(msg) {
    msg.origin = MYID;
    try { window.top.postMessage(msg, '*'); } catch (e) { }
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage(msg, '*'); } catch (e) { }
      }
    } catch (e) { }
  }

  function broadcastNext(from) {
    sendMsg({ __cxh: 1, type: 'next', t: Date.now(), from: from || 'x', hops: 0, id: mkId() });
  }

  function pushCmd(cmd, extra) {
    const msg = { __cxh: 1, type: 'cmd', cmd, t: Date.now(), hops: 0, id: mkId() };
    if (extra) Object.assign(msg, extra);
    sendMsg(msg);
  }

  function pushCfg() {
    pushCmd('cfg', { cfg: JSON.parse(JSON.stringify(cfg)) });
  }

  // 只往子 frame 转发，避免来回弹
  function relayDown(d) {
    const next = Object.assign({}, d, { hops: (d.hops || 0) + 1, from: 'relay' });
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(next, '*'); } catch (e) { }
    }
  }

  function listenBroadcast() {
    window.addEventListener('message', ev => {
      const d = ev.data;
      if (!d || d.__cxh !== 1) return;
      if (d.origin === MYID) return;            // 自己发的，不处理（top 会收到自己 postMessage 的那份）
      if (Date.now() - d.t > 6000) return;
      if (d.id) {
        if (state.seen[d.id]) return;          // 同一消息只执行一次
        state.seen[d.id] = 1;
        const keys = Object.keys(state.seen);
        if (keys.length > 60) keys.slice(0, 30).forEach(k => delete state.seen[k]);
      }

      if (d.type === 'next') {
        if (cfg.enabled && cfg.autoNext) goNext();
      } else if (d.type === 'cmd') {
        if (d.cmd === 'getcfg') {
          if (IS_TOP) pushCfg();
        } else if (d.cmd === 'cfg' && d.cfg) {
          Object.assign(cfg, d.cfg);
          applyRateNow();
          paint();
          log('同步配置 rate=' + cfg.rate + ' key=' + (cfg.apiKey ? '有' : '无'));
        } else if (d.cmd === 'solve') {
          state.attempts = {}; state.finished = {}; state.done = {}; state.solving = false;
          solveAll();
        } else if (d.cmd === 'scan') {
          scanDom();
        } else if (d.cmd === 'submit') {
          submitPaper();
        } else if (d.cmd === 'confirm') {
          // 提交方点完提交后广播：每个 frame 都开 12 秒兜底窗口，
          // 因为确认框可能画在另一层（乃至跨域顶层）里
          state.pendingConfirmUntil = Date.now() + 12000;
          confirmDialog();
        }
      }

      if ((d.hops || 0) < 3) relayDown(d);
    });
  }

  /* ==================================================================
   * 2. 页面钩子
   * ================================================================== */
  function hookVisibility() {
    try {
      const proto = W.Document.prototype;
      const def = (prop, val) => Object.defineProperty(proto, prop, { get() { return val; }, configurable: true });
      def('hidden', false);
      def('visibilityState', 'visible');
      def('webkitHidden', false);
      def('webkitVisibilityState', 'visible');
      if (proto.hasFocus) proto.hasFocus = function () { return true; };
      const add = document.addEventListener;
      document.addEventListener = function (type, fn, opt) {
        if (type === 'visibilitychange') return;
        return add.call(document, type, fn, opt);
      };
    } catch (e) { }
  }

  /* 原生 confirm/alert 会阻塞页面，脚本也没法点。直接让它们返回「确定」。 */
  function hookDialogs() {
    try {
      const v = W;
      v.confirm = function (msg) { log('原生 confirm（自动确定）: ' + String(msg).slice(0, 30)); return true; };
      v.alert = function (msg) { log('原生 alert: ' + String(msg).slice(0, 40)); };
      v.prompt = function () { return null; };
    } catch (e) { }
  }

  function hookRate() {
    try {
      const proto = W.HTMLMediaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
      if (!desc || !desc.set) return;
      Object.defineProperty(proto, 'playbackRate', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) {
          const target = (cfg.enabled && cfg.forceRate) ? cfg.rate : v;
          try { desc.set.call(this, target); } catch (e) { }
        }
      });
    } catch (e) { }
  }

  function patchLogBody(body) {
    if (/^\s*\{/.test(body)) {
      try {
        const o = JSON.parse(body);
        const dur = parseFloat(o.duration || o.totalTime || 0);
        if (dur > 0) {
          o.playingTime = dur;
          if (o.clipTime !== undefined) o.clipTime = dur;
          o.isdrag = 0;
        }
        return JSON.stringify(o);
      } catch (e) { return body; }
    }
    if (/^[^=\s]+=/.test(body)) {
      let dur = 0;
      body.split('&').forEach(p => {
        const i = p.indexOf('=');
        if (i < 0) return;
        const k = p.slice(0, i);
        if (/^(duration|totalTime)$/.test(k)) dur = parseFloat(decodeURIComponent(p.slice(i + 1))) || 0;
      });
      return body.split('&').map(p => {
        const i = p.indexOf('=');
        if (i < 0) return p;
        const k = p.slice(0, i);
        if (/^(playingTime|clipTime)$/.test(k) && dur > 0) return k + '=' + Math.floor(dur);
        if (k === 'isdrag') return 'isdrag=0';
        return p;
      }).join('&');
    }
    return body;
  }

  function hookNetwork() {
    try {
      const XO = W.XMLHttpRequest;
      if (XO && !XO.__cxhHooked) {
        const open = XO.prototype.open, send = XO.prototype.send;
        XO.prototype.open = function (m, u) { try { this.__u = String(u || ''); } catch (e) { } return open.apply(this, arguments); };
        XO.prototype.send = function (body) {
          try {
            if (cfg.enabled && cfg.skip && /multimedia\/log/.test(this.__u || '') && typeof body === 'string') body = patchLogBody(body);
          } catch (e) { }
          return send.call(this, body);
        };
        XO.__cxhHooked = true;
      }
    } catch (e) { }

    try {
      const of = W.fetch;
      if (of && !of.__cxhHooked) {
        const wrapped = function (input, init) {
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (cfg.enabled && cfg.skip && /multimedia\/log/.test(url) && init && typeof init.body === 'string') {
              init = Object.assign({}, init, { body: patchLogBody(init.body) });
            }
          } catch (e) { }
          return of.call(this, input, init);
        };
        wrapped.__cxhHooked = true;
        W.fetch = wrapped;
      }
    } catch (e) { }
  }

  /* ==================================================================
   * 3. 视频
   * ================================================================== */
  function videos() {
    return $$('video').filter(v => v && v.tagName === 'VIDEO');
  }

  function attachVideoEvents(v) {
    if (v.__cxhBound) return;
    v.__cxhBound = true;
    const fire = () => {
      log('视频结束 → 广播下一节');
      broadcastNext('video');
    };
    v.addEventListener('ended', fire);
    v.addEventListener('pause', () => {
      if (v.duration > 3 && v.currentTime >= v.duration - 1.2) fire();
    });
    v.addEventListener('timeupdate', () => {
      if (v.duration > 3 && v.currentTime >= v.duration - 0.6 && v.paused && !v.__cxhFired) {
        v.__cxhFired = true;
        fire();
      }
    });
  }

  function tickVideo() {
    const vs = videos();
    if (!vs.length) return;

    vs.forEach(v => {
      if (!v) return;
      attachVideoEvents(v);

      // 不能判 readyState：preload="none" 时它一直是 0，提前 return 就永远不 play()，死锁。
      if (cfg.mute && !v.muted) { try { v.muted = true; v.volume = 0; } catch (e) { } }

      if (cfg.forceRate && Math.abs((v.playbackRate || 1) - cfg.rate) > 0.01) {
        try { v.playbackRate = cfg.rate; } catch (e) { }
      }

      if (cfg.autoPlay && v.paused && !v.ended) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {
          const btn = $('.vjs-big-play-button, .xgplayer-start, .prism-play-btn, .play-btn');
          if (btn) safeClick(btn);
        });
      }
    });
  }

  /* ==================================================================
   * 4. 自动下一节
   * ================================================================== */
  const NEXT_SELECTORS = [
    '.TM_showNextChapter a',
    '.nextChapter a',
    '#popup_next a',
    '#prevNextFocusNext',
    '.orientationright',
    '.next_btn',
    '.btn-next',
    'a[onclick*="toNext"]',
    'a[href*="toNext"]'
  ];

  function clickFirst(sel) {
    for (const s of sel) {
      for (const el of $$(s)) {
        if (isVisible(el)) { safeClick(el); return el; }
      }
    }
    return null;
  }

  function clickByText(re) {
    for (const el of $$('a, button, div[onclick], span[onclick], li[onclick]')) {
      const t = (el.innerText || '').replace(/\s+/g, '').trim();
      if (!t || t.length > 10) continue;
      if (re.test(t) && isVisible(el)) { safeClick(el); return el; }
    }
    return null;
  }

  function clickCatalogNext() {
    const items = $$('.posCatalog_select, .posCatalog_level li, .chapter_item');
    if (items.length < 2) return null;

    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      const cn = typeof items[i].className === 'string' ? items[i].className : '';
      if (/(^|\s)(active|current|on|selected)(\s|$)/.test(cn) ||
          items[i].querySelector('.active, .current, [class*="active"], [class*="cur"]')) { idx = i; break; }
    }
    if (idx < 0) {
      const cid = (location.search.match(/chapterId=(\d+)/) || [])[1];
      if (cid) {
        for (let i = 0; i < items.length; i++) {
          if ((items[i].innerHTML || '').indexOf(cid) > -1) { idx = i; break; }
        }
      }
    }
    if (idx < 0) return null;

    for (let i = idx + 1; i < items.length && i < idx + 8; i++) {
      const it = items[i];
      const cls = (typeof it.className === 'string' ? it.className : '') +
        (it.parentElement && typeof it.parentElement.className === 'string' ? ' ' + it.parentElement.className : '');
      if (/lock|disable|gray|unopen/i.test(cls)) continue;
      const target = it.querySelector('.posCatalog_name') || it.querySelector('a[onclick], a[href]');
      if (target && isVisible(target)) { safeClick(target); return target; }
    }
    return null;
  }

  function describe(el) {
    if (!el) return '?';
    const tag = (el.tagName || '').toLowerCase();
    const cls = (typeof el.className === 'string') ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.innerText || '').replace(/\s+/g, '').slice(0, 12);
    const id = el.id ? '#' + el.id : '';
    return (tag + id + (cls ? '.' + cls : '') + (txt ? '「' + txt + '」' : '')).slice(0, 46);
  }

  function nextStrategies() {
    return [
      () => clickFirst(['.TM_showNextChapter a', '.nextChapter a', '#popup_next a']),
      () => clickFirst(['#prevNextFocusNext', '.orientationright', '.next_btn', '.btn-next', 'a[onclick*="toNext"]', 'a[href*="toNext"]']),
      () => clickCatalogNext(),
      () => clickByText(/^(下一节|下一章|下一个|下一任务点|继续学习|下一单元)$/),
      () => clickByText(/^下一页$/)
    ];
  }

  /* 策略轮换 + 点击后校验：点完 2 秒内 URL 或 DOM 没变化，就判定这次没生效，
     自动换下一个策略。上一版只 log「翻页成功」，其实点的是个死元素。 */
  function goNext(force) {
    const now = Date.now();
    if (!force && now - state.lastNext < 2500) return false;

    const strats = nextStrategies();
    for (let k = 0; k < strats.length; k++) {
      const i = (state.nextStrat + k) % strats.length;
      let hit = null;
      try { hit = strats[i](); } catch (e) { hit = null; }
      if (!hit) continue;

      state.lastNext = now;
      state.nextStrat = (i + 1) % strats.length;
      state.pending = {
        t: now,
        href: location.href,
        len: document.body ? document.body.innerHTML.length : 0,
        desc: describe(hit),
        strat: i + 1
      };
      log('翻页策略' + (i + 1) + ' 点了 ' + describe(hit) + '（2 秒后校验）');
      return true;
    }
    return false;
  }

  function checkNextEffect() {
    const p = state.pending;
    if (!p || Date.now() - p.t < 2200) return;
    state.pending = null;

    const moved = location.href !== p.href;
    const len = document.body ? document.body.innerHTML.length : 0;
    const changed = Math.abs(len - p.len) > 200;

    if (moved || changed) {
      state.nextStrat = 0;
      state.nextFail = 0;
      log('翻页已生效');
      return;
    }
    state.nextFail = (state.nextFail || 0) + 1;
    log('策略' + p.strat + '（' + p.desc + '）点了没反应，换下一个');
    if (state.nextFail <= 4) goNext(true);
    else log('所有翻页策略都没生效：这一页的「下一节」可能是 JS 路由或需要手动点一次');
  }

  /* ==================================================================
   * 5. 文档 / PPT 翻页
   * ================================================================== */
  function isDocPage() {
    if (/ananas\/modules\/(pdf|doc|ppt|book)/i.test(location.href)) return true;
    return !!$('#panView, .pdfViewer, .docViewer, .imgTextWrap, .pptPlayer, #viewerContainer');
  }

  function tickDoc() {
    if (!cfg.autoDoc || videos().length || !isDocPage()) return;
    const now = Date.now();
    if (now - state.lastFlip < 700) return;

    const sc = $$('div, section, main').filter(el => {
      if (el.scrollHeight <= el.clientHeight + 60) return false;
      const st = getComputedStyle(el);
      return /(auto|scroll)/.test(st.overflowY) && el.clientHeight > 200;
    }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

    if (sc && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 8) {
      state.lastFlip = now;
      sc.scrollTop += Math.max(220, sc.clientHeight * 0.85);
      return;
    }
    if (now - state.lastFlip < 5000) return;

    const btn = clickFirst(['#nextPage', '.nextPage', 'a[title="下一页"]', '.page-next', '.pdf-next']);
    if (btn) { state.lastFlip = now; return; }

    try {
      const KE = W.KeyboardEvent || KeyboardEvent;
      const viewer = sc || document.body;
      viewer.dispatchEvent(new KE('keydown', { key: 'PageDown', keyCode: 34, which: 34, bubbles: true }));
      document.dispatchEvent(new KE('keydown', { key: 'PageDown', keyCode: 34, which: 34, bubbles: true }));
    } catch (e) { }
    state.lastFlip = now;
  }

  /* ==================================================================
   * 6. 答题
   * ================================================================== */
  const OPT_SEL = [
    '.Zy_ulTop li',
    '.Zy_ulOption li',
    '.mark_letter li',
    '.answerList li',
    '.stem_answer li',
    '.questionOptions li'
  ].join(',');

  function questionRoots() {
    const found = [];
    ['.TiMu', '.questionLi', '.Cy_TItle'].forEach(sel => {
      $$(sel).forEach(e => {
        if (found.some(o => o === e || o.contains(e) || e.contains(o))) return;
        found.push(e);
      });
    });
    return found;
  }

  function parseQuestion(el) {
    const txt = el.innerText || '';
    let type = 'single';
    if (/多选/.test(txt)) type = 'multi';
    else if (/判断/.test(txt)) type = 'judge';
    else if (/填空/.test(txt)) type = 'fill';
    else if (/简答|论述|名词解释|计算|分析|问答/.test(txt)) type = 'text';

    // 只认真正的题干容器；退一步用整块标题区，并剥掉题型/分值前缀。
    // 坑：'.Zy_TItle .fl' 在文档流里第一个通常是「单选题(2分)」这个题型标记，
    // 拿它当题干会被整段正则剥成空串，导致所有题目被过滤、最后交白卷。
    const stemEl = el.querySelector('.questionLy') ||
                   el.querySelector('.Zy_TItle .questionLy') ||
                   el.querySelector('.Cy_TItle .questionLy');

    let stem = (stemEl ? stemEl.innerText : (el.querySelector('.Zy_TItle') || el).innerText);
    stem = stem.replace(/\s+/g, ' ').trim();
    stem = stem.replace(/^[（(]?\s*\d+(\.\d+)?\s*分\s*[)）]\s*/g, '');
    stem = stem.replace(/^(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题|分析题|阅读理解)\s*[（(]?\s*\d+(\.\d+)?\s*分?\s*[)）]?\s*/g, '');
    stem = stem.replace(/^[0-9]+[.、]\s*/g, '');
    stem = stem.replace(/[（(]\s*\d+(\.\d+)?\s*分\s*[)）]\s*$/g, '').trim();

    const options = [];
    $$(OPT_SEL, el).forEach(li => {
      if (li.querySelector('li')) return;
      if (options.some(o => o.el === li)) return;
      const t = (li.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      options.push({ label: String.fromCharCode(65 + options.length), text: t, el: li });
    });

    return { el, type, stem, options };
  }

  /* ---- 通用兜底：不依赖超星 class，任何成组的 radio/checkbox 都能认 ---- */
  function inputBoxText(input) {
    const box = input.closest('label, li, .option, .answer, .item') || input.parentElement || input;
    let t = ((box && box.innerText) || '').replace(/\s+/g, ' ').trim();
    if (!t) {
      const s = input.nextSibling;
      t = (s && s.textContent ? s.textContent : '').replace(/\s+/g, ' ').trim();
    }
    return { text: t, box };
  }

  function genericQuestions() {
    const sel = 'input[type=radio],input[type=checkbox]';
    const inputs = $$(sel).filter(i => !(i.closest && i.closest('#cxh-panel')));
    if (!inputs.length) return [];

    const groups = [];
    inputs.forEach(inp => {
      const key = inp.name || ('__noname' + groups.length);
      let g = groups.find(x => x.key === key);
      if (!g) { g = { key, inputs: [] }; groups.push(g); }
      g.inputs.push(inp);
    });

    const out = [];
    groups.forEach(g => {
      if (g.inputs.length < 2) return;
      let root = g.inputs[0];
      for (const i of g.inputs) { while (root && !root.contains(i)) root = root.parentElement; }
      if (!root) return;

      let stemEl = root;
      if (root.parentElement && root.parentElement.querySelectorAll(sel).length === g.inputs.length) {
        stemEl = root.parentElement;
      }

      const opts = g.inputs.map((inp, idx) => {
        const b = inputBoxText(inp);
        return { label: String.fromCharCode(65 + idx), text: b.text, el: b.box };
      });

      let stem = ((stemEl.innerText || '')).replace(/\s+/g, ' ').trim();
      opts.forEach(o => { if (o.text && o.text.length > 1) stem = stem.split(o.text).join(' '); });
      stem = stem.replace(/\s+/g, ' ').trim();
      if (!stem) return;

      let type = g.inputs[0].type === 'checkbox' ? 'multi' : 'single';
      if (type === 'single' && opts.length === 2 && opts.some(o => /对|正确|√/.test(o.text))) type = 'judge';
      out.push({ el: stemEl, type, stem, options: opts });
    });
    return out;
  }

  function collectQuestions() {
    const roots = questionRoots();
    if (roots.length) {
      const qs = roots.map(parseQuestion).filter(q => q.stem);
      if (qs.length) return qs;
    }
    // 通用解析会命中任何成组输入框，加闸：必须是答题页
    if (!findSubmitBtn() && !/work|exam|quiz|test|homework|exercise|answer/i.test(location.href)) return [];
    return genericQuestions();
  }

  function extractLetters(raw, count) {
    const m = String(raw || '').toUpperCase().match(/[A-H]/g);
    if (!m) return [];
    const uniq = [];
    m.forEach(x => { if (uniq.indexOf(x) < 0) uniq.push(x); });
    return uniq.filter(x => x.charCodeAt(0) - 65 < Math.max(count, 4)).sort();
  }

  function buildPrompt(q) {
    const typeName = { single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题', text: '简答题' }[q.type];
    const optTxt = q.options.length ? '\n【选项】\n' + q.options.map(o => o.label + '. ' + o.text).join('\n') : '';
    let rule = '输出简洁答案，不要解释。';
    if (q.type === 'single') rule = '只输出一个大写字母，如 A。';
    else if (q.type === 'multi') rule = '输出多个大写字母，连写不加空格，如 ABD。';
    else if (q.type === 'judge') rule = '只输出“对”或“错”。';
    else if (q.type === 'fill') rule = '按空的顺序输出答案，多个空用 ||| 分隔。';
    return '【题型】' + typeName + '\n【题目】' + q.stem + optTxt + '\n\n输出要求：' + rule;
  }

  function aiAsk(prompt) {
    return new Promise((resolve, reject) => {
      const url = String(cfg.apiBase).replace(/\/+$/, '') + '/chat/completions';
      const payload = JSON.stringify({
        model: cfg.model, temperature: 0,
        messages: [{ role: 'system', content: cfg.systemPrompt }, { role: 'user', content: prompt }]
      });
      const handle = txt => {
        try {
          const j = JSON.parse(txt);
          const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!c) return reject(new Error('返回体无 content'));
          resolve(String(c).trim());
        } catch (e) { reject(new Error('解析失败')); }
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url, timeout: cfg.timeout || 45000,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          data: payload,
          onload: r => (r.status >= 200 && r.status < 300) ? handle(r.responseText) : reject(new Error('HTTP ' + r.status)),
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时'))
        });
      } else {
        fetch(url, {
          method: 'POST', body: payload,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey }
        }).then(r => r.text()).then(handle).catch(reject);
      }
    });
  }

  function bankAsk(q) {
    if (!cfg.bankApi) return Promise.resolve(null);
    return new Promise(resolve => {
      const url = cfg.bankApi + (cfg.bankApi.indexOf('?') > -1 ? '&' : '?') + 'q=' + encodeURIComponent(q.stem);
      try {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 8000,
          onload: r => {
            try {
              const j = JSON.parse(r.responseText);
              const a = j.answer || (j.data && (j.data.answer || j.data));
              resolve(a ? String(a) : null);
            } catch (e) { resolve(null); }
          },
          onerror: () => resolve(null), ontimeout: () => resolve(null)
        });
      } catch (e) { resolve(null); }
    });
  }

  const CACHE_KEY = 'cx_answer_cache';
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { cache = {}; }
  let cacheDirty = false;
  const hkey = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'q' + (h >>> 0); };

  /* ---- 选项落盘：点一次就验，没选中才换下一个目标 ---- *
   * 学习通这类页面的选项是「切换式」的（点一下选中、再点取消），
   * 一串 input→label→li 连点会把刚选上的又点掉，最后只剩描边。         */
  function optionPicked(opt) {
    const el = opt.el;
    if (!el) return false;
    const input = el.querySelector ? el.querySelector('input') : null;
    if (input && input.checked) return true;
    if (el.classList) {
      const cl = el.classList;
      if (cl.contains('cur') || cl.contains('check_answer') || cl.contains('active') ||
          cl.contains('selected') || cl.contains('on') || cl.contains('checked')) return true;
    }
    // 对勾图标必须是「可见」的才算选中；很多模板每个选项都预置一个隐藏的 .check_answer 占位，
    // 按「存在」判断会让所有选项都显示成已选，从而一次都不点。
    const mark = el.querySelector ? el.querySelector('.check_answer, .cur, .active, .selected, .icon_selected, .icon_check') : null;
    return !!(mark && isVisible(mark));
  }

  function classSaysPicked(el) {
    const cn = (el && typeof el.className === 'string') ? el.className : '';
    return /(^|\s)(cur|on|active|selected|checked|check_answer)(\s|$)/.test(cn);
  }

  function markOption(opt, ok) {
    if (opt.el && opt.el.style) opt.el.style.outline = ok ? '2px solid #2ecc71' : '2px dashed #f0b400';
  }

  /* 完整事件序列：pointerdown → mousedown → pointerup → mouseup → click。
     只在 document 上派发 click 的老做法，遇到用 pointer/mousedown 触发的组件无效。 */
  function fireSeq(el) {
    if (!el || !el.dispatchEvent) return;
    const v = viewOf(el);
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, view: v, clientX: x, clientY: y, button: 0 };
    const P = v.PointerEvent, M = v.MouseEvent || MouseEvent;
    const pOpt = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base);
    try { if (P) el.dispatchEvent(new P('pointerdown', pOpt)); } catch (e) { }
    try { el.dispatchEvent(new M('mousedown', base)); } catch (e) { }
    try { if (P) el.dispatchEvent(new P('pointerup', pOpt)); } catch (e) { }
    try { el.dispatchEvent(new M('mouseup', base)); } catch (e) { }
    try { el.dispatchEvent(new M('click', base)); } catch (e) { }
  }

  function pickOption(opt) {
    if (!opt || !opt.el) return false;

    const el = opt.el;
    const input = el.querySelector ? el.querySelector('input') : null;

    // 预判「已经选好」只认硬证据：input.checked，或没有 input 时的显式 selected 类。
    // 不能用手写宽松判断，否则隐藏的对勾占位会让所有选项都被当成已选、一次都不点。
    if (input && input.checked) { markOption(opt, true); return true; }
    if (!input && /(^|\s)(cur|selected)(\s|$)/.test(typeof el.className === 'string' ? el.className : '')) {
      markOption(opt, true); return true;
    }

    const ok = () => (input ? input.checked : false) || optionPicked(opt);
    const done = () => { markOption(opt, true); return true; };

    // 关键兜底：只要点击让选项区域发生了任何 DOM 变化（类名、子节点、内长），
    // 就算页面接受了这次选择。否则遇到「用别的类名/图标表示选中」的模板，
    // 我们会误判成 0 题作答，然后按防白卷逻辑拒绝提交。
    const sig = () => {
      const cn = typeof el.className === 'string' ? el.className : '';
      let kids = 0, html = 0;
      try { kids = el.querySelectorAll('*').length; html = (el.innerHTML || '').length; } catch (e) { }
      return cn + '|' + kids + '|' + html + '|' + (input ? input.checked : '');
    };
    let prev = sig();
    const attempt = (target) => {
      if (!target) return false;
      fireSeq(target);
      if (ok()) return true;
      const now = sig();
      if (now !== prev) { prev = now; return true; }
      return false;
    };

    // 1 原生 input
    if (attempt(input)) return done();

    // 2 label（有 for / 包裹关系时原生联动）
    const label = (el.querySelector ? el.querySelector('label') : null) ||
                  (el.closest ? el.closest('label') : null);
    if (attempt(label)) return done();

    // 3 选项里的对勾图标 / a / i
    const icon = el.querySelector ? el.querySelector('a, i, .check_answer, .icon, span[class*="check"]') : null;
    if (attempt(icon)) return done();

    // 4 完整事件序列打到 li 本身
    if (attempt(el)) return done();

    // 5 往上找 3 层祖先：有的模板把点击绑在 li 外面的包裹层
    let a = el.parentElement, k = 0;
    while (a && k < 3) {
      if (attempt(a)) return done();
      a = a.parentElement; k++;
    }

    // 6 用坐标取「真正在这个点上的元素」再打一遍（针对层叠/pointer-events 的情况）
    try {
      const r = el.getBoundingClientRect();
      const pt = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (pt && pt !== el && attempt(pt)) return done();
    } catch (e) { }

    // 7 直接调用内联 onclick
    try {
      if (typeof el.onclick === 'function') {
        el.onclick.call(el, {
          type: 'click', target: el, currentTarget: el, button: 0,
          preventDefault() { }, stopPropagation() { }, stopImmediatePropagation() { }
        });
        if (ok()) return done();
      }
    } catch (e) { }

    // 8 兜底：强改 checked 并派发 change
    if (input && !input.checked) {
      try {
        input.checked = true;
        const Ev = W.Event || Event;
        input.dispatchEvent(new Ev('change', { bubbles: true }));
        input.dispatchEvent(new Ev('input', { bubbles: true }));
      } catch (e) { }
    }
    const res = (input && input.checked) || optionPicked(opt);
    markOption(opt, res);
    return res;
  }

  function questionAnswered(q) {
    if (q.type === 'fill' || q.type === 'text') {
      return $$('input[type=text], input:not([type]), textarea', q.el)
        .some(b => String(b.value === undefined ? b.textContent : b.value || '').trim());
    }
    return q.options.some(o => optionPicked(o) || classSaysPicked(o.el));
  }

  function applyAnswer(q, raw) {
    if (!raw) return false;

    /* 填空 / 简答：多空按 ||| 分段对号入座；逐框回读确认真的写进去了 */
    if (q.type === 'fill' || q.type === 'text') {
      const boxes = $$('input[type=text], input:not([type]), textarea, [contenteditable="true"]', q.el)
        .filter(el => !el.disabled && !el.readOnly && isVisible(el));
      if (!boxes.length) return false;

      const parts = String(raw)
        .split(/\|\|\||｜｜｜|\n+/)
        .map(s => s.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim())
        .filter(Boolean);
      if (!parts.length) return false;

      let filled = 0;
      boxes.forEach((b, i) => {
        let v = parts[i];
        if (v === undefined) v = (parts.length === 1 ? parts[0] : '');
        if (!v) return;

        const isEditable = b.getAttribute && b.getAttribute('contenteditable') === 'true';
        if (isEditable) {
          b.textContent = v;
          b.dispatchEvent(new (W.Event || Event)('input', { bubbles: true }));
        } else {
          setVal(b, v);
        }

        const read = () => (b.value !== undefined ? String(b.value) : (b.textContent || ''));
        if (read().trim()) { filled++; return; }

        // 没写进去：聚焦后重写一次（有些富文本/受控组件要在 focus 后才接受输入）
        try {
          b.focus();
          ['keydown', 'keyup'].forEach(t => b.dispatchEvent(new (W.KeyboardEvent || KeyboardEvent)(t, { bubbles: true })));
          setVal(b, v);
        } catch (e) { }
        if (read().trim()) filled++;
      });

      if (filled < boxes.length) log('填空只填上 ' + filled + '/' + boxes.length + ' ← ' + q.stem.slice(0, 14));
      return filled > 0;
    }

    let letters = [];
    if (q.type === 'judge') {
      const t = String(raw).trim();
      let want = null;
      if (/^(对|正确|√|是|T|true)/i.test(t)) want = /对|正确|√|是|T/i;
      else if (/^(错|错误|×|否|F|false)/i.test(t)) want = /错|错误|×|否|F/i;
      if (want) {
        const hit = q.options.filter(o => want.test(o.text));
        letters = hit.length ? [hit[0].label] : [/对|正确/i.test(t) ? 'A' : 'B'];
      } else {
        letters = extractLetters(raw, 2);
      }
    } else {
      letters = extractLetters(raw, q.options.length);
      if (!letters.length && q.options.length) {
        const hit = q.options.find(o => String(raw).indexOf(o.text.slice(0, 6)) > -1);
        if (hit) letters = [hit.label];
      }
    }

    if (!letters.length) return false;
    if (q.type !== 'multi' && letters.length > 1) letters = [letters[0]];

    let picked = 0;
    const failed = [];
    letters.forEach(L => {
      const opt = q.options.find(o => o.label === L);
      if (!opt) return;
      if (pickOption(opt)) picked++;
      else failed.push(L);
    });
    if (failed.length) {
      log('选项没能选中: ' + failed.join(',') + ' ← ' + q.stem.slice(0, 16));
    }
    return picked > 0;
  }

  /* 提交按钮候选。#tempsave 是学习通的「暂时保存」，绝对不能被当成提交：
     它只把答案存到草稿，交卷动作根本没发生。 */
  const SUBMIT_SEL = [
    '.Btn_blue_1', '.completeBtn', '.btnSubmit', '#submitBtn',
    '.submitBtn', '#submitPaper', '.btn-submit', '.jb_btn_92',
    'a[onclick*="submitCheck"]', 'a[onclick*="submitPaper"]', 'a[onclick*="handIn"]'
  ].join(',');

  const SAVE_WORDS = /^(暂时保存|保存|暂存|保存答案|保存作业)$/;

  function submitCandidates() {
    const out = [];
    const seen = new Set();
    $$('a, button, div[onclick], span[onclick], li[onclick], input[type=button], input[type=submit]').forEach(el => {
      if (seen.has(el) || inOwnUI(el)) return;
      const t = ((el.innerText || el.value || '') + '').replace(/\s+/g, '');
      if (!t || t.length > 8) return;
      if (SAVE_WORDS.test(t)) return;          // 保存类一律排除
      if (!/提交|交卷/.test(t)) return;
      seen.add(el);
      out.push(el);
    });
    return out;
  }

  /* 把「所有同源文档」都拉平：提交按钮经常不在当前这一层 */
  function safeDocs() {
    const out = [{ doc: document, win: window, url: String(location.href), mine: true }];
    (function walk(win) {
      let n = 0;
      try { n = win.frames.length; } catch (e) { return; }
      for (let i = 0; i < n; i++) {
        let w = null, d = null;
        try { w = win.frames[i]; } catch (e) { continue; }
        try { d = w.document; } catch (e) { continue; }      // 跨域访问会抛，跳过
        if (!d) continue;
        let url = '';
        try { url = String(d.location.href); } catch (e) { url = '(跨域)'; }
        let mine = false;
        try { mine = !!w.__CXH__; } catch (e) { }
        out.push({ doc: d, win: w, url, mine });
        walk(w);
      }
    })(window);
    return out;
  }

  function findSubmitEverywhere() {
    for (const f of safeDocs()) {
      try {
        for (const el of f.doc.querySelectorAll(SUBMIT_SEL)) {
          if (isVisible(el) && !el.disabled) return { el, url: f.url };
        }
      } catch (e) { }
      try {
        for (const el of f.doc.querySelectorAll('a,button,div[onclick],span[onclick],input[type=button],input[type=submit]')) {
          const t = ((el.innerText || el.value || '') + '').replace(/\s+/g, '');
          if (t && t.length <= 8 && /提交|交卷/.test(t) && isVisible(el) && !el.disabled) return { el, url: f.url };
        }
      } catch (e) { }
    }
    return null;
  }

  function findSubmitBtn() {
    const hit = findSubmitEverywhere();
    if (hit) return hit.el;
    for (const el of submitCandidates()) {
      if (isVisible(el) && !el.disabled) return el;
    }
    return null;
  }

  function snap() {
    let len = 0;
    const txts = [];
    safeDocs().forEach(f => {
      try {
        if (f.doc.body) {
          len += f.doc.body.innerHTML.length;
          txts.push(String(f.doc.body.innerText || '').slice(0, 1500));
        }
      } catch (e) { }
    });
    return { href: location.href, len, txt: txts.join(' ') };
  }

  async function waitChange(before, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(300);
      const now = snap();
      const moved = location.href !== before.href;
      const bigChange = Math.abs(now.len - before.len) > 300;
      const said = /提交成功|已提交|交卷成功|答题完成|作业已完成|成绩/.test(now.txt) &&
        !/提交成功|已提交/.test(before.txt);
      if (moved || bigChange || said) return true;
    }
    return false;
  }

  /* 提交：先保存 → 点提交 → 验页面有没有真的动 → 没动就换方式重试 */
  async function submitPaper() {
    const href = location.href;
    if (state.submitting) return false;
    state.submitting = true;
    try {
      const found = findSubmitEverywhere();
      if (!found) {
        const cands = submitCandidates().map(describe).join(' | ');
        const hasSave = !!(document.getElementById('tempsave') || $('.saveBtn'));
        log('找不到提交按钮' + (hasSave ? '（页面只有「暂时保存」，已跳过）' : '') +
            '，已查 ' + safeDocs().length + ' 个文档。像按钮的：' + (cands || '无'));
        return false;
      }
      const btn = found.el;

      const before = snap();
      log('点提交：' + describe(btn) + ' @' + String(found.url).slice(0, 60));
      state.lastSubmitEl = btn;
      state.confirmClicks = 0;
      state.pendingConfirmUntil = Date.now() + 10000;   // 给确认框留 10 秒的兜底窗口
      safeClick(btn);
      pushCmd('confirm');                                // 让所有 frame 一起盯确认框
      await sleep(1000); confirmDialog();
      await sleep(1500); confirmDialog();

      if (await waitChange(before, 4000)) {
        state.submitted[href] = true; state.finished[href] = true;
        log('提交成功');
        return true;
      }

      log('点了提交但页面没反应，换方式重试（完整事件序列 / 父元素）');
      state.pendingConfirmUntil = Date.now() + 10000;
      pushCmd('confirm');
      fireSeq(btn);
      if (btn.parentElement) fireSeq(btn.parentElement);
      await sleep(1200); confirmDialog();
      await sleep(1500); confirmDialog();

      if (await waitChange(before, 4000)) {
        state.submitted[href] = true; state.finished[href] = true;
        log('提交成功');
        return true;
      }

      log('仍未检测到提交结果。按钮 HTML：' + String(btn.outerHTML || '').replace(/\s+/g, ' ').slice(0, 220));
      return false;
    } finally {
      state.submitting = false;
    }
  }

  async function pool(items, limit, fn) {
    let i = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
    });
    await Promise.all(workers);
  }

  async function solveAll(preQs) {
    const href = location.href;
    if (state.solving || state.finished[href] || state.done[href]) return;
    if (!cfg.apiKey && !cfg.bankApi) {
      if (!state.noApiWarned) {
        state.noApiWarned = true;
        log('未配置 API Key / 题库，答题不执行。面板顶部填 API Key。');
      }
      return;
    }
    if ((state.attempts[href] || 0) >= 5) return;

    const qs = (preQs && preQs.length) ? preQs : collectQuestions();
    if (!qs.length) {
      log('本 frame 没解析到题目（题在别的 frame 或选择器不匹配）');
      return;
    }

    state.solving = true;
    state.attempts[href] = (state.attempts[href] || 0) + 1;
    state.qTotal = qs.length;
    state.qDone = 0;
    paint();
    log('开始答题，共 ' + qs.length + ' 题');

    let answered = 0;
    try {
      await pool(qs, Math.max(1, Number(cfg.concurrency) || 1), async (q) => {
        // 幂等：这一题页面上已经选好了，就不再点第二下。
        // 否则切换式选项会被「再点一次」取消掉，最后提交时显示未作答。
        if (questionAnswered(q)) { answered++; state.qDone++; paint(); return; }

        const key = hkey(q.type + '|' + q.stem + '|' + q.options.map(o => o.text).join(','));
        let ans = cache[key] || null;
        if (!ans) { try { ans = await bankAsk(q); } catch (e) { ans = null; } }
        if (!ans) {
          try { ans = await aiAsk(buildPrompt(q)); cache[key] = ans; cacheDirty = true; }
          catch (e) { log('题目失败(' + e.message + '): ' + q.stem.slice(0, 20)); state.qDone++; paint(); return; }
        }
        if (applyAnswer(q, ans)) answered++;
        else log('落答案失败: ' + q.stem.slice(0, 20) + ' → ' + String(ans).slice(0, 20));
        state.qDone++;
        paint();
      });

      if (cacheDirty) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { } cacheDirty = false; }

      // 复核：以页面当前的真实状态再数一遍，避免因为判定太窄把「已答上」当成 0 题
      const verified = qs.filter(questionAnswered).length;
      if (verified > answered) answered = verified;

      // 全部答上就封页，别让 900ms 的轮询再跑一遍把选项点掉
      if (answered >= qs.length && qs.length) state.done[href] = true;

      log('作答结束 ' + answered + '/' + qs.length);

      await sleep(800);
      if (!answered) log('没有一题成功填入，不提交（避免交白卷）');
      else if (!cfg.autoSubmit) log('已填答案（自动提交已关）');
      else await submitPaper();
    } catch (e) {
      log('答题异常: ' + e.message);
    } finally {
      state.solving = false;
      state.qTotal = 0;
      paint();
    }
  }

  function tickQuiz() {
    if (!cfg.autoQuiz) return;
    if (state.done[location.href]) return;
    const now = Date.now();
    if (now - state.lastQuizScan < 900) return;
    state.lastQuizScan = now;
    if (state.solving) return;
    const qs = collectQuestions();
    if (!qs.length) return;
    state.qTotal = qs.length;
    paint();
    solveAll(qs);
  }

  /* ==================================================================
   * 7. 弹窗 / 保活
   * ================================================================== */
  const OVERLAY_SEL = [
    '.layui-layer', '.mask_pop', '#popup', '.cx-popup', '.layui-layer-page',
    '.layui-layer-dialog', '.dialog', '.popupBox', '.popup_box', '.confirm_box',
    '.ans-popup', '.answer-popup', '.popbox', '.model_box', '.modal', '.el-dialog'
  ].join(',');

  const POPUP_BTN = [
    '.layui-layer-btn0', '.popup_button', '#popok', '.mask_pop .confirm',
    '.cx-popup .btn', '#popup .btn', '.layui-layer-dialog .layui-layer-btn0',
    '.confirm_box .btn', '.model_box .btn_ok', '.el-dialog__footer .el-button--primary'
  ];

  const CONFIRM_TEXT = /^(确定|确认|确定提交|确认提交|继续|继续学习|我知道了|知道了|好的|重新开始|提交|交卷)$/;

  /* 确认框的按钮文案也可能是「提交」本身，但绝不能再点回刚才那个提交按钮 */
  function isSameSubmit(el) {
    const s = state.lastSubmitEl;
    if (!s || !el) return false;
    try {
      return el === s || (s.contains && s.contains(el)) || (el.contains && el.contains(s));
    } catch (e) { return false; }
  }

  function confirmDialog() {
    const now = Date.now();
    if (now - state.lastPopup < 700) return false;
    const docs = safeDocs();

    // 1) 先在各文档的浮层里点
    for (const f of docs) {
      let ovs = [];
      try { ovs = Array.prototype.slice.call(f.doc.querySelectorAll(OVERLAY_SEL)); } catch (e) { }
      for (const ov of ovs) {
        if (!isVisible(ov)) continue;
        for (const s of POPUP_BTN) {
          const el = ov.querySelector(s);
          if (el && isVisible(el)) { state.lastPopup = now; log('浮层按钮'); safeClick(el); return true; }
        }
        let cands = [];
        try { cands = Array.prototype.slice.call(ov.querySelectorAll('a,button,div[onclick],span[onclick],input[type=button]')); } catch (e) { }
        for (const el of cands) {
          const t = ((el.innerText || el.value || '') + '').replace(/\s+/g, '');
          if (CONFIRM_TEXT.test(t) && isVisible(el) && !inOwnUI(el) && !isSameSubmit(el)) {
            state.lastPopup = now; log('浮层→' + t); safeClick(el); return true;
          }
        }
      }
    }

    // 2) 刚点过提交/翻页的 10 秒内，允许点页面上孤立的「确定」
    //    （学习通的确认框未必带上面的 class，硬套选择器会漏）
    if (state.pendingConfirmUntil > now) {
      for (const f of docs) {
        let cands = [];
        try { cands = Array.prototype.slice.call(f.doc.querySelectorAll('a,button,div[onclick],span[onclick],input[type=button]')); } catch (e) { }
        for (const el of cands) {
          const t = ((el.innerText || el.value || '') + '').replace(/\s+/g, '');
          if (!/^(确定|确认|确认提交|确定提交|好的|继续|继续提交|提交|交卷)$/.test(t)) continue;
          if (!isVisible(el) || inOwnUI(el) || isSameSubmit(el)) continue;
          if (state.confirmClicks >= 3) return false;      // 防止死循环
          state.confirmClicks++;
          state.lastPopup = now;
          log('点确认：' + t);
          safeClick(el);
          return true;
        }
      }
    }
    return false;
  }

  function tickIdle() {
    if (!cfg.antiIdle) return;
    const t = Date.now();
    if (t - state.lastIdle < 30000) return;
    state.lastIdle = t;
    try {
      const el = document.elementFromPoint(innerWidth >> 1, innerHeight >> 1) || document.body;
      const ME = W.MouseEvent || MouseEvent;
      ['mousemove', 'mouseover'].forEach(type => {
        el.dispatchEvent(new ME(type, { bubbles: true, clientX: Math.random() * innerWidth, clientY: Math.random() * innerHeight }));
      });
      W.dispatchEvent(new (W.Event || Event)('focus'));
    } catch (e) { }
  }

  /* ==================================================================
   * 8. 面板
   * ================================================================== */
  const BOOL_FIELDS = [
    ['enabled', '总开关'], ['autoPlay', '自动播放'], ['mute', '静音'], ['forceRate', '强制锁倍速'],
    ['skip', '秒过(改进度上报)'], ['autoNext', '自动下一节'], ['autoQuiz', '自动答题'],
    ['autoSubmit', '自动提交'], ['autoDoc', '文档/PPT 翻页'], ['antiIdle', '防挂机'], ['debug', '调试日志']
  ];
  const TEXT_FIELDS = [
    ['apiBase', 'API 地址'], ['apiKey', 'API Key'], ['model', '模型名'], ['bankApi', '题库接口(可选)']
  ];

  const CSS = [
    '#cxh-panel{position:fixed;top:72px;right:14px;width:292px;z-index:2147483647;',
    'font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#e8eaed;background:#1f2430;',
    'border:1px solid #3a4152;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);overflow:hidden;user-select:none}',
    '#cxh-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;',
    'background:#2a3140;cursor:move;font-weight:600}',
    '#cxh-panel .hd .st{font-size:11px;font-weight:400;margin-left:6px}',
    '#cxh-panel .hd .ops span{opacity:.75;cursor:pointer;padding:0 4px}',
    '#cxh-panel .bd{padding:10px;max-height:72vh;overflow:auto}',
    '#cxh-panel .row{display:flex;align-items:center;justify-content:space-between;padding:3px 0}',
    '#cxh-panel input[type=checkbox]{width:14px;height:14px;accent-color:#4c9aff}',
    '#cxh-panel input[type=number],#cxh-panel input[type=text],#cxh-panel input[type=password],#cxh-panel textarea{',
    'width:100%;background:#151922;border:1px solid #3a4152;color:#e8eaed;border-radius:6px;padding:4px 6px;font-size:12px;box-sizing:border-box}',
    '#cxh-panel textarea{height:52px;resize:vertical}',
    '#cxh-panel .lbl{padding:6px 0 2px;opacity:.7}',
    '#cxh-panel .btns{display:flex;gap:6px;margin-top:9px}',
    '#cxh-panel .btns button{flex:1;background:#4c9aff;border:0;color:#fff;border-radius:6px;padding:6px;cursor:pointer;font-size:12px}',
    '#cxh-panel .btns button.ghost{background:#3a4152}',
    '#cxh-panel .log{margin-top:8px;padding:6px;background:#11141b;border-radius:6px;max-height:100px;overflow:auto;',
    'white-space:pre-wrap;font-family:Consolas,monospace;font-size:11px;color:#8fb8e0}',
    '#cxh-panel.collapsed .bd{display:none}'
  ].join('');

  function buildPanel() {
    if (!IS_TOP || panel || !document.body) return;

    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    const root = document.createElement('div');
    root.id = 'cxh-panel';
    root.innerHTML = '<div class="hd"><div>学习通助手<span class="st"></span></div>' +
      '<div class="ops"><span data-act="min">—</span><span data-act="close">×</span></div></div><div class="bd"></div>';

    const bd = root.querySelector('.bd');
    const logEl = document.createElement('div');
    logEl.className = 'log';

    BOOL_FIELDS.forEach(([k, label]) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span>' + label + '</span>';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!cfg[k];
      cb.onchange = () => { cfg[k] = cb.checked; saveCfg(); pushCfg(); paint(); };
      row.appendChild(cb);
      bd.appendChild(row);
    });

    const rateRow = document.createElement('div');
    rateRow.className = 'row';
    rateRow.innerHTML = '<span>倍速</span>';
    const rate = document.createElement('input');
    rate.type = 'number'; rate.min = 1; rate.max = 16; rate.step = 0.25; rate.value = cfg.rate;
    rate.style.width = '66px';
    rate.onchange = () => {
      cfg.rate = Math.min(16, Math.max(1, parseFloat(rate.value) || 1));
      rate.value = cfg.rate; saveCfg(); applyRateNow(); pushCfg(); paint();
      log('倍速设为 ' + cfg.rate + '，已广播给子 frame');
    };
    rateRow.appendChild(rate);
    bd.appendChild(rateRow);

    TEXT_FIELDS.forEach(([k, label]) => {
      const l = document.createElement('div');
      l.className = 'lbl'; l.textContent = label;
      const inp = document.createElement('input');
      inp.type = k === 'apiKey' ? 'password' : 'text';
      inp.value = cfg[k] || '';
      inp.placeholder = k === 'apiBase' ? 'https://api.openai.com/v1' : '';
      inp.onchange = () => {
        cfg[k] = inp.value.trim();
        state.noApiWarned = false; state.attempts = {}; state.finished = {};
        saveCfg(); pushCfg(); paint();
        log('已保存 ' + label + '，已同步给所有 frame');
      };
      bd.appendChild(l); bd.appendChild(inp);
    });

    const pl = document.createElement('div');
    pl.className = 'lbl'; pl.textContent = 'System Prompt';
    const pta = document.createElement('textarea');
    pta.value = cfg.systemPrompt;
    pta.onchange = () => { cfg.systemPrompt = pta.value; saveCfg(); };
    bd.appendChild(pl); bd.appendChild(pta);

    const btns = document.createElement('div');
    btns.className = 'btns';
    const b1 = document.createElement('button');
    b1.textContent = '立即答题';
    b1.onclick = () => {
      state.attempts = {}; state.finished = {}; state.done = {}; state.solving = false;
      const n = collectQuestions().length;
      if (n) { log('本 frame 有 ' + n + ' 题，开始作答'); solveAll(); }
      else { log('本 frame 没有题目，广播给子 frame 作答'); pushCmd('solve'); }
    };
    const b2 = document.createElement('button');
    b2.className = 'ghost'; b2.textContent = '下一节';
    b2.onclick = () => {
      state.lastNext = 0;
      if (goNext()) return;
      log('本层没有翻页按钮，广播给其它 frame');
      pushCmd('next');
    };
    const b3 = document.createElement('button');
    b3.className = 'ghost'; b3.textContent = '诊断';
    b3.onclick = () => {
      log('frame=' + (IS_TOP ? 'top' : 'sub') + ' 题=' + collectQuestions().length +
          ' 视频=' + videos().length + ' 提交=' + (findSubmitBtn() ? 'yes' : 'no') +
          ' API=' + (cfg.apiKey ? 'set' : 'empty') + ' 文档页=' + isDocPage());
    };
    const b4 = document.createElement('button');
    b4.className = 'ghost'; b4.textContent = '扫描';
    b4.onclick = scanDom;
    btns.appendChild(b1); btns.appendChild(b2); btns.appendChild(b3); btns.appendChild(b4);
    bd.appendChild(btns);

    const btns2 = document.createElement('div');
    btns2.className = 'btns';
    const b5 = document.createElement('button');
    b5.textContent = '提交';
    b5.onclick = () => {
      log('手动触发提交');
      submitPaper().then(ok => { if (!ok) pushCmd('submit'); });
    };
    btns2.appendChild(b5);
    const b6 = document.createElement('button');
    b6.className = 'ghost';
    b6.textContent = '全量诊断';
    b6.onclick = scanAll;
    btns2.appendChild(b6);
    bd.appendChild(btns2);
    bd.appendChild(logEl);

    document.documentElement.appendChild(root);

    const hd = root.querySelector('.hd');
    let drag = null;
    hd.addEventListener('mousedown', e => {
      if (e.target.dataset && e.target.dataset.act) return;
      drag = { x: e.clientX, y: e.clientY, l: root.offsetLeft, t: root.offsetTop };
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      root.style.left = Math.max(0, drag.l + e.clientX - drag.x) + 'px';
      root.style.top = Math.max(0, drag.t + e.clientY - drag.y) + 'px';
      root.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = null; });
    hd.addEventListener('click', e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'min') root.classList.toggle('collapsed');
      if (act === 'close') root.style.display = 'none';
    });

    panel = { root, logEl, statusEl: root.querySelector('.st') };
    paint();
  }

  /* 非顶层 frame 画个小角标，证明脚本在这个 frame 活着；点一下看本 frame 诊断 */
  function buildBadge() {
    if (IS_TOP || document.getElementById('cxh-badge') || !document.body) return;
    const b = document.createElement('div');
    b.id = 'cxh-badge';
    b.textContent = 'CX';
    b.title = '学习通助手（本 frame）';
    Object.assign(b.style, {
      position: 'fixed', right: '6px', bottom: '6px', zIndex: '2147483646',
      background: '#1f2430', color: '#2ecc71', border: '1px solid #3a4152',
      borderRadius: '6px', font: '11px/16px monospace', padding: '0 4px',
      cursor: 'pointer', opacity: '0.75', userSelect: 'none'
    });
    b.onclick = () => {
      b.textContent = '题=' + collectQuestions().length + ' 视频=' + videos().length +
        ' 提交=' + (findSubmitBtn() ? 'y' : 'n') + ' API=' + (cfg.apiKey ? 'y' : 'n');
      b.style.padding = '2px 6px';
      b.style.color = '#8fb8e0';
    };
    document.documentElement.appendChild(b);
  }

  function scanDom() {
    const qs = collectQuestions();
    if (!qs.length) {
      if (IS_TOP) { log('本 frame 没题目，向子 frame 请求扫描'); pushCmd('scan'); }
      else log('扫描：本 frame 没发现题目');
      return;
    }
    const q = qs[0];
    const lines = [];
    lines.push('frame=' + (IS_TOP ? 'top' : 'sub') + ' 题数=' + qs.length);
    lines.push('题干: ' + q.stem.slice(0, 60));
    lines.push('题型: ' + q.type + '  选项数: ' + q.options.length);
    q.options.forEach(o => {
      const inp = o.el.querySelector ? o.el.querySelector('input') : null;
      lines.push('--- ' + o.label + ' class="' + (o.el.className || '') + '" hasInput=' + !!inp +
        (inp ? ' type=' + inp.type + ' checked=' + inp.checked : ''));
      lines.push((o.el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 260));
    });
    const txt = lines.join('\n');
    console.log(TAG + ' 扫描结果\n' + txt);
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(txt, 'text'); log('扫描结果已复制到剪贴板'); }
      else log('扫描结果已打印到控制台 F12');
    } catch (e) { log('扫描结果已打印到控制台 F12'); }
  }

  /* 全量诊断：把所有能访问到的文档、题目数、提交相关按钮一次性打出来 */
  function scanAll() {
    const frames = safeDocs();
    const lines = ['=== 可访问文档 ' + frames.length + ' 个 ==='];
    frames.forEach((f, i) => {
      let q = 0;
      try { q = f.doc.querySelectorAll('.TiMu,.questionLi,.Cy_TItle').length; } catch (e) { }
      let inputs = 0;
      try { inputs = f.doc.querySelectorAll('input[type=radio],input[type=checkbox]').length; } catch (e) { }
      lines.push('--- frame' + i + ' 脚本=' + (f.mine ? 'yes' : 'no') + ' 题=' + q + ' 选项框=' + inputs);
      lines.push('    url=' + String(f.url).slice(0, 100));
      try {
        const btns = [];
        f.doc.querySelectorAll('a,button,div[onclick],span[onclick],input[type=button],input[type=submit]').forEach(el => {
          const t = ((el.innerText || el.value || '') + '').replace(/\s+/g, '');
          if (t && t.length <= 10 && /提交|交卷|保存/.test(t)) {
            btns.push('    [' + (isVisible(el) ? '可见' : '隐藏') + '] ' + t + ' → ' + String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 150));
          }
        });
        btns.slice(0, 8).forEach(b => lines.push(b));
        if (!btns.length) lines.push('    （本层没有含"提交/交卷/保存"的按钮）');
      } catch (e) { }
    });
    const txt = lines.join('\n');
    console.log(TAG + ' 全量诊断\n' + txt);
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(txt, 'text'); log('全量诊断已复制到剪贴板（' + frames.length + ' 个文档），发我即可'); }
      else log('全量诊断已打印到控制台 F12');
    } catch (e) { log('全量诊断已打印到控制台 F12'); }
  }

  function applyRateNow() {
    videos().forEach(v => { try { v.playbackRate = cfg.rate; } catch (e) { } });
  }

  /* ==================================================================
   * 9. 启动
   * ================================================================== */
  function boot() {
    hookVisibility();
    hookRate();
    hookNetwork();
    hookDialogs();
    listenBroadcast();

    const start = () => {
      buildPanel();
      buildBadge();
      try {
        if (typeof GM_registerMenuCommand === 'function' && IS_TOP) {
          GM_registerMenuCommand('打开/隐藏面板', () => {
            if (!panel) buildPanel();
            if (panel) panel.root.style.display = panel.root.style.display === 'none' ? 'block' : 'none';
          });
          GM_registerMenuCommand('立即答题', () => { state.attempts = {}; state.finished = {}; state.done = {}; state.solving = false; solveAll(); });
          GM_registerMenuCommand('下一节', () => { state.lastNext = 0; if (!goNext()) broadcastNext('menu'); });
        }
      } catch (e) { }

      setInterval(() => {
        if (!cfg.enabled) return;
        try {
          if (location.href !== state.lastHref) {
            state.lastHref = location.href;
            state.nextStrat = 0; state.nextFail = 0; state.pending = null;
          }
        } catch (e) { }
        try { checkNextEffect(); } catch (e) { }
        try { confirmDialog(); } catch (e) { }
        try { tickVideo(); } catch (e) { }
        try { tickDoc(); } catch (e) { }
        try { tickQuiz(); } catch (e) { }
        try { tickIdle(); } catch (e) { }
      }, TICK);

      log('已启动(' + (IS_TOP ? 'top' : 'sub') + ') ' + location.href.slice(0, 60));

      // 子 frame 的 cfg 是页面打开时load 的，之后用户在面板里填的 Key 收不到，主动要一次
      if (!IS_TOP) setTimeout(() => pushCmd('getcfg'), 1200);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  try {
    W.__CXH__ = {
      get cfg() { return cfg; },
      state, solveAll, goNext, broadcastNext, pushCmd, pushCfg, submitPaper,
      questionRoots, collectQuestions, genericQuestions, videos, parseQuestion, findSubmitBtn
    };
  } catch (e) { }

  boot();
})();
