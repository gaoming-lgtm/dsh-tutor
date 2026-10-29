// 独立黑板窗口：拉当前黑板 + 订阅更新
const root = document.getElementById('root');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KEYWORDS = {
  python: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|yield|lambda|None|True|False|pass|break|continue|global|nonlocal|assert|del|is|async|await)\b/g,
  javascript: /\b(const|let|var|function|return|if|else|for|while|of|in|new|class|extends|import|from|export|default|try|catch|finally|throw|async|await|this|null|undefined|true|false|typeof|instanceof|switch|case|break|continue|do)\b/g,
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
    if ((ch === '#' && ['python', 'bash', 'yaml', 'text'].includes(lg)) || (ch === '/' && code[i + 1] === '/') || (ch === '/' && code[i + 1] === '*')) {
      let j = i;
      if (ch === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); j = e < 0 ? code.length : e + 2; }
      else { const e = code.indexOf('\n', i); j = e < 0 ? code.length : e; }
      push('c', code.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) { if (code[j] === '\\') j++; j++; }
      j = Math.min(j + 1, code.length);
      push('s', code.slice(i, j));
      i = j;
      continue;
    }
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

function render(d) {
  if (!d) {
    root.innerHTML = `<div class="empty-board"><div class="empty-icon">⌁</div><p>黑板是空的</p><span>小D 讲解时会写在这里。</span></div>`;
    return;
  }
  const lang = d.language || 'text';
  const content = d.content || '';
  root.innerHTML = `
    <div class="board-card">
      <div class="bc-head">
        <span class="bc-lang">${esc(lang)}</span>
        <span class="bc-title">${esc(d.title || d.path || '黑板')}</span>
      </div>
      ${d.note ? `<div class="bc-note">${esc(d.note)}</div>` : ''}
      ${(d.points || []).length ? `<ul class="bc-points">${d.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      <pre><code>${highlight(content, lang)}</code></pre>
    </div>`;
  document.title = '小D · 黑板';
}

async function load() {
  try {
    const r = await fetch('/api/board');
    const d = await r.json();
    render(d.board);
  } catch {}
}

load();

try {
  const es = new EventSource('/api/events');
  es.addEventListener('board', (e) => {
    try { render(JSON.parse(e.data)); } catch {}
  });
} catch {}

document.getElementById('closeBtn').onclick = () => window.close();
