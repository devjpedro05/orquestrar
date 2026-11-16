// Progresso do Plano de Implementação: lê as tabelas de "## 4. Roteiro por fases" do plano e cruza cada ID
// com os merges WEBIMPL-<ID> na develop dos repositórios e com as marcas do próprio plano (~~riscado~~,
// "integrada", "Feito"). Só leitura: roda apenas `git log`.
'use strict';
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const git = (repo, args) => new Promise(res => execFile('git', ['-C', repo, ...args], { timeout: 10000, windowsHide: true, maxBuffer: 8 << 20 }, (e, out) => res(e ? '' : out)));
const key = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// "ORG.a / ORG.b" → ['ORG.a', 'ORG.b'];  "DASH / INBOX" → ['DASH', 'INBOX'];  "~~MEL.1~~" → ['MEL.1']
const idsOf = cell => cell.replace(/[~*`]/g, '').split('/').map(s => s.trim()).filter(s => /^[A-Z][A-Z0-9]*(\.[A-Za-z0-9]+)*$/.test(s));

function parsePlan(md) {
  const lines = md.replace(/\r/g, '').split('\n'), groups = [];
  let inRoadmap = false, group = null;
  for (const l of lines) {
    if (/^##\s+4\./.test(l)) { inRoadmap = true; continue; }
    if (inRoadmap && /^##\s+\d/.test(l)) break;
    if (!inRoadmap) continue;
    const h = l.match(/^###\s+(.+)$/);
    if (h) { group = { name: h[1].replace(/\s*\(.*\)\s*$/, '').trim(), items: [] }; groups.push(group); continue; }
    if (!group) continue;
    if (/^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*ID\s*\|/.test(l)) {
      const cells = l.split('|').slice(1, -1).map(c => c.trim()), ids = idsOf(cells[0] || '');
      for (const id of ids) group.items.push({ id, title: (cells[1] || '').replace(/~~/g, '').replace(/\*\*/g, '').replace(/`/g, '').slice(0, 140), row: l, solo: ids.length === 1, struckCell: /^~~.*~~$/.test(cells[0]) });
    }
    // fase sem tabela (Produção): cada item da lista vira uma etapa
    const b = l.match(/^-\s+(.+)$/);
    if (b && /Fase 7/.test(group.name)) group.items.push({ id: 'F7.' + (group.items.length + 1), title: b[1].replace(/[;.]$/, '').slice(0, 140), row: l, solo: true, struckCell: /^~~/.test(b[1]) });
  }
  // a mesma ID pode aparecer em duas fases (OCO, REL): fica na primeira, com o texto das duas linhas
  const seen = new Map();
  for (const g of groups) g.items = g.items.filter(it => { const k = key(it.id), o = seen.get(k); if (o) { o.row += '\n' + it.row; return false; } seen.set(k, it); return true; });
  return groups.filter(g => g.items.length);
}

function markOf(it) {
  const id = it.id.replace(/[.]/g, '\\.'), r = it.row;
  if (/fora do escopo atual/i.test(r)) return 'skip';
  if (it.struckCell || new RegExp(`~~\\s*(\\*\\*)?${id}(?![\\w.])`).test(r) || new RegExp(`(\\*\\*)?${id}(\\*\\*)?(?![\\w.])[^|.;]{0,40}?\\b(integrad[ao]s?|feit[ao])\\b`, 'i').test(r)) return 'done';
  if (it.solo && /\*\*Feit[oa]|\bFeito\b|J[áa] resolvida|\bintegrad[oa]\b/.test(r) && !/\bFalta\b/.test(r)) return 'done';
  if (new RegExp(`${id}(?![\\w.])[^|]{0,60}?(em andamento|despachad[ao])`, 'i').test(r) || (it.solo && /em andamento|\bDespachada\b/i.test(r))) return 'running';
  if (it.solo && /\*\*(Leitura|Edição) feita/i.test(r)) return 'partial';
  return null;
}

async function planProgress(planFile, repos, runningIds) {
  const md = fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8') : null;
  if (!md) return { found: false, file: planFile };
  // merges e commits da develop de cada repositório
  const merges = [], commits = [];
  for (const repo of repos) {
    const out = await git(repo, ['log', 'develop', '--format=%h\t%s\t%ct', '-n', '3000']);
    for (const l of out.split('\n').filter(Boolean)) {
      const [h, s, ct] = l.split('\t'), m = s.match(/WEBIMPL-([A-Za-z0-9.\-]+)/);
      const rec = { repo: path.basename(repo), hash: h, subject: s, at: +ct * 1000 };
      if (m && /^Merge/.test(s)) merges.push({ ...rec, k: key(m[1]) }); else commits.push(rec);
    }
  }
  const running = new Set([...runningIds].map(id => key(id.replace(/^WEBIMPL-/, ''))));
  const groups = parsePlan(md).map(g => ({ name: g.name, items: g.items.map(it => {
    const k = key(it.id);
    // merge exato, ou com sufixo de número/hífen (OS.a → OS.a1, AUTH.6 → AUTH.6-API): pronto; sufixo de letra (GEO.2 → GEO2r): parcial
    const full = merges.filter(m => m.k === k || (m.k.startsWith(k) && /^([0-9]|api$|web$)/.test(m.k.slice(k.length))));
    const part = merges.filter(m => !full.includes(m) && m.k.startsWith(k) && m.k.length > k.length);
    const mentions = commits.filter(c => new RegExp(`(^|[^\\w.])${it.id.replace(/[.]/g, '\\.')}(?![\\w.])`).test(c.subject));
    const mark = markOf(it), isRunning = [...running].some(r => r === k || (r.startsWith(k) && r.length - k.length <= 3));
    let status = mark === 'skip' ? 'skip' : full.length || mark === 'done' ? 'done' : isRunning || mark === 'running' ? 'running' : part.length || mentions.length || mark === 'partial' ? 'partial' : 'todo';
    const ev = [...full, ...part].map(m => `${m.repo} ${m.hash}`).concat(status !== 'done' || !full.length ? mentions.slice(0, 2).map(c => `${c.repo} ${c.hash}`) : []);
    return { id: it.id, title: it.title, status, evidence: ev.slice(0, 4), source: full.length ? 'merge' : mark === 'done' ? 'plano' : part.length ? 'merge parcial' : mentions.length ? 'commit' : null };
  }).filter(it => it.status !== 'skip') }));
  const all = groups.flatMap(g => g.items), n = s => all.filter(i => i.status === s).length;
  const st = fs.statSync(planFile);
  return { found: true, file: planFile, title: (md.match(/^#\s+(.+)$/m) || [, ''])[1], updated: st.mtimeMs,
    total: all.length, done: n('done'), running: n('running'), partial: n('partial'), todo: n('todo'),
    pct: all.length ? Math.round(100 * (n('done') + .5 * n('partial')) / all.length) : 0,
    groups: groups.map(g => ({ name: g.name, total: g.items.length, done: g.items.filter(i => i.status === 'done').length, items: g.items })) };
}
module.exports = { planProgress, parsePlan };
