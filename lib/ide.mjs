// IDE 探测：找到 PyCharm / VS Code，读出它最近打开的项目和当前文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = process.env.USERPROFILE || '';
const APPDATA = process.env.APPDATA || '';
const LOCALAPPDATA = process.env.LOCALAPPDATA || '';

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

export function findPyCharm() {
  const roots = ['C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\', 'D:\\Program Files', path.join(LOCALAPPDATA, 'Programs')];
  const found = [];
  for (const root of roots) {
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && /^PyCharm/i.test(d.name)) found.push(path.join(root, d.name, 'bin', 'pycharm64.exe'));
      }
    } catch {}
  }
  try {
    const toolbox = path.join(LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps');
    for (const d of fs.readdirSync(toolbox, { withFileTypes: true })) {
      if (!/^PyCharm/i.test(d.name)) continue;
      const sub = path.join(toolbox, d.name, 'ch-0');
      if (!exists(sub)) continue;
      for (const v of fs.readdirSync(sub, { withFileTypes: true })) {
        if (v.isDirectory()) found.push(path.join(sub, v.name, 'bin', 'pycharm64.exe'));
      }
    }
  } catch {}
  return found.find(exists) || '';
}

export function findVSCode() {
  return [
    path.join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ].find(exists) || '';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function withUserHome(s) {
  return String(s).split('$USER_HOME$').join(HOME);
}

export function recentProjects() {
  const base = path.join(APPDATA, 'JetBrains');
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => /^PyCharm/i.test(d)); } catch { return { projects: [], last: '', configDir: '' }; }
  for (const d of dirs) {
    const f = path.join(base, d, 'options', 'recentProjects.xml');
    if (!exists(f)) continue;
    const xml = fs.readFileSync(f, 'utf8');
    const projects = [];
    const re = /<entry key="([^"]+)">([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = re.exec(xml))) {
      const key = path.normalize(withUserHome(m[1]));
      const rawTitle = decodeEntities((m[2].match(/frameTitle="([^"]*)"/) || [])[1] || '');
      const opened = /opened="true"/.test(m[2]);
      let currentFile = '';
      const fm = rawTitle.match(/[—–]\s*([A-Za-z]:\\[^\s"].*)$/);
      if (fm) currentFile = path.normalize(fm[1]);
      projects.push({ path: key, title: rawTitle, opened, currentFile });
    }
    const lastRaw = (xml.match(/name="lastOpenedProject" value="([^"]+)"/) || [])[1] || '';
    return { projects, last: path.normalize(withUserHome(lastRaw)), configDir: path.join(base, d) };
  }
  return { projects: [], last: '', configDir: '' };
}

function runningIdes() {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', "Get-Process pycharm64,idea64,code,cursor -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,MainWindowTitle,Path | ConvertTo-Json -Compress"],
        { timeout: 15000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (!stdout) return resolve([]);
          try {
            const j = JSON.parse(stdout);
            resolve((Array.isArray(j) ? j : [j]).filter((p) => p && p.ProcessName));
          } catch { resolve([]); }
        }
      );
    } catch {
      resolve([]);
    }
  });
}

export async function ideContext() {
  const pycharm = findPyCharm();
  const vscode = findVSCode();
  const { projects, last, configDir } = recentProjects();
  const running = await runningIdes();
  const pycharmRunning = running.filter((p) => /pycharm|idea/i.test(p.ProcessName));
  const current = projects.find((p) => p.opened) || projects.find((p) => p.path === last) || projects[0] || null;
  return {
    pycharm,
    vscode,
    configDir,
    running,
    pycharmRunning,
    lastProject: current?.path || last || '',
    projects: projects.slice(0, 6),
    currentFile: current?.currentFile || '',
  };
}

export function openerFor(file) {
  const pycharm = findPyCharm();
  if (pycharm) return { cmd: pycharm, args: [file, '--line', '1'], kind: 'pycharm' };
  const vscode = findVSCode();
  if (vscode) return { cmd: vscode, args: ['--goto', `${file}:1`], kind: 'vscode' };
  return null;
}

export function isInside(file, dir) {
  if (!file || !dir) return false;
  const f = path.resolve(file).toLowerCase();
  const d = path.resolve(dir).toLowerCase().replace(/[\\/]+$/, '');
  return f === d || f.startsWith(d + path.sep);
}
