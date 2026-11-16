#!/usr/bin/env node
// Painel ao vivo da orquestração: lê as worktrees dos workers e serve o globo em http://localhost:4317.
// Sem dependências. Só leitura: nunca escreve nas worktrees nem roda git com efeito colateral.
//   node server.js [--root <pasta .apolo-worktrees>]... [--port 4317] [--hours 8]
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const roots = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--root') roots.push(args[i + 1]);
if (!roots.length) roots.push(path.join(os.homedir(), '.gemini', 'antigravity', 'scratch', '.apolo-worktrees'));
const PORT = +opt('port', 4317), HOURS = +opt('hours', 8);
const RUN_GRACE = 20e3;    // o worker ainda grava arquivos alguns segundos depois do STATUS.json
const IDLE_STOP_MIN = 45;   // sem STATUS e sem nenhuma atividade há tanto tempo: provavelmente parou
const MAX_WORKERS = 3;      // limite da máquina definido na SKILL.md
const LOG_RE = /^log-(codex|agy2?)-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.txt$/;

const readText = f => { try { return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const stat = f => { try { return fs.statSync(f); } catch { return null; } };
const run = (cmd, argv, opts = {}) => new Promise(res => execFile(cmd, argv, { timeout: 10000, windowsHide: true, maxBuffer: 16 << 20, ...opts }, (err, out) => res(err ? null : out)));

// ─────────────── git ───────────────
const gitCache = new Map();
async function gitStatus(wt) {
  const c = gitCache.get(wt), now = Date.now();
  if (c && now - c.at < 2500) return c.files;
  const out = await run('git', ['-C', wt, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all']);
  const files = out === null ? (c ? c.files : []) : out.split(/\r?\n/).filter(Boolean)
    .map(l => ({ code: l.slice(0, 2).trim(), file: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') }))
    .filter(f => !f.file.startsWith('.orquestracao'))
    .map(f => { const s = stat(path.join(wt, f.file)); return { ...f, mtime: s ? s.mtimeMs : 0 }; })
    .sort((a, b) => a.mtime - b.mtime);
  gitCache.set(wt, { at: now, files });
  return files;
}

// tarefas já integradas: merges "agent/WEBIMPL-X" ou "Merge WEBIMPL-X:" na develop do repositório principal
const mergeCache = new Map();
async function mergedIds(repoDir) {
  const c = mergeCache.get(repoDir), now = Date.now();
  if (c && now - c.at < 20000) return c.ids;
  const out = await run('git', ['-C', repoDir, 'log', 'develop', '--merges', '--format=%h\t%s\t%ct', '-n', '500']);
  const ids = new Map();
  if (out) for (const l of out.split('\n').filter(Boolean)) {
    const [h, s, ct] = l.split('\t'), m = s.match(/(?:agent\/|Merge\s+)((?:WEBIMPL|WEB)-[A-Za-z0-9.\-]+?)(?=['":\s]|$)/);
    if (m && !ids.has(m[1])) ids.set(m[1], { hash: h, at: +ct * 1000 });
  }
  mergeCache.set(repoDir, { at: now, ids: out === null && c ? c.ids : ids });
  return mergeCache.get(repoDir).ids;
}

// ─────────────── TASK / REPORT ───────────────
// mesma conversão de glob do verificar.ps1: '**/' = zero ou mais pastas, '**' = qualquer coisa, '*' e '?' não cruzam '/'
function globRegex(glob) {
  const g = glob.replace(/\\/g, '/'); let r = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { r += '(?:.*/)?'; i += 2; } else { r += '.*'; i += 1; } }
      else r += '[^/]*';
    } else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(r + '$');
}
function section(md, title) {
  const out = []; let inS = false;
  for (const line of md.split(/\r?\n/)) {
    if (new RegExp('^##\\s+' + title, 'i').test(line)) { inS = true; continue; }
    if (inS && /^##\s/.test(line)) break;
    if (inS) out.push(line);
  }
  return out;
}
// Every `path` on a bullet counts (e.g. "- `a.ts` e `b.ts` (...)"); prose without "/" or "." is ignored.
const allowedGlobs = md => section(md, 'Arquivos permitidos')
  .filter(l => /^\s*-\s+`/.test(l))
  .flatMap(l => [...l.matchAll(/`([^`\s]+)`/g)].map(m => m[1]))
  .filter(g => /[/.]/.test(g));
const checklist = (md, title) => section(md, title).map(l => l.match(/^\s*-\s+\[([ xX])\]\s*(.+)$/)).filter(Boolean).map(m => ({ done: m[1] !== ' ', text: m[2].trim() }));
function reportStatus(md) { const m = md.match(/\*\*Status:\*\*\s*([^\r\n]+)/i); return m ? m[1].replace(/[<>*`]/g, '').trim() : null; }

// ─────────────── execuções (um log = uma rodada) e tokens ───────────────
const tokenCache = new Map();
function tokensOf(file) {
  const s = stat(file); if (!s) return null;
  const c = tokenCache.get(file); if (c && c.size === s.size) return c.tokens;
  const m = tail(file, 16 * 1024).match(/tokens used\s*\r?\n\s*([\d.,]+)/g);
  const tokens = m ? +m[m.length - 1].replace(/^[\s\S]*\n\s*/, '').replace(/[.,]/g, '') : null;
  tokenCache.set(file, { size: s.size, tokens });
  return tokens;
}
const logStart = name => { const m = name.match(LOG_RE); return new Date(+m[2], m[3] - 1, +m[4], +m[5], +m[6], +m[7]).getTime(); };

// lê só o fim do log (os do Codex passam de 1 MB)
function tail(file, bytes = 512 * 1024) {
  const s = stat(file); if (!s) return '';
  const fd = fs.openSync(file, 'r'), n = Math.min(bytes, s.size), buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, s.size - n); fs.closeSync(fd);
  return buf.toString('utf8');
}
function codexActivity(text) {
  const lines = text.split(/\r?\n/);
  let say = null, cmd = null;
  for (let i = lines.length - 1; i >= 0 && (!say || !cmd); i--) {
    const l = lines[i].trim();
    if (!say && l === 'codex') {
      const para = []; for (let j = i + 1; j < lines.length && lines[j].trim() && !/^(exec|codex|thinking|apply patch|file update:?|user|tokens used)$/.test(lines[j].trim()); j++) para.push(lines[j].trim());
      if (para.length) say = para.join(' ');
    }
    if (!cmd && l === 'exec') {
      const raw = [lines[i + 1] || '', lines[i + 2] || ''].join(' ');
      const m = raw.match(/-Command\s+['"](.+?)['"]\s+in\b/) || raw.match(/-Command\s+['"](.+)/);
      cmd = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
    }
  }
  return { say, cmd };
}
function agyActivity(text) {
  // o aviso de systemd do WSL aparece em todo despacho do agy2 e não é erro
  const err = text.replace(/^.*(systemd user session|journalctl|despachar\.ps1|wsl\.exe -d|~~~|CategoryInfo|FullyQualifiedErrorId).*$/gim, '').match(/(Failed[^\r\n]*|error[^\r\n]*)/i);
  return { say: null, cmd: null, err: err && text.length < 4000 ? err[1].slice(0, 160) : null };
}

async function scanTask(repo, dir) {
  const orq = path.join(dir, '.orquestracao');
  const logs = fs.readdirSync(orq).filter(n => LOG_RE.test(n)).sort();
  const lastLog = logs.length ? path.join(orq, logs[logs.length - 1]) : null;
  const logStat = lastLog && stat(lastLog);
  const statusFile = path.join(orq, 'STATUS.json'), statusStat = stat(statusFile);
  let status = null; if (statusStat) { try { status = JSON.parse(readText(statusFile)); } catch { } }
  const worker = (lastLog && logs[logs.length - 1].match(LOG_RE)[1]) || (status && status.worker) || '?';
  const started = lastLog ? logStart(logs[logs.length - 1]) : null;
  const finishedRun = !!statusStat && (!logStat || statusStat.mtimeMs >= logStat.mtimeMs - 2000);
  const files = await gitStatus(dir);
  const lastFileMs = files.reduce((m, f) => Math.max(m, f.mtime), 0);
  const lastActivity = Math.max(logStat ? logStat.mtimeMs : 0, lastFileMs, started || 0);
  let state = finishedRun ? 'done' : 'running';
  if (state === 'running' && Date.now() - lastActivity > IDLE_STOP_MIN * 60e3) state = 'stalled';
  if (state === 'done' && status && (status.exitCode !== 0 || status.violation)) state = 'failed';

  const taskMd = readText(path.join(orq, 'TASK.md')) || '';
  const title = (taskMd.match(/^#\s*(.+)$/m) || [, ''])[1].replace(/^TASK\s+\S+\s*[—-]\s*/, '');
  // governança ao vivo: o mesmo critério do verificar.ps1
  const globs = allowedGlobs(taskMd), rx = globs.map(globRegex);
  const outOfScope = globs.length ? files.filter(f => !rx.some(r => r.test(f.file.replace(/\\/g, '/')))).map(f => f.file) : [];
  // REPORT: só vale se for desta rodada (com -Continue o REPORT antigo continua lá até o worker reescrever)
  const reportFile = path.join(orq, 'REPORT.md'), reportStat = stat(reportFile);
  const reportFresh = !!reportStat && (!started || reportStat.mtimeMs >= started - 1000);
  const reportMd = reportStat ? readText(reportFile) || '' : '';
  const rStatus = reportMd ? reportStatus(reportMd) : null;
  const text = lastLog ? tail(lastLog) : '';
  const act = worker === 'codex' ? codexActivity(text) : agyActivity(text);
  // integrada: a branch agent/<id> já entrou na develop. Aí a decisão e o escopo já foram resolvidos pelo mestre.
  const merged = (await mergedIds(path.join(path.dirname(path.dirname(path.dirname(dir))), repo))).get(path.basename(dir)) || null;
  // DECISION REQUIRED: no status do REPORT desta rodada, ou dito pelo Codex na última fala. Deixa de valer quando
  // a tarefa é integrada ou quando o mestre edita o TASK.md depois do REPORT (respondeu em "Correções do revisor").
  const taskStat = stat(path.join(orq, 'TASK.md'));
  const answered = !!(taskStat && reportStat && taskStat.mtimeMs > reportStat.mtimeMs + 1000);
  const decision = !merged && !answered && ((reportFresh && /DECISION REQUIRED/i.test(rStatus || '')) || (state === 'running' && /DECISION REQUIRED/i.test(act.say || '')));

  const runs = logs.map((n, i) => {
    const f = path.join(orq, n), st = logStart(n), last = i === logs.length - 1;
    let end = last ? (finishedRun && status && status.finishedAt ? new Date(status.finishedAt).getTime() : (state === 'running' ? null : (stat(f) || {}).mtimeMs)) : (stat(f) || {}).mtimeMs;
    if (!last && end && end > logStart(logs[i + 1])) end = logStart(logs[i + 1]);
    return { start: st, end, worker: n.match(LOG_RE)[1], tokens: n.startsWith('log-codex') ? tokensOf(f) : null };
  });

  // quem mexeu: arquivo alterado dentro da janela de uma rodada é do worker daquela rodada; fora dela (antes do
  // despacho, entre rodadas ou depois da última) é do mestre. Uma rodada aberta cobre tudo até agora.
  const runOf = ms => runs.find(r => ms >= r.start - 5e3 && ms <= (r.end == null ? Infinity : r.end + RUN_GRACE));
  const byOf = ms => { const r = runOf(ms); return r ? r.worker : 'claude'; };
  const masterTimes = files.filter(f => f.mtime && byOf(f.mtime) === 'claude').map(f => f.mtime);
  if (taskStat && runs.length && byOf(taskStat.mtimeMs) === 'claude' && taskStat.mtimeMs > runs[0].start) masterTimes.push(taskStat.mtimeMs);
  masterTimes.sort((a, b) => a - b);
  const sessions = [];   // edições do mestre agrupadas: pausa de mais de 10 min abre uma nova sessão
  for (const ms of masterTimes) { const s = sessions[sessions.length - 1]; if (s && ms - s.e <= 10 * 60e3) s.e = ms; else sessions.push({ s: ms - 60e3, e: ms }); }
  const master = { files: files.filter(f => f.mtime && byOf(f.mtime) === 'claude').length, at: masterTimes.length ? masterTimes[masterTimes.length - 1] : null, sessions };

  return {
    id: path.basename(dir), dir, repo, worker, title, state, started,
    finished: finishedRun && status && status.finishedAt ? new Date(status.finishedAt).getTime() : null,
    exitCode: status ? status.exitCode : null, violation: status ? status.violation : null,
    report: !!reportStat, reportFresh, reportStatus: rStatus, decision, decisionAnswered: answered && !merged && reportFresh && /DECISION REQUIRED/i.test(rStatus || ''),
    integrated: merged, allowed: globs, outOfScope,
    criteria: { task: checklist(taskMd, 'Crit[eé]rios de pronto'), report: reportFresh ? checklist(reportMd, 'Crit[eé]rios de pronto') : [] },
    runs, tokens: runs.reduce((s, r) => s + (r.tokens || 0), 0) || null,
    logBytes: logStat ? logStat.size : 0, lastActivity,
    files: files.map(f => ({ file: f.file, code: f.code, mtime: f.mtime, out: outOfScope.includes(f.file), by: byOf(f.mtime) })),
    master,
    say: act.say, cmd: act.cmd, err: act.err || null,
    proc: PROC.tasks.get(path.basename(dir)) || null,
    // últimas linhas do log para o feed (sem o ruído do PowerShell)
    lines: text.split(/\r?\n/).map(l => l.replace(/\t/g, '  ').trimEnd())
      .filter(l => l.trim() && !/^(\uFEFF)?(wsl\.exe|No C:\\|\+\s+~|\s*\+ (CategoryInfo|FullyQualifiedErrorId)|\s+~)/.test(l))
      .slice(-14).map(l => l.slice(0, 200)),
  };
}

async function scan() {
  const tasks = [], jobs = [], since = Date.now() - HOURS * 3600e3;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const repo of fs.readdirSync(root)) {
      const rdir = path.join(root, repo); if (!stat(rdir)?.isDirectory()) continue;
      jobs.push(...fs.readdirSync(rdir).map(id => path.join(rdir, id)).filter(dir => fs.existsSync(path.join(dir, '.orquestracao')))
        .map(dir => scanTask(repo, dir).then(t => { if (t.state === 'running' || t.lastActivity >= since) tasks.push(t); }, () => { /* worktree em criação */ })));
    }
  }
  await Promise.all(jobs);   // as worktrees são lidas em paralelo
  const rank = { running: 0, stalled: 1, failed: 2, done: 3 };
  tasks.sort((a, b) => rank[a.state] - rank[b.state] || (b.started || 0) - (a.started || 0));
  DIRS.clear(); for (const t of tasks) DIRS.set(t.id, t);
  for (const t of tasks) rodadas.maybeSnap(t, RUN_GRACE).catch(() => { });   // foto de cada rodada que termina (para comparar com a correção)
  return { now: Date.now(), roots, tasks, sys: { ...PROC.sys, maxWorkers: MAX_WORKERS } };
}

// ─────────────── processos: CPU e memória de cada worker ───────────────
// Uma consulta ao Win32_Process a cada 3 s. Cada task fica com o processo cuja linha de comando cita a worktree
// (codex exec -C <wt>, wsl --cd /mnt/c/<wt>) e todos os descendentes. O agy do Windows não cita a pasta: vai para a
// única task agy rodando. O agy2 roda dentro da VM do WSL; daqui só se vê o wsl.exe, então a CPU dele fica de fora.
const PROC = { tasks: new Map(), sys: { cpu: null, memUsed: null, memTotal: os.totalmem(), cores: os.cpus().length } };
let prevTimes = new Map(), prevAt = 0, prevCpu = null;
function sysCpu() {
  const c = os.cpus().reduce((a, x) => { const t = x.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
  const r = prevCpu ? 100 * (1 - (c.idle - prevCpu.idle) / Math.max(1, c.total - prevCpu.total)) : null; prevCpu = c; return r;
}
async function sampleProcs() {
  try {
    PROC.sys.cpu = sysCpu(); PROC.sys.memUsed = os.totalmem() - os.freemem();
    const running = [...DIRS.values()].filter(t => t.state === 'running');
    if (process.platform !== 'win32' || !running.length) { PROC.tasks = new Map(); return; }
    const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
    if (!out) return;
    const list = JSON.parse(out), now = Date.now(), byPid = new Map(), kids = new Map();
    for (const p of list) { byPid.set(p.ProcessId, p); if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p.ProcessId); }
    const norm = s => (s || '').toLowerCase().replace(/\//g, '\\');
    const owner = new Map();
    for (const t of running) {
      const win = norm(t.dir), mnt = norm('/mnt/' + t.dir[0].toLowerCase() + t.dir.slice(2));
      for (const p of list) { const cl = norm(p.CommandLine); if (cl && (cl.includes(win) || cl.includes(mnt)) && !/powershell|bash\.exe|node\.exe.*server\.js|git\.exe/i.test(p.Name + ' ' + (p.CommandLine || '').slice(0, 80))) owner.set(p.ProcessId, t.id); }
    }
    const agyTasks = running.filter(t => t.worker === 'agy');
    if (agyTasks.length === 1) for (const p of list) if (/^agy(\.exe)?$/i.test(p.Name) && !owner.has(p.ProcessId)) owner.set(p.ProcessId, agyTasks[0].id);
    const tasks = new Map(), dt = prevAt ? (now - prevAt) / 1000 : 0, times = new Map();
    const add = (pid, id, seen = new Set()) => {
      if (seen.has(pid)) return; seen.add(pid); const p = byPid.get(pid); if (!p) return;
      const cpuT = (+p.KernelModeTime || 0) + (+p.UserModeTime || 0); times.set(pid, cpuT);
      const prev = prevTimes.get(pid), e = tasks.get(id) || { cpu: 0, mem: 0, n: 0, names: [] };
      if (dt && prev !== undefined) e.cpu += Math.max(0, cpuT - prev) / 1e7 / dt / PROC.sys.cores * 100;
      e.mem += +p.WorkingSetSize || 0; e.n++; if (!e.names.includes(p.Name)) e.names.push(p.Name);
      tasks.set(id, e); for (const k of kids.get(pid) || []) add(k, id, seen);
    };
    for (const [pid, id] of owner) add(pid, id);
    for (const [id, e] of tasks) { e.cpu = Math.round(e.cpu * 10) / 10; e.wsl = e.names.some(n => /^wsl/i.test(n)); }
    prevTimes = times; prevAt = now; PROC.tasks = tasks;
  } catch (e) { /* amostra perdida: tenta de novo no próximo ciclo */ }
  finally { setTimeout(sampleProcs, 3000); }
}

// ─────────────── rotas ───────────────
const DIRS = new Map();
function liveLog(id, kb) {
  const t = DIRS.get(id); if (!t) return { id, found: false };
  const orq = path.join(t.dir, '.orquestracao');
  const logs = fs.readdirSync(orq).filter(n => LOG_RE.test(n)).sort();
  const file = logs.length ? path.join(orq, logs[logs.length - 1]) : null;
  const raw = file ? tail(file, kb * 1024) : '';
  const text = raw.split(/\r?\n/).filter(l => !/^(\uFEFF)?(wsl\.exe :|No C:\\|\s*\+\s+~|\s*\+ (CategoryInfo|FullyQualifiedErrorId)|\s*~+\s*$)/.test(l)).join('\n');
  return { id, found: true, worker: t.worker, state: t.state, log: file ? path.basename(file) : null, size: file ? stat(file).size : 0, text,
    task: (readText(path.join(orq, 'TASK.md')) || '').slice(0, 60000),
    report: t.report ? (readText(path.join(orq, 'REPORT.md')) || '').slice(0, 40000) : null };
}
// diff de uma tarefa: lista com +/- por arquivo, ou o diff de um arquivo (só dos que o git status lista)
async function diffOf(id, file) {
  const t = DIRS.get(id); if (!t) return { id, found: false };
  if (!file) {
    const num = await run('git', ['-C', t.dir, '-c', 'core.quotepath=false', 'diff', 'HEAD', '--numstat']) || '';
    const stats = new Map(num.split(/\r?\n/).filter(Boolean).map(l => { const [a, d, f] = l.split('\t'); return [f, { add: a === '-' ? null : +a, del: d === '-' ? null : +d }]; }));
    return { id, found: true, snaps: rodadas.listSnaps(t), files: t.files.map(f => {
      let s = stats.get(f.file);
      if (!s && f.code === '??') { const txt = readText(path.join(t.dir, f.file)); s = { add: txt === null ? null : txt.split('\n').length, del: 0 }; }
      return { ...f, ...(s || { add: null, del: null }) };
    }) };
  }
  const f = t.files.find(x => x.file === file); if (!f) return { id, found: false, error: 'arquivo fora do git status desta tarefa' };
  if (f.code === '??') {
    const txt = readText(path.join(t.dir, f.file));
    if (txt === null) return { id, file, diff: '(arquivo binário ou ilegível)' };
    const lines = txt.slice(0, 400000).split('\n');
    return { id, file, diff: `--- /dev/null\n+++ b/${f.file}\n@@ -0,0 +1,${lines.length} @@ (arquivo novo)\n` + lines.map(l => '+' + l).join('\n') };
  }
  const d = await run('git', ['-C', t.dir, '-c', 'core.quotepath=false', 'diff', 'HEAD', '--', f.file]);
  return { id, file, diff: d === null ? '(não foi possível gerar o diff)' : d.slice(0, 400000) || '(sem diferença de conteúdo)' };
}

// ─────────────── Plano de Implementação ───────────────
// o plano fica ao lado da pasta das worktrees (<scratch>\PLANO-IMPLEMENTACAO-WEB.md); os repositórios são as pastas
// irmãs com .git. Recalcula a cada 30 s (ou logo que uma tarefa muda de estado).
const { planProgress } = require('./plano');
const rodadas = require('./rodadas');
const PLAN_FILE = opt('plan', path.join(path.dirname(roots[0]), 'PLANO-IMPLEMENTACAO-WEB.md'));
let PLAN = null, planAt = 0, planSig = '';
async function refreshPlan() {
  const running = [...DIRS.values()].filter(t => t.state === 'running').map(t => t.id), sig = running.join(',') + '|' + [...DIRS.values()].map(t => t.state).join('');
  if (Date.now() - planAt < 30000 && sig === planSig) return;
  planAt = Date.now(); planSig = sig;
  try {
    const base = path.dirname(PLAN_FILE);
    const repos = fs.readdirSync(base).map(n => path.join(base, n)).filter(d => fs.existsSync(path.join(d, '.git')));
    PLAN = await planProgress(PLAN_FILE, repos, running);
  } catch (e) { console.error(e); }
}

let SNAP = null, SNAP_P = null;
async function refresh() { try { const s = await scan(); await refreshPlan(); s.plan = PLAN; SNAP = s; } catch (e) { console.error(e); } setTimeout(() => { SNAP_P = refresh(); }, 1500); }
SNAP_P = refresh().then(() => sampleProcs());

const page = path.join(__dirname, 'index.html');
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/') && !SNAP) await SNAP_P;
    if (u.pathname === '/api/state') return json(res, { ...SNAP, now: Date.now() });
    if (u.pathname === '/api/log') return json(res, liveLog(u.searchParams.get('id') || '', clamp(+u.searchParams.get('kb') || 48, 4, 512)));
    if (u.pathname === '/api/compare') { const t = DIRS.get(u.searchParams.get('id') || ''), file = u.searchParams.get('file');
      return json(res, t ? await rodadas.compare(t, +u.searchParams.get('run') || 1, file, async () => (await diffOf(t.id, file)).diff) : { found: false }); }
    if (u.pathname === '/api/diff') return json(res, await diffOf(u.searchParams.get('id') || '', u.searchParams.get('file')));
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(page)); }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`painel já está rodando em http://localhost:${PORT}`); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => console.log(`painel da orquestração em http://localhost:${PORT}  (lendo ${roots.join(', ')})`));
