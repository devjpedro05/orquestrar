<#
.SYNOPSIS
  Despacha uma tarefa para um worker (Codex ou Antigravity) numa worktree isolada.

.DESCRIPTION
  1. Cria (ou reutiliza) a worktree <raiz>\.apolo-worktrees\<repo>\<TaskId> na branch agent/<TaskId>.
  2. Copia o TASK.md para <worktree>\.orquestracao\TASK.md (pasta ignorada pelo git).
  3. Roda o worker em modo nao interativo, sem commit/push, gravando log e relatorio.
  4. Ao final, verifica se o worker criou commits (proibido) e grava STATUS.json.

.EXAMPLE
  despachar.ps1 -Worker codex -Repo C:\...\Apolo-Website-V2 -TaskId INSPMAP5-T01 -TaskFile C:\tmp\TASK.md
#>
[CmdletBinding()]
param(
  # agy2 = agy instalado no WSL (Ubuntu), logado em outra conta Google; roda em paralelo com o agy do Windows.
  [Parameter(Mandatory)][ValidateSet('codex', 'agy', 'agy2')][string]$Worker,
  [string]$WslDistro = 'Ubuntu',
  [Parameter(Mandatory)][string]$Repo,
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$TaskId,
  [Parameter(Mandatory)][string]$TaskFile,
  [string]$Base = 'develop',
  [string]$Model,
  [switch]$Continue
)

$ErrorActionPreference = 'Stop'

# No Windows PowerShell 5.1, stderr de exe nativo vira erro terminante sob 'Stop'; usar 'Continue' e checar o exit code.
function Invoke-Git {
  param([string[]]$GitArgs)
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & git @GitArgs 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') falhou: $out" }
  $out | Where-Object { $_ -notmatch '^(Preparing worktree|HEAD is now at)' }
}

$Repo = (Resolve-Path $Repo).Path
$TaskFile = (Resolve-Path $TaskFile).Path
Invoke-Git @('-C', $Repo, 'rev-parse', '--is-inside-work-tree') | Out-Null

$repoName = Split-Path $Repo -Leaf
$worktreeRoot = Join-Path (Split-Path $Repo -Parent) ".apolo-worktrees\$repoName"
$worktree = Join-Path $worktreeRoot $TaskId
$branch = "agent/$TaskId"

if (-not (Test-Path $worktree)) {
  if ($Continue) { throw "Worktree $worktree nao existe; -Continue exige uma tarefa ja despachada." }
  New-Item -ItemType Directory -Force $worktreeRoot | Out-Null
  $branchExists = (& git -C $Repo branch --list $branch)
  if ($branchExists) { throw "A branch $branch ja existe sem worktree. Revise ou remova manualmente antes de despachar." }
  Invoke-Git @('-C', $Repo, 'worktree', 'add', $worktree, '-b', $branch, $Base) | Out-Null
}

# .orquestracao/ fica fora do git (exclude compartilhado por todas as worktrees)
$commonDir = (Invoke-Git @('-C', $worktree, 'rev-parse', '--git-common-dir')).Trim()
if (-not [IO.Path]::IsPathRooted($commonDir)) { $commonDir = Join-Path $worktree $commonDir }
$exclude = Join-Path $commonDir 'info\exclude'
New-Item -ItemType Directory -Force (Split-Path $exclude) | Out-Null
# Despachos paralelos compartilham este arquivo: tentar algumas vezes se estiver bloqueado.
for ($attempt = 1; $attempt -le 10; $attempt++) {
  try {
    if ((Test-Path $exclude) -and (Select-String -Path $exclude -SimpleMatch '.orquestracao/' -Quiet)) { break }
    Add-Content -Path $exclude -Value '.orquestracao/' -Encoding ascii -ErrorAction Stop
    break
  }
  catch { if ($attempt -eq 10) { throw }; Start-Sleep -Milliseconds (200 * $attempt) }
}

$orq = Join-Path $worktree '.orquestracao'
New-Item -ItemType Directory -Force $orq | Out-Null
# Com -Continue o TASK.md da worktree ja tem as "Correcoes do revisor": nao sobrescrever com o arquivo original.
if (-not $Continue -or -not (Test-Path (Join-Path $orq 'TASK.md'))) { Copy-Item $TaskFile (Join-Path $orq 'TASK.md') -Force }
Copy-Item (Join-Path $PSScriptRoot '..\templates\REPORT.template.md') (Join-Path $orq 'REPORT.template.md') -Force

# Worktree nova nao tem node_modules: sem isso o worker nao roda nenhum gate (tsc, eslint, vitest).
if ((Test-Path (Join-Path $worktree 'package-lock.json')) -and -not (Test-Path (Join-Path $worktree 'node_modules'))) {
  Push-Location $worktree
  # npm.cmd, nao npm: o shim npm.ps1 corrompe os argumentos com o redirecionamento *> ("Unknown command: pm").
  # Avisos do npm vao para o stderr; com ErrorActionPreference=Stop eles viram erro fatal. Vale so o codigo de saida.
  $ErrorActionPreference = 'Continue'
  try { & npm.cmd ci --no-audit --no-fund *> (Join-Path $orq 'npm-ci.log') }
  finally { Pop-Location; $ErrorActionPreference = 'Stop' }
  if ($LASTEXITCODE -ne 0) { throw "npm ci falhou na worktree $worktree (ver .orquestracao\npm-ci.log)." }
}

$baseFile = Join-Path $orq 'BASE'
if (-not (Test-Path $baseFile)) { (Invoke-Git @('-C', $worktree, 'rev-parse', 'HEAD')).Trim() | Set-Content $baseFile -Encoding ascii }
$baseCommit = (Get-Content $baseFile -Raw).Trim()

$prompt = @'
Voce e um worker de implementacao. Leia e execute integralmente .orquestracao/TASK.md neste diretorio.
Regras inegociaveis: NAO execute git commit, push, merge, rebase, reset, clean ou stash; NAO rode migrations nem altere bancos remotos;
NAO edite arquivos fora da lista de arquivos permitidos; se algo exigir decisao de produto, PARE e registre como DECISION REQUIRED.
Ao terminar (ou ao parar), escreva .orquestracao/REPORT.md seguindo .orquestracao/REPORT.template.md.
'@
if ($Continue) { $prompt = "Continue a tarefa de .orquestracao/TASK.md. Leia primeiro a secao 'Correcoes do revisor' no fim do TASK.md e corrija tudo. Mantenha as mesmas regras e atualize .orquestracao/REPORT.md." }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $orq "log-$Worker-$stamp.txt"
$started = Get-Date

Push-Location $worktree
$ErrorActionPreference = 'Continue'
try {
  if ($Worker -eq 'codex') {
    # resume nao aceita -C/-s: roda no cwd da worktree (--last filtra pelo cwd) e fixa o sandbox via config
    if ($Continue) { $codexArgs = @('exec', 'resume', '--last', '-c', 'sandbox_mode="workspace-write"') }
    else { $codexArgs = @('exec', '-C', $worktree, '-s', 'workspace-write') }
    $codexArgs += @('-o', (Join-Path $orq 'RESULT.md'))
    if ($Model) { $codexArgs += @('-m', $Model) }
    $codexArgs += $prompt
    & codex @codexArgs *> $log
  }
  elseif ($Worker -eq 'agy2') {
    # O agy do WSL nao enxerga o npm/node do Windows (PATH restrito): os gates ficam com o revisor.
    # O git do Linux tambem nao resolve o gitdir "C:/..." da worktree, o que reforca a proibicao de commit.
    $prompt += "`nNeste ambiente (WSL) npm, node e git nao estao disponiveis: nao tente rodar os gates nem instalar nada; registre no REPORT que os gates ficam com o revisor."
    # Em modo headless o agy nega qualquer comando de terminal e encerra a conversa no mesmo turno.
    $prompt += "`nNAO execute nenhum comando de terminal (RunCommand, shell, ls, cat, grep, find): ele e negado neste modo e encerra a sua sessao sem salvar nada. Use somente as ferramentas de listar, ler, buscar e editar arquivos."
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $orq 'PROMPT.txt'), $prompt.Replace("`r`n", "`n"), $utf8)
    $flags = '--mode accept-edits --output-format json'
    if ($Continue) { $flags = "--continue $flags" }
    if ($Model) {
      if ($Model -notmatch '^[A-Za-z0-9._-]+$') { throw "Modelo invalido: $Model" }
      $flags += " --model $Model"
    }
    $runner = "#!/usr/bin/env bash`nexport PATH=`"`$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin`"`nexec agy $flags -p `"`$(cat .orquestracao/PROMPT.txt)`"`n"
    [IO.File]::WriteAllText((Join-Path $orq 'run-agy2.sh'), $runner, $utf8)
    $linuxWorktree = '/mnt/' + $worktree.Substring(0, 1).ToLower() + ($worktree.Substring(2) -replace '\\', '/')
    & wsl.exe -d $WslDistro --cd $linuxWorktree -- bash .orquestracao/run-agy2.sh *> $log
  }
  else {
    $agyArgs = @('-p', $prompt, '--mode', 'accept-edits', '--output-format', 'json')
    if ($Continue) { $agyArgs = @('--continue') + $agyArgs }
    if ($Model) { $agyArgs += @('--model', $Model) }
    & agy @agyArgs *> $log
  }
  $exitCode = $LASTEXITCODE
}
finally { Pop-Location; $ErrorActionPreference = 'Stop' }

$commits = @(& git -C $worktree rev-list "$baseCommit..HEAD")
$changed = @(& git -C $worktree status --porcelain | Where-Object { $_ -notmatch '\.orquestracao/' })
$status = [ordered]@{
  taskId       = $TaskId
  worker       = $Worker
  worktree     = $worktree
  branch       = $branch
  base         = $baseCommit
  exitCode     = $exitCode
  startedAt    = $started.ToString('s')
  finishedAt   = (Get-Date).ToString('s')
  changedFiles = $changed.Count
  reportExists = Test-Path (Join-Path $orq 'REPORT.md')
  violation    = if ($commits.Count -gt 0) { "Worker criou $($commits.Count) commit(s) - proibido" } else { $null }
  log          = $log
}
$status | ConvertTo-Json | Set-Content (Join-Path $orq 'STATUS.json') -Encoding utf8
$status | ConvertTo-Json
