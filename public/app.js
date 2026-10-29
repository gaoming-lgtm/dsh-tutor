// 小D · 编程私教 — frontend
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  config: null,
  account: null,
  model: 'deepseek-v4-pro',
  voice: 'zh-CN-XiaoxiaoNeural',
  ttsOn: true,
  listening: false,
  busy: false,
  currentBubble: null,
  turnText: [],
  lastUserText: '',
  board: null,
  speaking: false,
  recognition: null,
  wantMic: false,
  recording: false,
  sttLocal: false,
  widgetOpen: false,
  pendingSpeech: '',
};

const els = {
  messages: $('messages'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  micBtn: $('micBtn'),
  orbBtn: $('orbBtn'),
  modelSelect: $('modelSelect'),
  voiceSelect: $('voiceSelect'),
  voiceToggle: $('voiceToggle'),
  balanceValue: $('balanceValue'),
  statusText: $('statusText'),
  statusPill: $('statusPill'),
  voiceTitle: $('voiceTitle'),
  voiceSub: $('voiceSub'),
  rootPath: $('rootPath'),
  boardBadge: $('boardBadge'),
  toast: $('toast'),
  fileTree: $('fileTree'),
  composerHint: $('composerHint'),
};

// ---------------------------------------------------------------- boot

async function boot() {
  const r = await fetch('/api/bootstrap');
  if (!r.ok) return;
  const data = await r.json();
  state.config = data.config;
  state.account = data.account;
  state.model = data.config.model;
  state.voice = data.config.voice;
  if (data.config.ttsAvailable === false) speech.mode = 'browser';
  state.sttLocal = data.config.sttAvailable === true;
  if (state.sttLocal) els.composerHint.textContent = 'Enter 发送 · 点麦克风常开，说完一句自动发，再点一下关';

  els.modelSelect.innerHTML = data.config.models
    .map((m) => `<option value="${m.id}" ${m.id === state.model ? 'selected' : ''}>${m.name}</option>`)
    .join('');
  els.voiceSelect.innerHTML = data.config.voices
    .map((v) => `<option value="${v.id}" ${v.id === state.voice ? 'selected' : ''}>${v.name} · ${v.desc}</option>`)
    .join('');
  els.rootPath.textContent = shorten(data.config.projectRoot);
  els.rootPath.title = data.config.projectRoot;
  renderAccount(data.account);

  if (!data.account?.connected) {
    addError('没找到可用的 DeepSeek Key。设置环境变量 DEEPSEEK_API_KEY，或在 config.json 里填 apiKey。');
  }
  loadTree();
  if (data.current && data.current.messages?.length) {
    restoreSession(data.current);
  } else {
    greet();
  }
  maybeIdeBanner(data.ide);
}

const TOOL_LABELS = {
  list_dir: '查看目录',
  read_file: '读取文件',
  write_file: '写入文件',
  replace_in_file: '修改代码',
  run_command: '执行命令',
  show_board: '上黑板',
  set_plan: '更新计划',
  open_in_editor: '打开编辑器',
};

function restoreSession(s) {
  state.sessionId = s.id;
  els.messages.innerHTML = '';
  const lineById = new Map();
  for (const m of s.messages) {
    if (m.role === 'user') {
      addUserBubble(m.content);
    } else if (m.role === 'assistant') {
      if (m.content) {
        const b = addAiBubble();
        b.innerHTML = renderMD(m.content);
      }
      for (const tc of m.tool_calls || []) {
        const el = addToolLine(tc.function?.name, TOOL_LABELS[tc.function?.name] || tc.function?.name);
        el.classList.remove('running');
        lineById.set(tc.id, el);
      }
    } else if (m.role === 'tool') {
      const el = lineById.get(m.tool_call_id);
      if (el) {
        const ok = !/失败|拒绝|error/i.test(String(m.content).slice(0, 40));
        el.querySelector('.dot').style.background = ok ? 'var(--mint)' : 'var(--danger)';
        el.querySelector('.tl-out').textContent = '· ' + String(m.content).split('\n')[0].slice(0, 80);
      }
    }
  }
  if (s.plan?.length) setPlan(s.plan);
  if (s.board) setBoard(s.board);
  els.voiceSub.textContent = '接着上一课 · 点麦克风继续说';
  setStatus('在线', '');
}

function renderAccount(a) {
  if (!a) return;
  if (a.balance != null) els.balanceValue.textContent = `¥${a.balance.toFixed(2)}`;
  else els.balanceValue.textContent = '—';
  const pill = $('balancePill');
  pill.title = `DeepSeek 账户余额 ¥${a.balance ?? '?'}\nKey ${a.keyMasked}`;
}

function greet() {
  const h = new Date().getHours();
  const tod = h < 6 ? '这么晚还在写代码' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const line = `${tod}。我是小D，坐你旁边陪你写代码的。今天想做个什么东西，或者有哪段代码卡住了？`;
  const m = addAiBubble();
  m.innerHTML = renderMD(line);
  state.turnText = [line];
  renderStarters();
  speakLater(line);
}

function renderStarters() {
  const old = $('starters');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'starters';
  wrap.id = 'starters';
  wrap.innerHTML = ['我想学 Python，从零开始', '帮我看看这段报错', '做一个能记账的小工具']
    .map((t) => `<button class="chip starter">${t}</button>`)
    .join('');
  wrap.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { wrap.remove(); send(b.textContent); };
  });
  els.messages.appendChild(wrap);
  scrollDown(true);
}

// ---------------------------------------------------------------- markdown

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KEYWORDS = {
  python: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|yield|lambda|None|True|False|pass|break|continue|global|nonlocal|assert|del|is|async|await)\b/g,
  javascript: /\b(const|let|var|function|return|if|else|for|while|of|in|new|class|extends|import|from|export|default|try|catch|finally|throw|async|await|this|null|undefined|true|false|typeof|instanceof|switch|case|break|continue|do)\b/g,
  typescript: /\b(const|let|var|function|return|if|else|for|while|of|in|new|class|extends|implements|interface|type|import|from|export|default|try|catch|finally|throw|async|await|this|null|undefined|true|false|as|enum|public|private|readonly)\b/g,
  text: null,
};

function highlight(code, lang) {
  const lg = (lang || '').toLowerCase();
  const kw = KEYWORDS[lg] || null;
  const tokens = [];
  let i = 0;
  const push = (t, v) => {
    const last = tokens[tokens.length - 1];
    if (last && last.t === t) last.v += v;
    else tokens.push({ t, v });
  };
  while (i < code.length) {
    const ch = code[i];
    // comments
    if ((ch === '#' && ['python', 'bash', 'yaml', 'text'].includes(lg)) || (ch === '/' && code[i + 1] === '/') || (ch === '/' && code[i + 1] === '*')) {
      let j = i;
      if (ch === '/' && code[i + 1] === '*') { const end = code.indexOf('*/', i + 2); j = end < 0 ? code.length : end + 2; }
      else { const end = code.indexOf('\n', i); j = end < 0 ? code.length : end; }
      push('c', code.slice(i, j));
      i = j;
      continue;
    }
    // strings
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) { if (code[j] === '\\') j++; j++; }
      j = Math.min(j + 1, code.length);
      push('s', code.slice(i, j));
      i = j;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch) && !/[A-Za-z_]/.test(code[i - 1] || '')) {
      let j = i;
      while (j < code.length && /[0-9._xXa-fA-F]/.test(code[j])) j++;
      push('n', code.slice(i, j));
      i = j;
      continue;
    }
    push('t', ch);
    i++;
  }
  return tokens
    .map((tok) => {
      if (tok.t !== 't') return `<span class="tok-${tok.t}">${esc(tok.v)}</span>`;
      const e = esc(tok.v);
      return kw ? e.replace(kw, (m) => `<span class="tok-k">${m}</span>`) : e;
    })
    .join('');
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

let codeSeq = 0;
function codeCard(code, lang, title) {
  const id = `code-${++codeSeq}`;
  return `<div class="code-card" data-code-id="${id}">
    <div class="code-head">
      <span class="lang">${esc(lang || 'code')}</span>
      ${title ? `<span class="code-title">${esc(title)}</span>` : ''}
      <div class="code-actions">
        <button class="mini-btn" data-act="board">上黑板</button>
        <button class="mini-btn" data-act="copy">复制</button>
      </div>
    </div>
    <pre><code>${highlight(code, lang)}</code></pre>
  </div>`;
}

const codeStore = new Map();

function renderMD(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flush = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1] || 'text';
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const code = buf.join('\n');
      const id = `code-${++codeSeq}`;
      codeStore.set(id, { code, lang });
      out.push(codeCardHTML(id, code, lang));
      continue;
    }
    if (/^\s*###\s+/.test(line)) { flush(); out.push(`<h3>${inline(line.replace(/^\s*###\s+/, ''))}</h3>`); i++; continue; }
    if (/^\s*##\s+/.test(line)) { flush(); out.push(`<h2>${inline(line.replace(/^\s*##\s+/, ''))}</h2>`); i++; continue; }
    if (/^\s*#\s+/.test(line)) { flush(); out.push(`<h3>${inline(line.replace(/^\s*#\s+/, ''))}</h3>`); i++; continue; }
    if (/^\s*>\s?/.test(line)) { flush(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(inline(lines[i].replace(/^\s*[-*]\s+/, ''))); i++; }
      out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))); i++; }
      out.push(`<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

function codeCardHTML(id, code, lang, title) {
  return `<div class="code-card" data-code-id="${id}">
    <div class="code-head">
      <span class="lang">${esc(lang || 'code')}</span>
      ${title ? `<span class="code-title">${esc(title)}</span>` : ''}
      <div class="code-actions">
        <button class="mini-btn" data-act="board" data-id="${id}">上黑板</button>
        <button class="mini-btn" data-act="copy" data-id="${id}">复制</button>
      </div>
    </div>
    <pre><code>${highlight(code, lang)}</code></pre>
  </div>`;
}

// ---------------------------------------------------------------- messages

function atBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}
function scrollDown(force) {
  if (force || atBottom()) els.messages.scrollTop = els.messages.scrollHeight;
}

function addUserBubble(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg me';
  wrap.innerHTML = `<div class="avatar">你</div><div class="content">${renderMD(text)}</div>`;
  els.messages.appendChild(wrap);
  scrollDown(true);
}

function addAiBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.innerHTML = `<div class="avatar">D</div><div class="content"></div>`;
  els.messages.appendChild(wrap);
  scrollDown(true);
  return wrap.querySelector('.content');
}

function addToolLine(name, label) {
  const el = document.createElement('div');
  el.className = 'tool-line running';
  el.innerHTML = `<span class="dot"></span><span class="tl-name">${esc(label || name)}</span><span class="tl-out">· 进行中…</span>`;
  els.messages.appendChild(el);
  scrollDown();
  return el;
}

function addToolResult(name, ok, output) {
  const el = document.createElement('details');
  el.className = 'tool-result';
  el.innerHTML = `<summary>${ok ? '✓' : '✕'} ${esc(name)}结果</summary><pre>${esc(output || '')}</pre>`;
  els.messages.appendChild(el);
  scrollDown();
  return el;
}

function addError(msg) {
  const el = document.createElement('div');
  el.className = 'err-line';
  el.textContent = '⚠ ' + msg;
  els.messages.appendChild(el);
  scrollDown(true);
}

function addScreenshot(d) {
  const el = document.createElement('div');
  el.className = 'shot-card';
  el.innerHTML = `<div class="shot-head"><span>👁 我看了一眼屏幕</span><span class="shot-title">${esc(d.title || '')}</span><a href="${d.url}" target="_blank" rel="noreferrer">原图</a></div><img src="${d.url}" alt="屏幕截图">`;
  els.messages.appendChild(el);
  scrollDown();
}

// ---------------------------------------------------------------- approval

function renderApproval(ev) {
  const risk = ev.risk || 'medium';
  const el = document.createElement('div');
  el.className = `approval risk-${risk}`;
  const reason = ev.args?.reason || ev.args?.command || ev.args?.path || '';
  let body = '';

  if (ev.name === 'write_file' || ev.name === 'replace_in_file') {
    body = `<div class="ap-reason">${esc(reason || '要改你的文件')}</div>
      <div class="kv">文件：<code class="inline">${esc(ev.args?.path || '')}</code></div>`;
    if (ev.name === 'write_file') {
      const c = String(ev.args?.content || '');
      body += `<pre>${esc(c.length > 3000 ? c.slice(0, 3000) + '\n…（后面还有 ' + (c.length - 3000) + ' 个字符）' : c)}</pre>`;
    } else {
      body += `<pre><span class="dim">- ${esc(ev.args?.old_string || '')}</span>
<span class="hl">+ ${esc(ev.args?.new_string || '')}</span></pre>`;
    }
  } else if (ev.name === 'run_command') {
    body = `<div class="ap-reason">要执行一条命令</div><pre>$ ${esc(ev.args?.command || '')}</pre>`;
  } else if (ev.name === 'open_in_editor') {
    body = `<div class="ap-reason">要在你的编辑器里打开文件</div>
      <div class="kv"><code class="inline">${esc(ev.args?.path || '')}</code>${ev.args?.line ? ' · 第 ' + ev.args.line + ' 行' : ''}</div>`;
  } else {
    body = `<div class="ap-reason">${esc(reason)}</div>`;
  }

  el.innerHTML = `
    <div class="ap-head">
      <span>${risk === 'high' ? '⚠ 需要你点头（高危）' : '✋ 需要你点头'}</span>
      <span style="margin-left:auto;font-size:11px;color:var(--muted)">${esc(ev.label || ev.name)}</span>
    </div>
    <div class="ap-body">${body}</div>
    <div class="ap-actions">
      <button class="btn primary" data-d="allow">允许这一次</button>
      ${ev.rule ? `<button class="btn" data-d="always">${esc(ev.rule.label)}</button>` : ''}
      <button class="btn" data-d="turn">本回合都允许</button>
      <button class="btn ghost" data-d="deny">不，别动</button>
    </div>
    <div class="ap-hint">点按钮，或直接对着麦克风说「允许」/「不行」</div>`;
  els.messages.appendChild(el);
  scrollDown(true);

  el.querySelectorAll('button[data-d]').forEach((b) => {
    b.onclick = () => decide(b.dataset.d);
  });

  async function decide(decision) {
    if (el.classList.contains('done')) return;
    el.querySelectorAll('button').forEach((x) => (x.disabled = true));
    el.classList.add('done');
    const verdict = document.createElement('div');
    verdict.className = 'ap-verdict';
    verdict.textContent =
      decision === 'deny' ? '你拒绝了这次操作'
        : decision === 'turn' ? '本回合允许了 ' + (ev.label || ev.name)
          : decision === 'always' ? '已加入长期白名单：' + (ev.rule?.label || '')
            : '已允许一次';
    el.appendChild(verdict);
    el.querySelector('.ap-hint')?.remove();
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ev.id, decision }),
    }).catch(() => {});
    if (decision === 'always') setTimeout(loadAllowlist, 300);
  }

  listenForApproval(decide);
}

let approvalRec = null;
function listenForApproval(decide) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !state.ttsOn) return;
  try { approvalRec?.abort(); } catch {}
  const rec = new SR();
  approvalRec = rec;
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  let done = false;
  const stop = () => { if (done) return; done = true; try { rec.stop(); } catch {} };
  rec.onresult = (e) => {
    if (done) return;
    const t = Array.from(e.results).map((r) => r[0].transcript).join('');
    if (/(不要|不行|拒绝|取消|算了|别动)/.test(t)) { stop(); decide('deny'); }
    else if (/(允许|可以|同意|确认|好的|没问题)/.test(t)) { stop(); decide('allow'); }
  };
  rec.onerror = () => stop();
  rec.onend = () => { done = true; };
  try { rec.start(); } catch { return; }
  setTimeout(stop, 25000);
}

// ---------------------------------------------------------------- chat

function setStatus(text, cls) {
  els.statusText.textContent = text;
  els.statusPill.className = 'status-pill ' + (cls || '');
}

function setBusy(v) {
  state.busy = v;
  els.sendBtn.disabled = v;
  els.input.disabled = v;
  document.body.classList.toggle('thinking', v && !state.speaking);
  if (!v) setStatus('在线', '');
}

async function send(text) {
  text = (text || '').trim();
  if (!text || state.busy) return;
  $('starters')?.remove();
  stopSpeaking();
  state.lastUserText = text;
  addUserBubble(text);
  els.input.value = '';
  autoGrow();
  setBusy(true);
  setStatus('思考中', 'busy');
  state.turnText = [];
  state.currentBubble = null;

  const body = { text, sessionId: state.sessionId };
  let resp;
  try {
    resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    addError('连不上本地服务：' + e.message);
    setBusy(false);
    return;
  }
  if (!resp.ok || !resp.body) {
    addError('请求失败：' + resp.status);
    setBusy(false);
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pendingRender = null;

  const flushRender = () => {
    if (pendingRender) { cancelAnimationFrame(pendingRender); pendingRender = null; }
    if (!state.currentBubble) return;
    state.currentBubble.innerHTML = renderMD(state.currentText || '');
    scrollDown();
  };
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = requestAnimationFrame(() => { pendingRender = null; flushRender(); });
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() || '';
      for (const block of events) {
        if (!block.trim() || block.startsWith(':')) continue;
        let evName = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        let data = {};
        try { data = JSON.parse(dataLines.join('\n') || '{}'); } catch {}
        handleEvent(evName, data, { flushRender, scheduleRender });
      }
    }
  } catch (e) {
    addError('连接中断：' + e.message);
  } finally {
    flushRender();
    setBusy(false);
    if (state.turnText.length) speakLater(state.turnText.join(' '));
  }

  function handleEvent(name, d, h) {
    switch (name) {
      case 'session':
        state.sessionId = d.id;
        break;
      case 'thinking':
        if (d.on) setStatus('思考中', 'busy');
        break;
      case 'delta':
        if (!state.currentBubble) {
          state.currentBubble = addAiBubble();
          state.currentText = '';
        }
        state.currentText = (state.currentText || '') + d.text;
        state.turnText.push(d.text);
        h.scheduleRender();
        break;
      case 'segment_end':
        state.currentBubble = null;
        state.currentText = '';
        break;
      case 'tool_start': {
        state.currentBubble = null;
        state.currentText = '';
        const el = addToolLine(d.name, d.label);
        el.dataset.id = d.id;
        setStatus('动手：' + (d.label || d.name), 'busy');
        break;
      }
      case 'tool_result': {
        const el = els.messages.querySelector(`.tool-line[data-id="${CSS.escape(d.id)}"]`);
        if (el) {
          el.classList.remove('running');
          el.querySelector('.dot').style.background = d.ok ? 'var(--mint)' : 'var(--danger)';
          el.querySelector('.tl-out').textContent = '· ' + (d.denied ? '你拒绝了' : d.ok ? (d.output || '').split('\n')[0].slice(0, 90) : '失败了');
        }
        if (d.output && (d.name === 'list_dir' || d.name === 'read_file' || d.name === 'run_command')) {
          addToolResult(d.name, d.ok, d.output);
        }
        setStatus('思考中', 'busy');
        break;
      }
      case 'approval':
        state.currentBubble = null;
        state.currentText = '';
        renderApproval(d);
        setStatus('等你授权', 'busy');
        break;
      case 'board':
        setBoard(d);
        break;
      case 'screenshot':
        addScreenshot(d);
        break;
      case 'plan':
        setPlan(d.steps);
        break;
      case 'usage':
        break;
      case 'error':
        addError(d.message);
        break;
      case 'done':
        state.sessionId = d.sessionId || state.sessionId;
        break;
    }
  }
}

// ---------------------------------------------------------------- board

function shorten(p) {
  if (!p) return '—';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? '…\\' + parts.slice(-2).join('\\') : p;
}

function boardHTML(d) {
  if (!d) {
    return `<div class="empty-board"><div class="empty-icon">⌁</div><p>黑板是空的</p><span>小D 讲解、示范代码时会写在这里。</span></div>`;
  }
  const lang = d.language || 'text';
  const isFile = d.kind === 'file';
  const content = d.content || '';
  return `<div class="board-card">
      <div class="bc-head">
        <span class="bc-lang">${esc(lang)}</span>
        <span class="bc-title">${esc(d.title || d.path || '黑板')}</span>
        <div style="margin-left:auto" class="code-actions">
          ${isFile ? `<button class="mini-btn" id="bcEdit">编辑</button>` : ''}
          <button class="mini-btn" id="bcCopy">复制</button>
          <button class="mini-btn" id="bcPop">${boardWin && !boardWin.closed ? '收回' : '弹出'}</button>
        </div>
      </div>
      ${d.note ? `<div class="bc-note">${esc(d.note)}</div>` : ''}
      ${isFile ? `<div class="bc-note mono-path">${esc(d.path)}</div>` : ''}
      ${(d.points || []).length ? `<ul class="bc-points">${d.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      <pre id="bcPre"><code>${highlight(content, lang)}</code></pre>
      <div class="bc-foot"></div>
    </div>`;
}

function wireBoard(scope) {
  const d = state.board || {};
  const copy = scope.querySelector('#bcCopy');
  if (copy) copy.onclick = () => copyText(d.content || '');
  const edit = scope.querySelector('#bcEdit');
  if (edit && d.kind === 'file') edit.onclick = () => openEditor(d.path, d.content || '');
  const pop = scope.querySelector('#bcPop');
  if (pop) pop.onclick = toggleBoardWindow;
}

function setBoard(d) {
  state.board = { ...d };
  const tab = $('tab-board');
  $('boardBadge').textContent = '黑板';
  switchTab('board');
  tab.innerHTML = boardHTML(state.board);
  wireBoard(tab);
  syncBoardWindow();
}

let boardWin = null;

async function toggleBoardWindow() {
  if (state.widgetOpen) {
    toast('黑板窗口已经开着，用它右上角的 × 关闭');
    return;
  }
  try {
    const r = await fetch('/api/widget', { method: 'POST' });
    if (r.ok) {
      state.widgetOpen = true;
      toast('黑板已弹到桌面，并且置顶');
      return;
    }
  } catch {}
  if (boardWin && !boardWin.closed) {
    boardWin.close();
    boardWin = null;
    setBoard({ ...(state.board || {}) });
    return;
  }
  let win = null;
  if ('documentPictureInPicture' in window) {
    try {
      win = await documentPictureInPicture.requestWindow({ width: 560, height: 720 });
    } catch {
      win = null;
    }
  }
  if (!win) win = window.open('', 'xiaodBoard', 'width=560,height=720');

  if (!win) return toast('浏览器拦截了弹窗，请允许弹出窗口');
  boardWin = win;
  try {
    const doc = win.document;
    doc.open();
    doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <title>小D · 黑板</title>
      <link rel="stylesheet" href="/style.css">
      <style>body{padding:12px;overflow:auto;background:#080c12}.float-wrap{min-height:100%}</style>
      </head><body><div class="float-wrap" id="floatBoard"></div></body></html>`);
    doc.close();
  } catch {
    return toast('弹窗打开失败');
  }
  const sync = () => {
    if (!boardWin || boardWin.closed) return;
    const el = boardWin.document.getElementById('floatBoard');
    if (el) el.innerHTML = boardHTML(state.board);
  };
  win.addEventListener('pagehide', () => {
    boardWin = null;
  });
  setTimeout(sync, 200);
  setTimeout(sync, 600);
  if (state.board) setBoard({ ...state.board });
}

function syncBoardWindow() {
  if (!boardWin || boardWin.closed) return;
  const el = boardWin.document.getElementById('floatBoard');
  if (el) el.innerHTML = boardHTML(state.board);
}

function openEditor(path, content) {
  const tab = $('tab-board');
  tab.innerHTML = `
    <div class="board-card">
      <div class="bc-head">
        <span class="bc-lang">${esc(path.split('.').pop() || 'text')}</span>
        <span class="bc-title">${esc(path)}</span>
        <div style="margin-left:auto" class="code-actions">
          <button class="mini-btn" id="bcSave">保存</button>
          <button class="mini-btn" id="bcCancel">取消</button>
        </div>
      </div>
      <textarea id="bcArea" spellcheck="false"></textarea>
    </div>`;
  const area = $('bcArea');
  area.value = content;
  area.focus();
  $('bcSave').onclick = async () => {
    const r = await fetch('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content: area.value }),
    });
    if (r.ok) {
      toast('已保存 ' + path);
      setBoard({ kind: 'file', path, content: area.value, language: path.split('.').pop() });
      loadTree();
    } else toast('保存失败');
  };
  $('bcCancel').onclick = () => setBoard({ kind: 'file', path, content, language: path.split('.').pop() });
}

function setPlan(steps) {
  $('boardBadge').textContent = '计划';
  if (!state.board) switchTab('plan');
  const tab = $('tab-plan');
  tab.innerHTML = `<div class="plan-list">${steps
    .map(
      (s) => `<div class="plan-item ${s.status}">
        <span class="mark">${s.status === 'done' ? '✓' : s.status === 'in_progress' ? '●' : ''}</span>
        <span>${esc(s.title)}</span>
      </div>`
    )
    .join('')}</div>`;
  const item = tab.querySelector('.plan-item.in_progress');
  if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function loadTree() {
  try {
    const r = await fetch('/api/tree');
    const d = await r.json();
    if (!d.entries) return;
    els.fileTree.innerHTML = d.entries
      .map((e) =>
        e.type === 'dir'
          ? `<div class="tree-row dir" style="padding-left:${8 + (e.path.split('/').length - 1) * 12}px"><span class="ticon">▸</span>${esc(e.path.split('/').pop())}</div>`
          : `<div class="tree-row" data-path="${esc(e.path)}" style="padding-left:${8 + (e.path.split('/').length - 1) * 12}px"><span class="ticon">·</span>${esc(e.path.split('/').pop())}</div>`
      )
      .join('');
    els.fileTree.querySelectorAll('.tree-row[data-path]').forEach((row) => {
      row.onclick = async () => {
        const p = row.dataset.path;
        const r2 = await fetch('/api/file?path=' + encodeURIComponent(p));
        if (!r2.ok) return toast('打不开这个文件');
        const f = await r2.json();
        setBoard({ kind: 'file', path: f.path, content: f.content, language: f.language });
      };
    });
  } catch {}
}

function switchTab(name) {
  document.querySelectorAll('.board-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['board', 'plan', 'files', 'allow'].forEach((t) => ($('tab-' + t).hidden = t !== name));
  if (name === 'files') loadTree();
  if (name === 'allow') loadAllowlist();
}

const postAllow = (body) =>
  fetch('/api/allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);

async function loadAllowlist() {
  const a = await fetch('/api/allowlist').then((r) => r.json()).catch(() => null);
  if (a) renderAllowlist(a);
}

function renderAllowlist(a) {
  const body = $('allowBody');
  const rows = [];
  (a.dirs || []).forEach((v) => rows.push(['目录', v, 'dir']));
  (a.commands || []).forEach((v) => rows.push(['命令', v + ' …', 'command']));
  (a.tools || []).forEach((v) => rows.push(['工具', TOOL_LABELS[v] || v, 'tool']));
  if (a.screen) rows.push(['隐私', '看屏幕不再询问', 'screen']);

  body.innerHTML = `
    <div class="allow-head"><h3>长期白名单</h3><button class="btn primary" id="classMode">一键课堂模式</button>${rows.length ? '<button class="btn ghost" id="allowClear">全部清空</button>' : ''}</div>
    ${rows.length
      ? rows.map(([tag, label, type]) => `<div class="allow-row"><span class="tag">${tag}</span><span class="val" title="${esc(label)}">${esc(label)}</span><button class="rm" data-type="${type}" data-value="${esc(label)}">×</button></div>`).join('')
      : `<div class="empty-board"><div class="empty-icon">🔒</div><p>还没有长期授权</p><span>点上面的「一键课堂模式」，这节课就不再反复弹授权。</span></div>`}
    <div class="allow-hint">课堂模式 = 当前教学目录 + python/pip/pytest/node/npm run/git status 这些常用命令 + 看屏幕，都不再问。<br>删除、格式化、改注册表、关机、强推这类命令永远不自动放行。</div>`;

  body.querySelectorAll('.rm').forEach((b) => {
    b.onclick = async () => {
      await postAllow({ op: 'remove', type: b.dataset.type, value: b.dataset.value });
      loadAllowlist();
    };
  });
  const cm = $('classMode');
  if (cm) cm.onclick = enableClassMode;
  const c = $('allowClear');
  if (c) c.onclick = async () => {
    await postAllow({ op: 'clear' });
    loadAllowlist();
    toast('白名单已清空');
  };
}

async function enableClassMode() {
  const root = state.config?.projectRoot;
  if (!root) return toast('先设置教学目录');
  const commands = ['python', 'py', 'pip', 'pytest', 'node', 'npm run', 'git status', 'git diff'];
  await postAllow({ op: 'add', type: 'dir', value: root });
  for (const c of commands) await postAllow({ op: 'add', type: 'command', value: c });
  await postAllow({ op: 'add', type: 'screen' });
  loadAllowlist();
  toast('课堂模式已开：写这个目录、跑常用命令、看屏幕都不再问');
}

async function setProjectRoot(p) {
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectRoot: p }),
  });
  const d = await r.json();
  if (!r.ok) return toast(d.error || '目录无效');
  state.config.projectRoot = d.config.projectRoot;
  els.rootPath.textContent = shorten(d.config.projectRoot);
  els.rootPath.title = d.config.projectRoot;
  toast('教学目录已切换');
  loadTree();
}

function maybeIdeBanner(ide) {
  if (!ide?.lastProject) return;
  const root = (state.config?.projectRoot || '').toLowerCase();
  if (root && ide.lastProject.toLowerCase().startsWith(root)) return;
  const el = document.createElement('div');
  el.className = 'ide-banner';
  const file = ide.currentFile ? ide.currentFile.split(/[\\/]/).pop() : '';
  el.innerHTML = `<span>检测到你的 PyCharm 项目：<code>${esc(ide.lastProject)}</code>${file ? ` · 正在改 <code>${esc(file)}</code>` : ''}</span><button class="btn" id="useIdeRoot">切到这个项目</button>`;
  els.messages.appendChild(el);
  $('useIdeRoot').onclick = () => setProjectRoot(ide.lastProject);
}

// ---------------------------------------------------------------- clipboard

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

let toastTimer = null;
function toast(msg) {
  els.toast.hidden = false;
  els.toast.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 1800);
}

// ---------------------------------------------------------------- TTS

const speech = { queue: [], playing: false, current: null, mode: 'edge' };

function extractSpeakable(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' 代码我放黑板上了。 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  const parts = extractSpeakable(text).match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    while (p.length > 90) {
      const cut = p.lastIndexOf('，', 90);
      out.push(p.slice(0, cut > 20 ? cut + 1 : 90));
      p = p.slice(cut > 20 ? cut + 1 : 90);
    }
    if (p) out.push(p);
  }
  return out;
}

function speakLater(text) {
  if (!state.ttsOn || !text) return;
  const chunks = splitSentences(text).filter((s) => s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length > 1);
  if (!chunks.length) return;
  speech.queue.push(...chunks);
  if (!speech.playing) playNext();
}

const audioCache = new Map();

function audioUrlFor(text) {
  if (audioCache.has(text)) return audioCache.get(text);
  const p = fetch(`/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(state.voice)}`)
    .then(async (r) => {
      if (!r.ok) throw new Error('tts ' + r.status);
      return URL.createObjectURL(await r.blob());
    })
    .catch((e) => {
      audioCache.delete(text);
      throw e;
    });
  audioCache.set(text, p);
  if (audioCache.size > 24) audioCache.delete(audioCache.keys().next().value);
  return p;
}

async function playNext() {
  if (speech.playing) return;
  const text = speech.queue.shift();
  if (!text) { speech.playing = false; setSpeaking(false); return; }
  speech.playing = true;
  setSpeaking(true);

  if (speech.mode === 'browser') {
    await browserSpeak(text);
    speech.playing = false;
    playNext();
    return;
  }

  if (speech.queue[0]) audioUrlFor(speech.queue[0]); // 预取下一句，减少句间停顿

  let src;
  try {
    src = await audioUrlFor(text);
  } catch {
    speech.mode = 'browser';
    toast('云端音色连不上，改用系统语音');
    speech.queue.unshift(text);
    speech.playing = false;
    playNext();
    return;
  }

  const audio = new Audio(src);
  speech.current = audio;
  audio.onended = () => { speech.playing = false; playNext(); };
  audio.onerror = () => { speech.playing = false; playNext(); };
  try {
    await audio.play();
  } catch {
    // 浏览器还没收到用户手势，先记下来，第一次点击时再补播
    state.pendingSpeech = [text, ...speech.queue].join(' ');
    speech.queue.length = 0;
    speech.playing = false;
    setSpeaking(false);
  }
}

function flushPendingSpeech() {
  if (!state.pendingSpeech) return;
  const t = state.pendingSpeech;
  state.pendingSpeech = '';
  if (state.ttsOn) speakLater(t);
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.02;
    const voices = speechSynthesis.getVoices();
    const zh = voices.find((v) => /zh[-_]CN/i.test(v.lang)) || voices.find((v) => /^zh/i.test(v.lang));
    if (zh) u.voice = zh;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  speech.queue.length = 0;
  if (speech.current) { try { speech.current.pause(); } catch {} speech.current = null; }
  try { speechSynthesis.cancel(); } catch {}
  speech.playing = false;
  setSpeaking(false);
}

function setSpeaking(v) {
  state.speaking = v;
  document.body.classList.toggle('speaking', v);
  if (v) setStatus('正在说…', 'speaking');
  else if (!state.busy) setStatus('在线', '');
  els.voiceTitle.textContent = v ? '我在讲，你听着就行' : state.listening ? '我在听…' : '跟我说话就行';
}

// ---------------------------------------------------------------- STT


let micStream = null;
let micCtx = null;
let micAnalyser = null;
let vadTimer = null;
let segRec = null;
let segChunks = [];
let lastVoice = 0;
let micOn = false;
let segKind = '';

const MIME = () =>
  window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

// 常开麦克风：点一次开，点一次关；中间自动断句、自动发送
async function startRecord() {
  if (micOn) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('这个浏览器不支持录音，请用 Edge');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    return toast('麦克风打不开：' + (e.message || e.name));
  }
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = micCtx.createMediaStreamSource(micStream);
  micAnalyser = micCtx.createAnalyser();
  micAnalyser.fftSize = 1024;
  src.connect(micAnalyser);
  micOn = true;
  state.recording = true;
  lastVoice = 0;
  document.body.classList.add('listening');
  els.micBtn.classList.add('active');
  els.voiceTitle.textContent = '我在听，你说';
  setStatus('麦克风开着 · 再点一下关', 'busy');
  vadTimer = setInterval(vadTick, 100);
}

function stopRecord() {
  micOn = false;
  state.recording = false;
  clearInterval(vadTimer);
  vadTimer = null;
  if (segRec && segRec.state !== 'inactive') { try { segRec.onstop = null; segRec.stop(); } catch {} }
  segRec = null;
  segChunks = [];
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { micCtx && micCtx.close(); } catch {}
  micStream = null;
  micCtx = null;
  micAnalyser = null;
  document.body.classList.remove('listening');
  els.micBtn.classList.remove('active');
  els.voiceTitle.textContent = '跟我说话就行';
  setStatus('在线', '');
}

function vadTick() {
  if (!micAnalyser || !micOn) return;
  const buf = new Float32Array(micAnalyser.fftSize);
  micAnalyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  const now = Date.now();
  if (rms > 0.015) lastVoice = now;

  // 它自己在说话 / 思考时暂停录音，避免把音箱里的声音录进去
  if (state.busy || state.speaking) {
    if (segRec) stopSegment(false);
    return;
  }
  const voiced = now - lastVoice < 800;
  if (voiced && !segRec) startSegment();
  if (!voiced && segRec && now - lastVoice >= 800) stopSegment(true);
}

function startSegment() {
  if (!micStream) return;
  segChunks = [];
  segKind = MIME();
  segRec = new MediaRecorder(micStream, { mimeType: segKind });
  segRec.ondataavailable = (e) => { if (e.data.size) segChunks.push(e.data); };
  segRec.onstop = () => {
    const blob = new Blob(segChunks, { type: segKind });
    segRec = null;
    segChunks = [];
    if (blob.size > 1500) sendSegment(blob);
  };
  segRec.start();
}

function stopSegment(shouldSend) {
  if (!segRec) return;
  if (!shouldSend) {
    try { segRec.onstop = null; segRec.stop(); } catch {}
    segRec = null;
    segChunks = [];
    return;
  }
  try { segRec.stop(); } catch {}
}

async function sendSegment(blob) {
  setStatus('识别中…', 'busy');
  try {
    const r = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    if (d.text) send(d.text);
    else if (micOn) setStatus('麦克风开着 · 再点一下关', 'busy');
  } catch (e) {
    toast('识别失败：' + e.message);
    if (micOn) setStatus('麦克风开着 · 再点一下关', 'busy');
  }
}

function initSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    els.composerHint.textContent = '当前浏览器不支持语音识别 · 请用 Edge 浏览器打开，或直接打字';
    els.micBtn.title = '这个浏览器不支持语音识别';
    return;
  }
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    state.listening = true;
    document.body.classList.add('listening');
    els.micBtn.classList.add('active');
    setStatus('在听你说话', 'busy');
    els.voiceTitle.textContent = '我在听…';
    els.voiceSub.textContent = '说完停顿一下就好';
  };
  rec.onresult = (e) => {
    let interim = '';
    let finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    if (interim) els.input.value = interim;
    if (finalText) {
      els.input.value = finalText;
      autoGrow();
      setTimeout(() => {
        const t = finalText.trim();
        els.input.value = '';
        autoGrow();
        if (t) send(t);
      }, 220);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech') { toast('没听到你说话，再试一次'); return; }
    if (e.error === 'not-allowed') { toast('麦克风权限被拒绝了'); return; }
    toast('语音识别出错：' + e.error);
  };
  rec.onend = () => {
    state.listening = false;
    document.body.classList.remove('listening');
    els.micBtn.classList.remove('active');
    if (!state.busy) setStatus('在线', '');
    els.voiceTitle.textContent = '跟我说话就行';
    els.voiceSub.textContent = '点麦克风，或直接打字 · 我会一句一句讲';
  };
  state.recognition = rec;
}

function toggleMic() {
  if (state.sttLocal) {
    if (state.recording) return stopRecord();
    return startRecord();
  }
  const rec = state.recognition;
  if (!rec) return toast('这个浏览器不支持语音识别，用 Edge 试试');
  if (state.listening) { rec.stop(); return; }
  if (state.busy) return toast('等我说完这句');
  stopSpeaking();
  try { rec.start(); } catch { try { rec.stop(); } catch {} }
}

// ---------------------------------------------------------------- waveform

function initViz() {
  const canvas = $('viz');
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const W = 320, H = 320;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.scale(DPR, DPR);
  const cx = W / 2, cy = H / 2;
  let t = 0;
  let energy = 0.18;

  function frame() {
    t += 0.02;
    const target = document.body.classList.contains('speaking') ? 1 : document.body.classList.contains('listening') ? 0.75 : document.body.classList.contains('thinking') ? 0.4 : 0.16;
    energy += (target - energy) * 0.06;
    ctx.clearRect(0, 0, W, H);
    const bars = 88;
    const baseR = 66;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const n = Math.sin(t * 2.1 + i * 0.55) * 0.5 + Math.sin(t * 3.7 + i * 0.21) * 0.3 + Math.sin(t * 1.3 + i * 1.1) * 0.2;
      const len = 3 + Math.abs(n) * 26 * (0.4 + energy);
      const r1 = baseR + 8;
      const r2 = r1 + len;
      const hue = document.body.classList.contains('listening') ? 'rgba(94,234,212,' : document.body.classList.contains('speaking') ? 'rgba(255,180,92,' : 'rgba(140,170,200,';
      ctx.strokeStyle = hue + (0.10 + energy * 0.35) + ')';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }
    requestAnimationFrame(frame);
  }
  frame();
}

// ---------------------------------------------------------------- composer

function autoGrow() {
  const ta = els.input;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

function bind() {
  els.sendBtn.onclick = () => send(els.input.value);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(els.input.value);
    }
  });
  els.input.addEventListener('input', autoGrow);
  els.micBtn.onclick = toggleMic;
  els.orbBtn.onclick = toggleMic;

  els.voiceToggle.onclick = () => {
    state.ttsOn = !state.ttsOn;
    els.voiceToggle.dataset.on = state.ttsOn ? '1' : '0';
    els.voiceToggle.textContent = state.ttsOn ? '朗读：开' : '朗读：关';
    if (!state.ttsOn) stopSpeaking();
  };

  els.modelSelect.onchange = async () => {
    state.model = els.modelSelect.value;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: state.model }),
    });
    toast('换成 ' + state.model);
  };

  els.voiceSelect.onchange = async () => {
    state.voice = els.voiceSelect.value;
    speech.mode = 'edge';
    Object.keys(audioCache).length;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: state.voice }),
    });
  };

  $('newChatBtn').onclick = async () => {
    stopSpeaking();
    const r = await fetch('/api/session/new', { method: 'POST' });
    const s = await r.json();
    state.sessionId = s.id;
    state.board = null;
    els.messages.innerHTML = '';
    $('tab-board').innerHTML = `<div class="empty-board"><div class="empty-icon">⌁</div><p>黑板是空的</p><span>当小D讲解、示范代码时，会写在这里。</span></div>`;
    $('tab-plan').innerHTML = `<div class="empty-board"><div class="empty-icon">☰</div><p>还没有计划</p><span>复杂一点的任务，小D会先列步骤。</span></div>`;
    $('boardBadge').textContent = '等待上课';
    els.voiceSub.textContent = '点麦克风，或直接打字 · 我会一句一句讲';
    greet();
  };

  $('pickRootBtn').onclick = async () => {
    const p = prompt('输入教学项目目录（AI 只能在这个目录里动手）：', state.config?.projectRoot || '');
    if (p) setProjectRoot(p);
  };

  $('screenBtn').onclick = () => send('看看我现在的屏幕，告诉我你看到了什么，然后我们接着来。');
  $('boardPopBtn').onclick = toggleBoardWindow;

  document.querySelectorAll('.board-tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  els.messages.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mini-btn[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const rec = codeStore.get(id);
    if (!rec) return;
    if (btn.dataset.act === 'copy') copyText(rec.code);
    if (btn.dataset.act === 'board') setBoard({ kind: 'code', title: '来自对话的代码', language: rec.lang, content: rec.code });
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); toggleMic(); }
    if (e.key === 'Escape') stopSpeaking();
  });

  window.addEventListener('pointerdown', flushPendingSpeech, { once: true });
  window.addEventListener('keydown', flushPendingSpeech, { once: true });
}

function createGreeting() {
  const d = document.createElement('div');
  d.className = 'msg ai';
  d.innerHTML = `<div class="avatar">D</div><div class="content"></div>`;
  return d;
}
// ---------------------------------------------------------------- go

initViz();
bind();
initSTT();
boot();
setInterval(async () => {
  try {
    const r = await fetch('/api/account');
    if (r.ok) renderAccount(await r.json());
  } catch {}
}, 120000);
