// Fotos das rodadas: quando a rodada de um worker termina, o painel copia os arquivos que ela deixou alterados para
// <painel>/.rodadas/<repo>/<id>/rodada-<n>/ (fora da worktree) e guarda o `git diff HEAD` daquele momento.
// Com isso o DIFF compara a 1ª tentativa com a correção (↻). Só lê a worktree; nunca escreve nela nem no git.
'use strict';
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');

const SNAP_DIR = path.join(__dirname, '.rodadas');
const MAX_FILE = 512 * 1024, MAX_TOTAL = 16 << 20;
const safe = s => String(s).replace(/[^\w.\-]/g, '_');
const dirOf = (t, n) => path.join(SNAP_DIR, safe(t.repo), safe(t.id), 'rodada-' + n);
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// git que devolve a saída mesmo com código 1 (o diff --no-index sai com 1 quando há diferença)
const gitOut = (argv) => new Promise(res => execFile('git', argv, { timeout: 10000, windowsHide: true, maxBuffer: 16 << 20 }, (err, out) => res(out || (err ? null : ''))));

const busy = new Set();
// tira a foto da última rodada encerrada, se ainda não existe e se a worktree ainda é o que o worker deixou
async function maybeSnap(t, grace) {
  if (t.state === 'running' || !t.runs.length) return;
  const n = t.runs.length, r = t.runs[n - 1];
  if (!r.end || Date.now() < r.end + grace) return;
  const dir = dirOf(t, n);
  if (busy.has(dir) || fs.existsSync(path.join(dir, 'meta.json'))) return;
  if (!t.files.length || t.files.some(f => f.by === 'claude')) return;   // vazia, ou o mestre já mexeu: não é mais a rodada
  busy.add(dir);
  try {
    const patch = await gitOut(['-C', t.dir, '-c', 'core.quotepath=false', 'diff', 'HEAD', '--no-color']);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    let total = 0; const files = [];
    for (const f of t.files) {
      const src = path.join(t.dir, f.file); let size = 0, copied = false;
      try { size = fs.statSync(src).size; } catch { }
      if (f.code !== 'D' && size && size <= MAX_FILE && total + size <= MAX_TOTAL) {
        const dst = path.join(dir, 'files', f.file);
        fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); total += size; copied = true;
      }
      files.push({ file: f.file, code: f.code, size, copied });
    }
    fs.writeFileSync(path.join(dir, 'diff.patch'), patch || '');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ run: n, worker: r.worker, start: r.start, end: r.end, takenAt: Date.now(), files }));
  } catch (e) { console.error('foto da rodada', t.id, e.message); }
  finally { busy.delete(dir); }
}

function listSnaps(t) {
  const out = [];
  for (let n = 1; n <= t.runs.length; n++) { const m = readJSON(path.join(dirOf(t, n), 'meta.json')); if (m) out.push({ run: n, end: m.end, worker: m.worker, files: m.files.length }); }
  return out;
}

// pedaço do patch de um arquivo
function patchOf(patch, file) {
  const parts = patch.split(/^(?=diff --git )/m);
  return parts.find(p => { const m = p.match(/^diff --git a\/(.+?) b\/(.+)$/m); return m && (m[2] === file || m[1] === file); }) || '';
}
const sameFile = (a, b) => { try { const x = fs.readFileSync(a), y = fs.readFileSync(b); return x.equals(y); } catch { return null; } };
const synth = (txt, label) => { const l = txt.slice(0, 400000).split('\n'); return `--- /dev/null\n+++ ${label}\n@@ -0,0 +1,${l.length} @@ (arquivo novo)\n` + l.map(s => '+' + s).join('\n'); };

// rodada n → agora: o que a correção mudou em cada arquivo, e os dois diffs contra o HEAD lado a lado
async function compare(t, n, file, currentDiff) {
  const dir = dirOf(t, n), meta = readJSON(path.join(dir, 'meta.json'));
  if (!meta) return { id: t.id, found: false, error: 'sem foto desta rodada (o painel não estava aberto quando ela terminou, ou o mestre mexeu antes)' };
  const before = new Map(meta.files.map(f => [f.file, f])), now = new Map(t.files.map(f => [f.file, f]));
  const names = [...new Set([...before.keys(), ...now.keys()])];
  if (!file) {
    return { id: t.id, found: true, run: n, end: meta.end, worker: meta.worker, files: names.map(name => {
      const b = before.get(name), c = now.get(name);
      const status = !b ? 'novo' : !c ? 'revertido' : !b.copied ? (c.code === 'D' && b.code === 'D' ? 'igual' : '?') : sameFile(path.join(dir, 'files', name), path.join(t.dir, name)) ? 'igual' : 'mudou';
      return { file: name, status, by: c ? c.by : null, mtime: c ? c.mtime : 0 };
    }) };
  }
  if (!names.includes(file)) return { id: t.id, found: false, error: 'arquivo fora desta comparação' };
  const b = before.get(file), c = now.get(file), snapF = path.join(dir, 'files', file), curF = path.join(t.dir, file);
  const patch = fs.readFileSync(path.join(dir, 'diff.patch'), 'utf8');
  const beforeDiff = !b ? '(a rodada não mexeu neste arquivo)' : b.code === '??' ? (b.copied ? synth(fs.readFileSync(snapF, 'utf8'), 'rodada ' + n + '/' + file) : '(arquivo grande: não foi copiado)') : patchOf(patch, file) || '(sem diferença de conteúdo)';
  const afterDiff = c ? await currentDiff() : '(igual ao HEAD: a correção desfez a mudança)';
  let inter;
  if (!b) inter = afterDiff;
  else if (!b.copied) inter = '(a foto não tem a cópia deste arquivo)';
  else if (!fs.existsSync(curF)) inter = '(o arquivo foi apagado depois da rodada)';
  else {
    const d = await gitOut(['diff', '--no-index', '--no-color', '--', snapF, curF]);
    inter = d === null ? '(não foi possível comparar)' : d.trim() ? `--- rodada ${n}/${file}\n+++ agora/${file}\n` + d.split('\n').filter(l => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n') : '(igual: a correção não mexeu neste arquivo)';
  }
  return { id: t.id, file, run: n, inter: inter.slice(0, 400000), before: beforeDiff.slice(0, 400000), after: afterDiff.slice(0, 400000) };
}

module.exports = { maybeSnap, listSnaps, compare, SNAP_DIR };
