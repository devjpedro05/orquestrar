<#
.SYNOPSIS
  Verifica o resultado de um worker: commits proibidos, arquivos fora do escopo, relatorio e diff.

.EXAMPLE
  verificar.ps1 -Repo C:\...\Apolo-Website-V2 -TaskId INSPMAP5-T01
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Repo,
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$TaskId
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $Repo).Path
$worktree = Join-Path (Split-Path $Repo -Parent) ".apolo-worktrees\$(Split-Path $Repo -Leaf)\$TaskId"
$orq = Join-Path $worktree '.orquestracao'
if (-not (Test-Path $orq)) { throw "Tarefa $TaskId nao encontrada em $worktree" }

$base = (Get-Content (Join-Path $orq 'BASE') -Raw).Trim()
$commits = @(& git -C $worktree rev-list "$base..HEAD")

# Arquivos alterados (staged, unstaged e novos), sem a pasta de orquestracao
$changed = @(& git -C $worktree -c core.quotepath=false status --porcelain --untracked-files=all |
  Where-Object { $_ -notmatch '\.orquestracao/' } |
  ForEach-Object { ($_.Substring(3) -replace '^.* -> ', '').Trim('"') })

# Globs da secao "## Arquivos permitidos" do TASK.md: linhas "- `glob`"
$task = Get-Content (Join-Path $orq 'TASK.md')
$allowed = @()
$inSection = $false
foreach ($line in $task) {
  if ($line -match '^##\s+Arquivos permitidos') { $inSection = $true; continue }
  if ($inSection -and $line -match '^##\s') { break }
  if ($inSection -and $line -match '^\s*-\s+`') {
    # Every `path` on the bullet counts (e.g. "- `a.ts` e `b.ts` (...)"); prose without "/" or "." is ignored.
    foreach ($m in [regex]::Matches($line, '`([^`\s]+)`')) {
      if ($m.Groups[1].Value -match '[/.]') { $allowed += $m.Groups[1].Value }
    }
  }
}
# Glob -> regex: '**/' = zero ou mais diretorios, '**' = qualquer coisa, '*' e '?' nao cruzam '/'.
# Assim 'dir/**/*' tambem casa arquivos direto em 'dir', e 'dir/*' nao casa subpastas.
function ConvertTo-GlobRegex([string]$glob) {
  $g = $glob -replace '\\', '/'
  $sb = [System.Text.StringBuilder]::new('^')
  $i = 0
  while ($i -lt $g.Length) {
    $c = $g[$i]
    if ($c -eq '*') {
      if ($i + 1 -lt $g.Length -and $g[$i + 1] -eq '*') {
        if ($i + 2 -lt $g.Length -and $g[$i + 2] -eq '/') { [void]$sb.Append('(?:.*/)?'); $i += 3; continue }
        [void]$sb.Append('.*'); $i += 2; continue
      }
      [void]$sb.Append('[^/]*')
    } elseif ($c -eq '?') {
      [void]$sb.Append('[^/]')
    } else {
      [void]$sb.Append([regex]::Escape([string]$c))
    }
    $i++
  }
  [void]$sb.Append('$')
  return $sb.ToString()
}
$allowedRegex = @($allowed | ForEach-Object { ConvertTo-GlobRegex $_ })
$outOfScope = @($changed | Where-Object {
  $file = $_ -replace '\\', '/'
  -not ($allowedRegex | Where-Object { $file -cmatch $_ })
})

[ordered]@{
  taskId          = $TaskId
  worktree        = $worktree
  forbiddenCommits = $commits.Count
  changedFiles    = $changed
  allowedGlobs    = $allowed
  outOfScope      = $outOfScope
  reportExists    = Test-Path (Join-Path $orq 'REPORT.md')
  verdict         = if ($commits.Count -gt 0 -or $outOfScope.Count -gt 0) { 'REPROVADO_GOVERNANCA' } else { 'OK_PARA_REVISAO' }
} | ConvertTo-Json -Depth 3

Write-Output "`n--- diff --stat ---"
& git -C $worktree diff --stat
& git -C $worktree diff --check
if ($LASTEXITCODE -ne 0) { Write-Output 'diff --check: FALHOU (espacos/conflitos)' } else { Write-Output 'diff --check: OK' }
