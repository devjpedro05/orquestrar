# orquestrar

Skill do [Claude Code](https://claude.com/claude-code) que usa o Claude como **mestre** e o **Codex CLI** e o **Antigravity CLI (agy)** como **workers**. Cada worker trabalha numa worktree git isolada. O mestre escreve o TASK, despacha, revisa o REPORT, pede correções e integra.

## Conteúdo

| Caminho | O que é |
|---|---|
| `SKILL.md` | O fluxo completo: regras, despacho, governança, revisão e integração |
| `scripts/despachar.ps1` | Cria a worktree a partir de `develop`, copia o TASK e roda o worker |
| `scripts/verificar.ps1` | Confere o escopo (arquivos permitidos), o STATUS e o REPORT de uma tarefa |
| `scripts/painel/` | Painel ao vivo (Node, sem dependências) |
| `templates/` | Modelos de TASK.md e REPORT.md |

## Painel ao vivo

```bash
node scripts/painel/server.js [--root <pasta .apolo-worktrees>] [--port 4317] [--hours 8] [--plan <plano.md>]
```

Depois é só abrir `http://localhost:4317`. O painel mostra:

- **Globo e raias:**
  - um globo 3D com o mestre e cada task;
  - ondas de I/O;
  - raias com a linha do tempo de cada worker e um replay do dia.
- **Abas da task:** LOG, TASK, DIFF, ARQUIVOS e REPORT, este último com o markdown renderizado.
- **Governança ao vivo:**
  - alertas de arquivo fora do escopo e de DECISION REQUIRED;
  - tasks já integradas na `develop`;
  - o que cada um editou: os arquivos alterados fora de uma rodada aparecem como do Claude, não do worker.
- **Progresso e métricas:**
  - o progresso do plano de implementação;
  - CPU e memória de cada worker;
  - previsão de término;
  - custo estimado em tokens.
- **Comparação de rodadas:** a 1ª tentativa ao lado da correção (↻).
- **Interface:**
  - filtro e busca;
  - atalhos de teclado (aperte `?`);
  - tema claro;
  - modo apresentação;
  - layout responsivo.

O painel não altera as worktrees. Ele só lê os arquivos e roda `git status`, `git diff` e `git log`, sem nenhuma ação que despache, integre ou mexa no git. As cópias das rodadas ficam em `scripts/painel/.rodadas/`, fora das worktrees e fora do repositório (estão no `.gitignore`).

## Requisitos

- Windows com PowerShell. O worker agy2 roda no WSL.
- Node.js 18 ou mais novo, para o painel.
- Codex CLI e/ou Antigravity CLI instalados e autenticados.
