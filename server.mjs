import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { TOOLS, TOOL_MAP } from './lib/tools.mjs';
import { VOICES } from './lib/voices.mjs';
import { createAllowlist, suggestRule } from './lib/allowlist.mjs';
import { ideContext, openerFor, isInside } from './lib/ide.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(HERE, 'public');
const DATA_DIR = path.join(HERE, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const SCREEN_DIR = path.join(DATA_DIR, 'screen');
const PROMPT_FILE = path.join(HERE, 'prompts', 'teacher.md');

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(SCREEN_DIR, { recursive: true });

const allow = createAllowlist(path.join(DATA_DIR, 'allowlist.json'));

// ---------------------------------------------------------------- config

const configPath = path.join(HERE, 'config.json');
let cfg = {};
// 注意：记事本等编辑器可能写入带 BOM 的 UTF-8，JSON.parse 会直接失败，这里先去掉 BOM。
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); } catch {}

const DIST = !!cfg.dist;
const DEFAULT_ROOT = DIST
  ? path.join(process.env.USERPROFILE || os.homedir(), 'Documents', '小D课堂')
  : WORKSPACE;

const state = {
  port: Number(cfg.port) || 7842,
  token: crypto.randomUUID().replace(/-/g, ''),
  model: cfg.model || 'deepseek-v4-pro',
  voice: cfg.voice || 'zh-CN-XiaoxiaoNeural',
  rate: cfg.rate || '+0%',
  projectRoot: cfg.projectRoot || DEFAULT_ROOT,
  apiKey: '',
  apiBase: cfg.apiBase || 'https://api.deepseek.com',
  ttsMode: cfg.tts || 'auto',
  ttsAvailable: false,
};

const MODELS = [
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', desc: '更强，讲复杂概念' },
  { id: 'deepseek-flash', name: 'deepseek-flash', desc: '更快，日常陪练' },
];

function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  if (cfg.apiKey) return String(cfg.apiKey).trim();
  return '';
}
state.apiKey = loadApiKey();

const TEACHER_PROMPT = fs.readFileSync(PROMPT_FILE, 'utf8');

// ---------------------------------------------------------------- sessions

const sessions = new Map();

function newSession() {
  const id = crypto.randomUUID();
  const s = {
    id,
    title: '新的一课',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    plan: [],
    board: null,
    autoAllow: new Set(),
  };
  sessions.set(id, s);
  return s;
}

function publicSession(s) {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: s.messages,
    plan: s.plan,
    board: s.board,
  };
}

async function saveSession(s) {
  try {
    const data = { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages, plan: s.plan, board: s.board };
    await fsp.writeFile(path.join(SESSION_DIR, `${s.id}.json`), JSON.stringify(data, null, 1), 'utf8');
  } catch (e) { console.error('[session save]', e.message); }
}

async function loadSessionsFromDisk() {
  const entries = await fsp.readdir(SESSION_DIR).catch(() => []);
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await fsp.readFile(path.join(SESSION_DIR, f), 'utf8'));
      if (!d.id) continue;
      sessions.set(d.id, { ...d, autoAllow: new Set() });
    } catch {}
  }
}

// ---------------------------------------------------------------- helpers

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("录音太大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n');
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
}

const boardSubs = new Set();
function broadcastBoard(d) {
  const payload = `event: board\ndata: ${JSON.stringify(d || {})}\n\n`;
  for (const res of boardSubs) {
    try { res.write(payload); } catch { boardSubs.delete(res); }
  }
}

function resolveInRoot(p) {
  const root = path.resolve(state.projectRoot);
  const abs = path.resolve(root, p || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('这条路径超出了教学项目目录，不能操作。');
  return abs;
}

function trimMessages(messages, keep = 36) {
  let out = messages.slice(-keep);
  let guard = 0;
  while (out.length && guard++ < 10) {
    const first = out[0];
    if (first.role === 'tool' || (first.role === 'assistant' && first.tool_calls)) out = out.slice(1);
    else break;
  }
  return out;
}

function safeParseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { __parse_error: String(raw).slice(0, 300) }; }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', '.piptmp', 'vendor']);

async function tree(dir, depth, out, max = 400) {
  if (depth < 0 || out.length >= max) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(state.projectRoot, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push({ type: 'dir', path: rel });
      await tree(full, depth - 1, out, max);
    } else {
      out.push({ type: 'file', path: rel, size: (await fsp.stat(full).catch(() => ({ size: 0 }))).size });
    }
  }
}

// ---------------------------------------------------------------- model

function systemPrompt(session) {
  const plan = session.plan?.length
    ? session.plan.map((p) => `- [${p.status === 'done' ? 'x' : ' '}] ${p.title}`).join('\n')
    : '（还没有列计划）';
  return `${TEACHER_PROMPT}

---

# 本次课堂环境

- 操作系统：Windows（PowerShell 环境）
- 教学项目目录：\`${state.projectRoot}\`（你所有文件操作都必须在这里面）
- 今天：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
- 学生看到的界面：左侧是对话，右侧是黑板（你 \`show_board\` 的内容、代码、计划都会显示在那里）。
- 底部有麦克风，学生可能是**用嘴说**的，语音识别可能有错字，遇到明显错别字按发音猜测原意。

## 当前计划板
${plan}

## 提醒
- 你的回答会被逐句朗读。写短句，不要堆格式。
- 一次只推进一小步，结尾必须留一个问题或一个明确动作。
- 不要一次给完整答案。`;
}

async function streamCompletion(session, send, signal) {
  const body = {
    model: state.model,
    messages: [{ role: 'system', content: systemPrompt(session) }, ...trimMessages(session.messages)],
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0.6,
    max_tokens: 1600,
    stream: true,
    stream_options: { include_usage: true },
  };

  const r = await fetch(`${state.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`模型接口 ${r.status}：${t.slice(0, 300)}`);
  }

  let content = '';
  let thinking = false;
  const toolCalls = [];
  let usage = null;
  let finish = null;

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.usage) usage = evt.usage;
      const choice = evt.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (d.reasoning_content && !thinking) { thinking = true; send('thinking', { on: true }); }
      if (d.content) {
        content += d.content;
        send('delta', { text: d.content });
      }
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  if (thinking) send('thinking', { on: false });
  return { content, toolCalls: toolCalls.filter(Boolean), usage, finish };
}

// ---------------------------------------------------------------- approvals

const pending = new Map();

function askApproval(session, send, payload) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve('deny');
    }, 240000);
    pending.set(id, {
      sessionId: session.id,
      resolve: (decision) => { clearTimeout(timer); pending.delete(id); resolve(decision); },
    });
    send('approval', { id, ...payload });
  });
}

// ---------------------------------------------------------------- tools

const runPs = (script, args = [], timeout = 60000) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'lib', script), ...args],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !String(stdout || '').trim()) return reject(new Error(String(stderr || err.message).slice(0, 400)));
        resolve(String(stdout || ''));
      }
    );
  });

function tidyOcr(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const execAsync = (command, cwd, timeout) =>
  new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
      ],
      { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        if (err && err.killed) return resolve({ ok: false, out: `命令超时（${timeout / 1000}s）被终止。\n${out}`.trim() });
        resolve({ ok: !err, out: out || (err ? String(err.message) : '(无输出)') });
      }
    );
  });

async function executeTool(session, send, name, args) {
  if (args.__parse_error) return `工具参数不是合法 JSON：${args.__parse_error}`;
  switch (name) {
    case 'list_dir': {
      const abs = resolveInRoot(args.path || '.');
      const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 3);
      const out = [];
      await tree(abs, depth, out);
      const base = path.relative(state.projectRoot, abs).replace(/\\/g, '/') || '.';
      const lines = out.slice(0, 200).map((e) => (e.type === 'dir' ? `[目录] ${e.path}` : `${e.path}  (${Math.max(1, Math.round(e.size / 1024))} KB)`));
      return `目录 ${base} 下共 ${out.length} 项：\n${lines.join('\n') || '(空)'}`;
    }
    case 'read_file': {
      const abs = resolveInRoot(args.path);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) return `文件 ${args.path} 不存在。要不要先用 list_dir 看看目录里有什么？`;
      if (st.size > 600 * 1024) return `文件 ${args.path} 有 ${Math.round(st.size / 1024)} KB，太大了。告诉学生你想看哪一段，或者换个文件。`;
      if (/\.(png|jpe?g|gif|webp|ico|mp[34]|wav|zip|7z|rar|exe|dll|pdf|woff2?|ttf|otf|db|sqlite)$/i.test(args.path)) {
        return `这是二进制文件（${args.path}），读不出文字内容。`;
      }
      const raw = await fsp.readFile(abs, 'utf8');
      const lines = raw.split(/\r?\n/);
      const start = Math.max(1, Number(args.start_line) || 1);
      const end = Math.min(lines.length, Number(args.end_line) || start + 399);
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((l, i) => `${String(start + i).padStart(4, ' ')}| ${l}`).join('\n');
      const text = numbered.length > 24000 ? numbered.slice(0, 24000) + '\n…（已截断）' : numbered;
      session.board = { kind: 'file', path: args.path, content: raw, language: langOf(args.path), startLine: start };
      send('board', session.board);
      broadcastBoard(session.board);
      return `文件 ${args.path}（共 ${lines.length} 行，显示第 ${start}-${end} 行）：\n${text}`;
    }
    case 'write_file': {
      const abs = resolveInRoot(args.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const body = String(args.content ?? '');
      await fsp.writeFile(abs, body, 'utf8');
      session.board = { kind: 'file', path: args.path, content: body, language: langOf(args.path), fresh: true };
      send('board', session.board);
      broadcastBoard(session.board);
      const note = args.reveal === false ? '' : await revealInIde(abs, 1);
      return `已写入 ${args.path}（${body.split(/\r?\n/).length} 行）。${note}`;
    }
    case 'replace_in_file': {
      const abs = resolveInRoot(args.path);
      const raw = await fsp.readFile(abs, 'utf8');
      const oldS = String(args.old_string ?? '');
      const newS = String(args.new_string ?? '');
      const count = raw.split(oldS).length - 1;
      if (!oldS) return 'old_string 为空，未修改。';
      if (count === 0) return `在 ${args.path} 里没找到这段原文，未修改。请先用 read_file 确认当前内容。`;
      if (count > 1) return `这段原文在 ${args.path} 里出现了 ${count} 次，不确定改哪一处，未修改。请给出更长的唯一片段。`;
      const at = raw.indexOf(oldS);
      const line = raw.slice(0, at).split('\n').length;
      const next = raw.replace(oldS, newS);
      await fsp.writeFile(abs, next, 'utf8');
      session.board = { kind: 'file', path: args.path, content: next, language: langOf(args.path), fresh: true };
      send('board', session.board);
      broadcastBoard(session.board);
      const note = args.reveal === false ? '' : await revealInIde(abs, line);
      return `已修改 ${args.path}（第 ${line} 行起）。${note}`;
    }
    case 'run_command': {
      const cwd = resolveInRoot(args.cwd || '.');
      const timeout = Math.min(Math.max(Number(args.timeout_sec) || 60, 5), 180) * 1000;
      const r = await execAsync(String(args.command), cwd, timeout);
      const out = r.out.length > 12000 ? r.out.slice(-12000) : r.out;
      return `${r.ok ? '执行完成' : '执行失败'}：\n${out}`;
    }
    case 'show_board': {
      session.board = { kind: 'code', title: args.title || '黑板', language: args.language || 'text', content: String(args.code ?? ''), note: args.note || '', points: (args.points || []).map((p) => String(p).slice(0, 120)).slice(0, 5) };
      send('board', session.board);
      broadcastBoard(session.board);
      return `已把「${args.title || '代码'}」放到黑板上。`;
    }
    case 'set_plan': {
      const steps = (args.steps || []).slice(0, 5).map((s) => ({ title: String(s.title || '').slice(0, 60), status: ['todo', 'in_progress', 'done'].includes(s.status) ? s.status : 'todo' }));
      session.plan = steps;
      send('plan', { steps });
      return `计划已更新（${steps.length} 步）。`;
    }
    case 'open_in_editor': {
      const abs = resolveInRoot(args.path);
      const line = Number(args.line) || 1;
      const launch = openerFor(abs);
      if (launch) {
        const a = launch.kind === 'pycharm' ? [abs, '--line', String(line)] : ['--goto', `${abs}:${line}`];
        execFile(launch.cmd, a, { windowsHide: false, detached: true });
      } else {
        execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${abs.replace(/'/g, "''")}'`], { windowsHide: true });
      }
      return `已在编辑器打开 ${args.path}（第 ${line} 行）。`;
    }
    case 'ide_context': {
      const ctx = await ideContext();
      const lines = [
        `PyCharm 安装位置：${ctx.pycharm || '没找到'}`,
        `PyCharm 是否在运行：${ctx.pycharmRunning.length ? ctx.pycharmRunning.map((p) => `#${p.Id} ${p.MainWindowTitle || ''}`).join(' / ') : '没在运行'}`,
        `最近打开的项目：${ctx.lastProject || '无'}`,
        `最近项目：${ctx.projects.map((p) => p.path).join(' / ') || '无'}`,
        ctx.currentFile ? `当前正在编辑的文件：${ctx.currentFile}` : '',
        `本次教学目录：${state.projectRoot}`,
        `（写文件后会自动在 PyCharm 里打开并定位，PyCharm 会自动重载磁盘上的改动。）`,
      ].filter(Boolean);
      return lines.join('\n');
    }
    case 'look_at_screen': {
      const shot = path.join(SCREEN_DIR, 'latest.png');
      let info = {};
      try {
        const rawInfo = await runPs('screen.ps1', ['-Out', shot]);
        const line = rawInfo.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
        info = JSON.parse(line);
      } catch (e) {
        return `截屏失败：${e.message}`;
      }
      const tmp = path.join(os.tmpdir(), `dsh-screen-${Date.now()}.png`);
      await fsp.copyFile(shot, tmp);
      let text = '';
      try {
        text = tidyOcr(await runPs('ocr.ps1', ['-Path', tmp], 90000));
      } catch (e) {
        text = `（文字识别失败：${e.message}）`;
      } finally {
        fsp.unlink(tmp).catch(() => {});
      }
      send('screenshot', { url: `/api/screen/latest.png?v=${Date.now()}`, width: info.width, height: info.height, title: info.title || '' });
      return `前台窗口：${info.title || '未知'}\n屏幕尺寸：${info.width}x${info.height}\n屏幕上的文字（OCR 结果，可能有错字和多余空格，按上下文理解，不要原样朗读）：\n${text.slice(0, 6000) || '（没识别到文字）'}`;
    }
    default:
      return `未知工具 ${name}。`;
  }
}

function langOf(p) {
  const ext = path.extname(p).toLowerCase();
  return { '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.ts': 'typescript', '.tsx': 'tsx', '.jsx': 'jsx', '.html': 'html', '.css': 'css', '.json': 'json', '.md': 'markdown', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.go': 'go', '.rs': 'rust', '.sh': 'bash', '.sql': 'sql', '.yml': 'yaml', '.yaml': 'yaml' }[ext] || 'text';
}

async function revealInIde(abs, line) {
  try {
    const ctx = await ideContext();
    if (!ctx.running.length) return '';
    const target = openerFor(abs);
    if (!target) return '';
    const a = target.kind === 'pycharm' ? ['--line', String(line), abs] : ['--goto', `${abs}:${line}`];
    execFile(target.cmd, a, { windowsHide: false, detached: true });
    return ` 已在 ${target.kind === 'pycharm' ? 'PyCharm' : 'VS Code'} 里定位到第 ${line} 行。`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- agent loop

async function runAgent(session, send, signal) {
  const maxSteps = 8;
  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return;
    const { content, toolCalls, usage, finish } = await streamCompletion(session, send, signal);
    if (usage) send('usage', { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens, cached: usage.prompt_cache_hit_tokens || 0 });

    if (toolCalls.length) {
      const assistantMsg = {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
      };
      session.messages.push(assistantMsg);
      if (content) send('segment_end', {});

      for (const tc of toolCalls) {
        const name = tc.function.name;
        const args = safeParseArgs(tc.function.arguments);
        const meta = TOOL_MAP.get(name)?.meta || { risk: 'high', label: name };

        let absPath = '';
        if (args.path) {
          try { absPath = resolveInRoot(args.path); } catch {}
        }
        const command = name === 'run_command' ? String(args.command || '') : '';
        const rule = suggestRule(name, { absPath, command });
        const auto = allow.autoAllowed(name, absPath, command);
        let allowed = meta.risk === 'low' || session.autoAllow.has(name) || auto;

        if (!allowed) {
          const decision = await askApproval(session, send, { name, args, risk: meta.risk, label: meta.label, rule });
          if (decision === 'deny') {
            session.messages.push({ role: 'tool', tool_call_id: tc.id, content: '学生拒绝了这次操作。不要重试同一个操作，问他愿不愿意换一种方式，或改用讲解。' });
            send('tool_result', { id: tc.id, name, ok: false, output: '学生拒绝了这次操作', denied: true });
            continue;
          }
          if (decision === 'turn') session.autoAllow.add(name);
          if (decision === 'always') allow.add(rule);
          allowed = true;
        }

        send('tool_start', { id: tc.id, name, label: meta.label });
        let output;
        let ok = true;
        try {
          output = await executeTool(session, send, name, args);
        } catch (e) {
          ok = false;
          output = `工具执行失败：${e.message}`;
        }
        session.messages.push({ role: 'tool', tool_call_id: tc.id, content: output });
        send('tool_result', { id: tc.id, name, ok, output: output.slice(0, 900) });
      }
      continue;
    }

    session.messages.push({ role: 'assistant', content: content || '' });
    if (session.title === '新的一课' && session.messages.find((m) => m.role === 'user')) {
      const firstUser = session.messages.find((m) => m.role === 'user')?.content || '';
      session.title = String(firstUser).replace(/\s+/g, ' ').slice(0, 24) || '新的一课';
    }
    return;
  }
  send('error', { message: '这一轮动作太多了，我停一下。我们接着来？' });
}

// ---------------------------------------------------------------- tts worker

const TTS_DIR = path.join(DATA_DIR, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });

let ttsProc = null;
const ttsPending = new Map();

// 语音合成用的 Python：优先 setup.ps1 装好的嵌入式解释器，其次系统 python / $PYTHON
const EMBED_PY = path.join(HERE, 'stt', 'py311', 'python.exe');
function pyBin() {
  return fs.existsSync(EMBED_PY) ? EMBED_PY : (process.env.PYTHON || 'python');
}

function startTts() {
  if (ttsProc) return;
  const env = {
    ...process.env,
    PYTHONPATH: path.join(HERE, 'vendor'),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  try {
    ttsProc = spawn(pyBin(), ['-u', path.join(HERE, 'tts_worker.py'), TTS_DIR], {
      cwd: HERE,
      env,
      windowsHide: true,
    });
  } catch (e) {
    // 起不来就当没有云端音色，前端会自动退回浏览器语音，不能把服务拖死
    console.error('[tts] 启动失败：', e.message);
    ttsProc = null;
    state.ttsAvailable = false;
    return;
  }
  let buf = '';
  ttsProc.stdout.setEncoding('utf8');
  ttsProc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = ttsPending.get(msg.id);
      if (!p) continue;
      ttsPending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.path);
    }
  });
  ttsProc.stderr.on('data', (d) => console.error('[tts]', String(d).slice(0, 500)));
  ttsProc.on('exit', () => {
    ttsProc = null;
    for (const [, p] of ttsPending) { clearTimeout(p.timer); p.reject(new Error('tts worker 退出了')); }
    ttsPending.clear();
  });
}

function checkTts() {
  if (state.ttsMode === 'browser') return false;
  try {
    const probe = `import sys,os;sys.path.insert(0,os.path.join(r'${HERE}','vendor'));import edge_tts`;
    execFileSync(pyBin(), ['-c', probe], {
      cwd: HERE,
      env: { ...process.env, PYTHONPATH: path.join(HERE, 'vendor'), PYTHONUTF8: '1' },
      timeout: 20000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function synthToFile(text, voice, rate) {
  startTts();
  if (!ttsProc) return Promise.reject(new Error('语音进程没起来'));
  const id = crypto.randomUUID().replace(/-/g, '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ttsPending.delete(id); reject(new Error('语音合成超时')); }, 30000);
    ttsPending.set(id, { resolve, reject, timer });
    ttsProc.stdin.write(JSON.stringify({ id, text, voice, rate }) + '\n', 'utf8');
  });
}

async function cleanTtsDir() {
  const files = await fsp.readdir(TTS_DIR).catch(() => []);
  const now = Date.now();
  for (const f of files) {
    const p = path.join(TTS_DIR, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > 3600_000) await fsp.unlink(p).catch(() => {});
  }
}

// ---------------------------------------------------------------- local STT (faster-whisper)

const STT_DIR = path.join(HERE, 'stt');
const STT_PY = path.join(STT_DIR, 'py311', 'python.exe');
const STT_SCRIPT = path.join(STT_DIR, 'stt_worker.py');
const STT_TMP = path.join(DATA_DIR, 'stt');
let sttProc = null;
const sttPending = new Map();

function sttAvailable() {
  return fs.existsSync(STT_PY) && fs.existsSync(STT_SCRIPT);
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(base)) {
      if (!/^Gyan\.FFmpeg/i.test(d)) continue;
      const root = path.join(base, d);
      const stack = [[root, 0]];
      while (stack.length) {
        const [dir, depth] = stack.pop();
        if (depth > 4) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name === 'ffmpeg.exe') return full;
          if (e.isDirectory()) stack.push([full, depth + 1]);
        }
      }
    }
  } catch {}
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();

function startStt() {
  if (sttProc || !sttAvailable()) return;
  fs.mkdirSync(STT_TMP, { recursive: true });
  fs.mkdirSync(path.join(STT_DIR, 'models'), { recursive: true });
  try {
    sttProc = spawn(STT_PY, ['-u', STT_SCRIPT], {
      cwd: HERE,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        HF_HOME: path.join(STT_DIR, 'models', 'hf'),
        HF_HUB_CACHE: path.join(STT_DIR, 'models', 'hf', 'hub'),
      },
      windowsHide: true,
    });
  } catch (e) {
    console.error('[stt] 启动失败：', e.message);
    sttProc = null;
    return;
  }
  let buf = '';
  sttProc.stdout.setEncoding('utf8');
  sttProc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = sttPending.get(msg.id);
      if (!p) continue;
      sttPending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.text || '');
    }
  });
  sttProc.stderr.on('data', (d) => console.error('[stt]', String(d).slice(0, 300)));
  sttProc.on('exit', () => {
    sttProc = null;
    for (const [, p] of sttPending) { clearTimeout(p.timer); p.reject(new Error('识别引擎退出了')); }
    sttPending.clear();
  });
}

function transcribe(wavPath) {
  startStt();
  if (!sttProc) return Promise.reject(new Error('本地识别引擎不可用'));
  const id = crypto.randomUUID().replace(/-/g, '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sttPending.delete(id); reject(new Error('识别超时（首次加载模型较慢）')); }, 180000);
    sttPending.set(id, { resolve, reject, timer });
    sttProc.stdin.write(JSON.stringify({ id, path: wavPath, language: 'zh' }) + '\n', 'utf8');
  });
}

function toWav(input, output) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { timeout: 60000, windowsHide: true }, (err) => {
      err ? reject(new Error('音频转码失败：' + err.message)) : resolve();
    });
  });
}

let accountCache = { at: 0, data: null };
async function getAccount() {
  if (Date.now() - accountCache.at < 60000 && accountCache.data) return accountCache.data;
  let balance = null;
  let currency = 'CNY';
  try {
    const r = await fetch(`${state.apiBase}/user/balance`, { headers: { authorization: `Bearer ${state.apiKey}` } });
    if (r.ok) {
      const d = await r.json();
      const info = d.balance_infos?.[0];
      balance = info ? Number(info.total_balance) : null;
      currency = info?.currency || 'CNY';
    }
  } catch {}
  const data = {
    balance,
    currency,
    model: state.model,
    keyMasked: state.apiKey ? `${state.apiKey.slice(0, 6)}…${state.apiKey.slice(-4)}` : '未配置',
    connected: !!state.apiKey,
  };
  accountCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

function authed(req) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `dsh_teacher=${state.token}`);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fsp.readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${state.port}`);
  const pathname = url.pathname;

  try {
    // ---- login
    if (url.searchParams.get('t')) {
      if (url.searchParams.get('t') !== state.token) return json(res, 403, { error: '链接无效，请用启动时打印的地址。' });
      const keep = new URLSearchParams(url.search);
      keep.delete('t');
      const qs = keep.toString();
      res.writeHead(302, { 'set-cookie': `dsh_teacher=${state.token}; Path=/; HttpOnly; SameSite=Strict`, location: url.pathname + (qs ? `?${qs}` : '') });
      return res.end();
    }

    if (pathname === '/api/ping') return json(res, 200, { ok: true });

    if (!authed(req)) {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<meta charset="utf-8"><body style="background:#0b0f14;color:#cfe3ff;font:15px system-ui;padding:48px">请用终端里打印的带 token 的链接打开。<br><br>例如：http://127.0.0.1:7842/?t=……</body>');
      }
      return json(res, 401, { error: 'unauthorized' });
    }

    if (pathname === '/api/bootstrap') {
      const all = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      const list = all.slice(0, 30).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
      const latest = all.find((s) => s.messages.some((m) => m.role === 'user'));
      return json(res, 200, {
        config: { model: state.model, voice: state.voice, rate: state.rate, projectRoot: state.projectRoot, models: MODELS, voices: VOICES, ttsAvailable: state.ttsAvailable, sttAvailable: sttAvailable() },
        sessions: list,
        current: latest ? publicSession(latest) : null,
        allowlist: allow.data,
        ide: await ideContext().catch(() => null),
        account: await getAccount(),
      });
    }

    if (pathname === '/api/allowlist') {
      if (req.method === 'GET') return json(res, 200, allow.data);
      const b = await readBody(req);
      if (b.op === 'clear') allow.clear();
      else if (b.op === 'remove' && b.type) allow.remove(b.type, b.value);
      else if (b.op === 'add' && b.type) allow.add({ type: b.type, value: b.value });
      return json(res, 200, allow.data);
    }

    if (pathname === '/api/screen/latest.png') {
      const f = path.join(SCREEN_DIR, 'latest.png');
      try {
        const st = await fsp.stat(f);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': st.size, 'cache-control': 'no-store' });
        fs.createReadStream(f).pipe(res);
      } catch {
        json(res, 404, { error: 'no screenshot yet' });
      }
      return;
    }

    if (pathname === '/api/account') return json(res, 200, await getAccount());

    if (pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.model && MODELS.some((m) => m.id === b.model)) state.model = b.model;
      if (b.voice && VOICES.some((v) => v.id === b.voice)) state.voice = b.voice;
      if (b.rate) state.rate = String(b.rate);
      if (b.projectRoot) {
        const abs = path.resolve(String(b.projectRoot));
        const st = await fsp.stat(abs).catch(() => null);
        if (!st?.isDirectory()) return json(res, 400, { error: '这个目录不存在' });
        state.projectRoot = abs;
      }
      fs.writeFileSync(configPath, JSON.stringify({ model: state.model, voice: state.voice, rate: state.rate, projectRoot: state.projectRoot, port: state.port }, null, 2));
      return json(res, 200, { ok: true, config: { model: state.model, voice: state.voice, rate: state.rate, projectRoot: state.projectRoot } });
    }

    if (pathname === '/api/session/new' && req.method === 'POST') {
      const s = newSession();
      return json(res, 200, publicSession(s));
    }

    if (pathname.startsWith('/api/session/') && req.method === 'GET') {
      const id = pathname.split('/').pop();
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'not found' });
      return json(res, 200, publicSession(s));
    }

    if (pathname === '/api/tree') {
      const out = [];
      await tree(state.projectRoot, 2, out);
      out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
      return json(res, 200, { root: state.projectRoot, entries: out.slice(0, 300) });
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      const p = url.searchParams.get('path') || '';
      const abs = resolveInRoot(p);
      const st = await fsp.stat(abs);
      if (st.size > 600 * 1024) return json(res, 400, { error: '文件太大（>600KB），先别在网页里打开' });
      const content = await fsp.readFile(abs, 'utf8');
      return json(res, 200, { path: p, content, language: langOf(p) });
    }

    if (pathname === '/api/file' && req.method === 'POST') {
      const b = await readBody(req);
      const abs = resolveInRoot(b.path);
      await fsp.writeFile(abs, String(b.content ?? ''), 'utf8');
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/approve' && req.method === 'POST') {
      const b = await readBody(req);
      const p = pending.get(b.id);
      if (!p) return json(res, 404, { error: '这个请求已经过期了' });
      if (!['allow', 'turn', 'deny', 'always'].includes(b.decision)) return json(res, 400, { error: 'bad decision' });
      p.resolve(b.decision);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/tts') {
      const text = (url.searchParams.get('text') || '').slice(0, 800).trim();
      const voice = VOICES.some((v) => v.id === url.searchParams.get('voice')) ? url.searchParams.get('voice') : state.voice;
      if (!text) return json(res, 400, { error: 'empty text' });
      if (!state.ttsAvailable) return json(res, 503, { error: 'tts unavailable' });
      let file;
      try {
        file = await synthToFile(cleanForSpeech(text), voice, state.rate);
        const st = await fsp.stat(file);
        const type = file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
        res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store' });
        const stream = fs.createReadStream(file);
        stream.pipe(res);
        stream.on('error', () => res.end());
        res.on('close', () => fsp.unlink(file).catch(() => {}));
      } catch (e) {
        json(res, 502, { error: e.message });
      }
      return;
    }

    if (pathname === '/api/board') {
      const latest = [...sessions.values()]
        .filter((x) => x.board)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return json(res, 200, { board: latest?.board || null, title: latest?.title || '' });
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      boardSubs.add(res);
      const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(ping); boardSubs.delete(res); });
      return;
    }

    if (pathname === '/api/widget' && req.method === 'POST') {
      const script = path.join(HERE, 'board-widget.ps1');
      if (!fs.existsSync(script)) return json(res, 404, { error: '缺少 board-widget.ps1' });
      const widgetUrl = `http://127.0.0.1:${state.port}/board.html?t=${state.token}`;
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Url', widgetUrl], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/stt' && req.method === 'POST') {
      if (!sttAvailable()) return json(res, 503, { error: 'stt unavailable' });
      let buf;
      try { buf = await readRaw(req); } catch (e) { return json(res, 400, { error: e.message }); }
      if (buf.length < 800) return json(res, 400, { error: '录音太短' });
      const id = crypto.randomUUID().replace(/-/g, '');
      const src = path.join(STT_TMP, id + '.webm');
      const wav = path.join(STT_TMP, id + '.wav');
      try {
        await fsp.mkdir(STT_TMP, { recursive: true });
        await fsp.writeFile(src, buf);
        await toWav(src, wav);
        const text = await transcribe(wav);
        return json(res, 200, { text });
      } catch (e) {
        return json(res, 500, { error: e.message });
      } finally {
        fsp.unlink(src).catch(() => {});
        fsp.unlink(wav).catch(() => {});
      }
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty' });
      let s = b.sessionId ? sessions.get(b.sessionId) : null;
      if (!s) s = newSession();
      s.autoAllow = new Set();
      s.updatedAt = Date.now();
      s.messages.push({ role: 'user', content: text });

      const send = sse(res);
      send('session', { id: s.id, title: s.title });
      send('echo', { text });

      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.on('close', onClose);

      try {
        await runAgent(s, send, ac.signal);
      } catch (e) {
        if (!ac.signal.aborted) send('error', { message: e.message });
      } finally {
        res.off('close', onClose);
        s.updatedAt = Date.now();
        await saveSession(s);
        send('done', { sessionId: s.id, title: s.title });
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

function cleanForSpeech(t) {
  return t
    .replace(/```[\s\S]*?```/g, ' 代码我放黑板上了 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_#>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// 端口被占就往后顺延。注意：只能用 once('listening') 加显式解绑，
// 不能用 listen(port, host, cb)——失败的那次尝试注册的 cb 不会撤销，
// 下一次绑定成功时它也会被调用，于是打印出来的还是被占用的旧端口。
async function listen(port, tries = 0) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && tries < 12) resolve(listen(port + 1, tries + 1));
      else reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      state.port = port;
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

await loadSessionsFromDisk();
await cleanTtsDir();
state.ttsAvailable = checkTts();
if (state.ttsAvailable) startTts(); // 预热语音进程，第一句不用等启动
process.on('SIGINT', () => { try { ttsProc?.kill(); sttProc?.kill(); } catch {} process.exit(0); });
const port = await listen(state.port);
const url = `http://127.0.0.1:${port}/?t=${state.token}`;
try { fs.writeFileSync(path.join(DATA_DIR, 'last-url.txt'), url + '\n', 'utf8'); } catch {}
console.log('');
console.log('  小D · 编程私教 已启动');
console.log('  ' + url);
console.log('');
console.log(`  模型 ${state.model} · 音色 ${state.voice} · 教学目录 ${state.projectRoot}`);
console.log(`  Key ${state.apiKey ? state.apiKey.slice(0, 6) + '…' + state.apiKey.slice(-4) : '未找到（设置 DEEPSEEK_API_KEY 或 config.json）'}`);
console.log('  按 Ctrl+C 停止');

function openBrowser(u) {
  if (process.argv.includes('--no-open')) return;
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  const child = edge
    ? spawn(edge, ['--new-window', u], { detached: true, stdio: 'ignore' })
    : spawn('cmd.exe', ['/c', 'start', '', `"${u}"`], { detached: true, stdio: 'ignore' });
  child.unref();
}
setTimeout(() => openBrowser(url), 400);
