// 长期白名单：按目录 / 命令前缀 / 工具 决定哪些操作以后不再询问。
import fs from 'node:fs';
import path from 'node:path';

const DANGER = [
  /\b(rm|del|erase|rd|rmdir)\b[\s\S]*(\/s|\/q|\/f|-rf|-r\b)/i,
  /remove-item[\s\S]*-recurse/i,
  /\bformat\b/i,
  /\b(shutdown|restart-computer|stop-computer)\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\b(bcdedit|diskpart|mkfs|fdisk|cipher)\b/i,
  /\bdd\s+if=/i,
  /\bnet\s+user\b/i,
  /\b(takeown|icacls)\b/i,
  /set-executionpolicy/i,
  /\b(invoke-expression|iex)\b/i,
  /\b(curl|wget|iwr|invoke-webrequest)\b[\s\S]*\|\s*(sh|bash|iex|powershell)/i,
  /git\s+push[\s\S]*--force/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
];

export function isDangerousCommand(cmd) {
  return DANGER.some((re) => re.test(String(cmd || '')));
}

export function createAllowlist(file) {
  let data = { dirs: [], commands: [], tools: [], screen: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      dirs: Array.isArray(raw.dirs) ? raw.dirs : [],
      commands: Array.isArray(raw.commands) ? raw.commands : [],
      tools: Array.isArray(raw.tools) ? raw.tools : [],
      screen: !!raw.screen,
    };
  } catch {}

  const save = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[allowlist save]', e.message);
    }
  };

  const inDir = (abs) => {
    const a = abs.toLowerCase().replace(/[\\/]+$/, '');
    return data.dirs.some((d) => {
      const dd = String(d).toLowerCase().replace(/[\\/]+$/, '');
      return a === dd || a.startsWith(dd + path.sep);
    });
  };

  const commandOk = (cmd) => {
    const c = String(cmd || '').trim().toLowerCase();
    if (!c || isDangerousCommand(c)) return false;
    return data.commands.some((p) => c.startsWith(String(p).toLowerCase()));
  };

  const autoAllowed = (name, absPath, command) => {
    if (name === 'look_at_screen') return data.screen;
    if (data.tools.includes(name)) return true;
    if (name === 'write_file' || name === 'replace_in_file' || name === 'open_in_editor') return absPath ? inDir(absPath) : false;
    if (name === 'run_command') return commandOk(command);
    return false;
  };

  const add = (rule) => {
    if (!rule || !rule.type) return;
    if (rule.type === 'dir' && rule.value && !inDir(rule.value)) data.dirs.push(rule.value);
    if (rule.type === 'command' && rule.value && !data.commands.some((c) => c.toLowerCase() === rule.value.toLowerCase())) data.commands.push(rule.value);
    if (rule.type === 'tool' && rule.value && !data.tools.includes(rule.value)) data.tools.push(rule.value);
    if (rule.type === 'screen') data.screen = true;
    save();
  };

  const remove = (type, value) => {
    if (type === 'dir') data.dirs = data.dirs.filter((d) => d !== value);
    if (type === 'command') data.commands = data.commands.filter((c) => c !== value);
    if (type === 'tool') data.tools = data.tools.filter((t) => t !== value);
    if (type === 'screen') data.screen = false;
    save();
  };

  const clear = () => {
    data.dirs = [];
    data.commands = [];
    data.tools = [];
    data.screen = false;
    save();
  };

  return { data, add, remove, clear, inDir, autoAllowed };
}

export function suggestRule(name, { absPath, command } = {}) {
  if (name === 'look_at_screen') return { type: 'screen', value: '', label: '以后看屏幕不再问' };
  if (name === 'write_file' || name === 'replace_in_file') {
    if (!absPath) return null;
    return { type: 'dir', value: path.dirname(absPath), label: '这个目录以后都允许' };
  }
  if (name === 'open_in_editor') {
    if (!absPath) return null;
    return { type: 'dir', value: path.dirname(absPath), label: '这个目录里的文件以后直接开' };
  }
  if (name === 'run_command' && command) {
    const parts = String(command).trim().split(/\s+/);
    let prefix = parts[0] || '';
    if (['npm', 'pnpm', 'yarn', 'git', 'python', 'py', 'pip', 'node', 'dotnet', 'cargo', 'go'].includes(prefix.toLowerCase()) && parts[1] && !parts[1].startsWith('-')) {
      prefix += ' ' + parts[1];
    }
    if (!prefix) return null;
    return { type: 'command', value: prefix, label: `以后「${prefix}…」都允许` };
  }
  return { type: 'tool', value: name, label: '以后这个操作不再问' };
}
