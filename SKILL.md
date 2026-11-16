---
name: orquestrar
description: Orquestra o desenvolvimento do Apolo com o Claude Code como mestre e o Codex CLI e o Antigravity CLI (agy) como workers em worktrees isoladas. Use quando o usuário pedir para "orquestrar", "delegar para o Codex/Antigravity", "usar os workers" ou dividir uma entrega do Apolo entre agentes.
---

# Orquestração Apolo — mestre Claude Code, workers Codex e Antigravity

Você (Claude Code) é o **mestre**: decide, divide, despacha, revisa e integra. Os workers só implementam numa worktree própria e entregam um `REPORT.md`. Decisão de produto, arquitetura, banco, contrato de sync, commit e push **nunca** são delegados.

Scripts (PowerShell) nesta skill:

- `scripts/despachar.ps1 -Worker codex|agy|agy2 -Repo <repo> -TaskId <ID> -TaskFile <TASK.md> [-Base develop] [-Model <m>] [-Continue]`
- `scripts/verificar.ps1 -Repo <repo> -TaskId <ID>`
- `scripts/painel/server.js [--root <pasta .apolo-worktrees>] [--port 4317] [--hours 8]` (Node): painel animado ao vivo dos workers, só leitura
- Modelos: `templates/TASK.template.md`, `templates/REPORT.template.md`

Worktrees: `<scratch>\.apolo-worktrees\<repo>\<TaskId>`, branch `agent/<TaskId>`. Arquivos de controle em `<worktree>\.orquestracao\` (ignorado pelo git): `TASK.md`, `REPORT.md`, `RESULT.md` (Codex), `STATUS.json`, `BASE`, logs.

## Fluxo

### 1. Planejar (mestre)

1. Ler `AGENTS.md` do repositório-alvo, a memória e o Notion do checkpoint. Respeitar tudo que está PAUSADO (persistência, API, DB, D.4, Desktop só leitura).
2. Registrar o congelamento de escopo no Notion antes de despachar, como já é o fluxo do projeto.
3. Quebrar em tarefas pequenas com **conjuntos de arquivos disjuntos**. Duas tarefas paralelas nunca tocam o mesmo arquivo; tarefas dependentes vão em sequência.
4. Colocar cada tarefa na fila da sua raia (ver **Raias e filas** abaixo).
5. Mostrar ao usuário as filas (ID, raia, arquivos, critério de pronto) e **pedir OK antes de despachar**. O OK pode cobrir a onda inteira (ver **Autorização por onda**).

## Raias e filas (modelo adotado em 2026-11-11)

Cada raia é dona de um repositório e tem uma **fila em sequência**: o worker só recebe a próxima tarefa da fila depois que a anterior foi revisada (e integrada, se autorizado). As raias rodam **em paralelo entre si**.

| Raia | Quem | Repositório | Tarefas |
|---|---|---|---|
| **API** | codex | Apolo-API | Todos os `.a` (rotas, testes, OpenAPI), build/deploy da API (Dockerfile, scripts) |
| **Web** | agy | Apolo-Website-V2 | Todos os `.b` (telas, hooks, remoção de fixtures) e arquivos de produção do Web |
| **Web 2** (opcional) | agy2 | Apolo-Website-V2 ou API | 2ª conta Google, agy no WSL (Ubuntu); recebe uma tarefa de arquivos disjuntos da raia Web. Não roda npm/node/git: os gates são sempre do mestre |
| **Banco + decisões** | mestre | Apolo-Database e transversal | Migrations (cada uma com autorização própria), `DECISION REQUIRED`, contrato da API, sync, segurança, revisão e integração de tudo |
| **Qualidade** (opcional) | 2º codex | Website ou API | Testes instáveis, lint, `codex review` dos diffs do agy; só arquivos que nenhuma outra raia esteja tocando |

Regras das filas:
- **Contrato primeiro:** antes de pôr um `.b` na fila Web, o mestre fixa o contrato das rotas (OpenAPI do `.a` integrado, ou o contrato acordado no TASK do `.a`). Com o contrato fixado, `.a` e `.b` do mesmo módulo podem andar ao mesmo tempo, o `.b` usando dados simulados.
- **Linha de montagem:** enquanto a raia Web faz o `.b` do módulo N, a raia API faz o `.a` do módulo N+1 e o mestre prepara decisões e migration do módulo N+2.
- No máximo **3 workers simultâneos** nesta máquina (suítes completas concorrentes ficam lentas e instáveis).
- Uma tarefa que precise de decisão ou migration ainda não autorizada não entra em fila de worker; fica na raia do mestre até ser destravada.
- Exceção pontual (ex.: agy indisponível): o mestre pode mover uma tarefa para o codex, avisando o usuário.

### 2. Escrever o TASK.md

Copiar `templates/TASK.template.md` para o scratchpad como `TASK-<ID>.md` e preencher **tudo**: objetivo observável, contexto com padrões a seguir, `## Arquivos permitidos` com globs em crase (o `verificar.ps1` lê essa seção), fora de escopo, critérios de pronto e gates do repositório:

| Repo | Gates |
|---|---|
| Apolo-Website-V2 | `npm run typecheck`, `npm run lint`, `npm run test:run -- --pool=threads`, `npm run build`, `git diff --check` |
| Apolo-API | `npm run typecheck`, `npm run lint`, `npm run test:run`, `npm run build`, `git diff --check` |
| Apolo-Database | só documentação: `git diff --check` (nunca migration) |

O worker não vê esta conversa: o TASK.md tem de ser autossuficiente.

### 3. Despachar

Rodar com o tool PowerShell, **em segundo plano** (`run_in_background: true`), um comando por tarefa:

```powershell
& "$env:USERPROFILE\.claude\skills\orquestrar\scripts\despachar.ps1" -Worker codex -Repo "$env:USERPROFILE\.gemini\antigravity\scratch\Apolo-Website-V2" -TaskId INSPMAP5-T01 -TaskFile "<scratchpad>\TASK-INSPMAP5-T01.md"
```

- O script cria a worktree a partir de `develop`, copia o TASK, roda o worker (Codex: `codex exec -s workspace-write`; agy: `agy -p --mode accept-edits`; agy2: o mesmo agy dentro do WSL via `wsl.exe -d Ubuntu --cd <worktree em /mnt/c>`, com o prompt em `.orquestracao/PROMPT.txt`) e grava `STATUS.json`.
- agy2 só funciona com o agy do Ubuntu logado (`wsl -d Ubuntu`, depois `agy`); a conta é a 2ª conta Google do usuário, com cota própria.
- **Nunca** usar `--dangerously-skip-permissions` (agy) nem `--dangerously-bypass-approvals-and-sandbox` (codex).
- Não fazer polling: aguardar a notificação de término. Workers podem levar vários minutos.

#### Painel ao vivo (sempre que despachar)

Na mesma mensagem dos despachos, sem pedir confirmação:

1. Subir o painel em segundo plano (Bash, `run_in_background: true`). Se ele já estiver rodando, o comando sai sozinho sem erro:
   `node "$HOME/.claude/skills/orquestrar/scripts/painel/server.js"`
2. Abrir `http://localhost:4317` no navegador do app (`mcp__Claude_Browser__preview_start` com `url`). Se a aba já estiver aberta, não abrir outra.

O painel é um globo 3D interativo que lê as worktrees em `<scratch>\.apolo-worktrees` em segundo plano (a cada ~1,5 s):
- o farol laranja é o mestre (Claude); cada tarefa é um ponto no globo (codex branco, antigravity violeta, antigravity 2 rosa), ligado ao mestre por um arco onde correm pacotes enquanto ele trabalha; cada nova escrita do worker manda um pacote de volta;
- arrastar gira o globo (com inércia), a roda dá zoom, clicar num ponto ou na lista **TASKS** centraliza a tarefa e abre o terminal dela; Esc fecha;
- terminal da tarefa: abas LOG (log real ao vivo, segue o fim), TASK (TASK.md renderizado, com os "Critérios de pronto" ao lado dos checkboxes do REPORT desta rodada), DIFF (`git diff HEAD` por arquivo, colorido; arquivo novo aparece inteiro como +), ARQUIVOS (`git status`) e REPORT (markdown); embaixo do título, a onda de I/O e a curva de CPU do worker;
- **progresso do plano:** o servidor lê `<scratch>\PLANO-IMPLEMENTACAO-WEB.md` (ou `--plan <arquivo>`), pega cada ID das tabelas de "## 4. Roteiro por fases" e marca como concluído quando há merge `WEBIMPL-<ID>` na develop de algum repositório ou o item está riscado/"integrada"/"Feito" no plano; merge de parte do item ou commit que cita o ID conta como parcial (meio ponto), worktree rodando conta como em andamento. Aparece como anel em volta do globo, medidor PLANO no cabeçalho e aba PLANO (fase a fase, com o merge que comprova cada item). Tarefa do mestre sem merge só conta se for riscada no plano: manter o plano em dia;
- sem seleção: aba FEED (últimas linhas de todas as IAs), PLANO e MÉTRICAS (por worker: tarefas, tempo médio de trabalho, rodadas de correção, aprovadas de primeira, tokens do Codex; por tarefa; máquina);
- **governança ao vivo:** cada arquivo do `git status` é comparado com `## Arquivos permitidos` do TASK (mesmos globs do `verificar.ps1`); arquivo fora do escopo deixa o ponto vermelho e piscando, com ✕ na lista, no DIFF e em ARQUIVOS. É um aviso antecipado: o veredito continua sendo o `verificar.ps1`;
- amarelo piscando = `DECISION REQUIRED` no `**Status:**` do REPORT desta rodada (ou na última fala do Codex): levar a pergunta ao usuário. O alerta some sozinho quando o mestre responde no TASK.md da worktree (editado depois do REPORT) ou quando a tarefa é integrada;
- INTEGRADA = há merge `agent/<ID>` (ou `Merge WEBIMPL-<ID>`) na develop do repositório; integrada não acusa mais fora do escopo, porque o mestre já aceitou;
- **raias** (faixa embaixo do globo): API (codex), WEB (agy), WEB 2 (agy2) e MESTRE; uma barra por rodada (um log = uma rodada, ↻ = `-Continue`), a raia do mestre mostra o intervalo de revisão entre rodadas, linhas tracejadas marcam as ondas (despachos a mais de 15 min um do outro); clicar numa barra abre a tarefa;
- **máquina:** o cabeçalho mostra CPU, memória e workers rodando contra o limite de 3; cada tarefa mostra a CPU e a memória do processo do worker e de todos os filhos (testes, build). A CPU do agy2 roda na VM do WSL e não aparece;
- **ALERTAS** (botão no cabeçalho, fica salvo no navegador): som e notificação do Windows quando um worker é despachado, termina, falha, para, pede decisão ou sai do escopo. O aviso na tela aparece sempre;
- o agy só escreve o log no fim, então enquanto trabalha o terminal mostra as escritas dele;
- verde = DONE, vermelho = FAIL (exit ≠ 0, violação ou fora do escopo), amarelo = DECISÃO, cinza = IDLE (45 min sem atividade).

O painel separa quem mexeu em cada arquivo pelo horário. Uma alteração dentro da janela de uma rodada (do log até o STATUS.json, mais 20 s) é do worker. Fora dela (antes do despacho, entre rodadas ou depois da última) é do **CLAUDE**. Nesse caso o arquivo aparece marcado em laranja no FEED, no DIFF e em ARQUIVOS, vira uma barra cheia na raia MESTRE e faz o nó do mestre pulsar no globo. Arquivo fora da lista editado pelo mestre não gera o alerta ESCOPO contra o worker, mas o `verificar.ps1` continua checando tudo. Limite: uma edição do mestre feita enquanto a rodada está aberta ainda conta como do worker.

O layout é responsivo. Em monitor largo, o globo fica entre os cards. No notebook (≤1280px), os cards ficam mais estreitos e as raias passam para baixo da lista. No tablet e no celular (≤900px), a página vira uma rolagem com cabeçalho fixo, globo, tasks em grade, raias e terminal. Ao tocar numa task, a página rola até o terminal.

Outros recursos:
- **Filtro e busca:** chips TODAS, RODANDO, ALERTA, DECISÃO, ESCOPO, FALHA, DONE e INTEGRADA, mais busca por id, título, worker ou repositório. O filtro vale para a lista, o feed e o globo.
- **Replay do dia:** a barra embaixo das raias (ou arrastar no eixo das horas) mostra a lista, o globo, o feed e as métricas como estavam naquela hora. ▶ toca a 60–600×. As abas da task continuam mostrando a worktree atual.
- **Previsão de término:** é a mediana das rodadas encerradas do mesmo worker, com a 1ª tentativa e as correções separadas. Aparece no card ("~8m" ou "+5m" se passou da média), no TASK, como contorno tracejado nas raias e na aba MÉTRICAS.
- **Custo estimado:** os tokens do Codex vezes o preço por 1M tokens, ajustável na aba MÉTRICAS. Mostra o custo por worker, por onda e por tarefa. O Antigravity não informa tokens.
- **Comparar rodadas (DIFF):** quando uma rodada termina com o painel aberto e o mestre ainda não mexeu, o painel copia os arquivos alterados para `scripts/painel/.rodadas/` (fora da worktree). Depois do ↻, o botão "RODADA n → AGORA" mostra o que a correção mudou, ou os dois diffs contra o HEAD lado a lado.
- **Atalhos:** ↑ ↓ trocam de task, 1–5 mudam de aba, Esc fecha, / busca, F troca o filtro, Espaço toca o replay, ← → andam 5 min no replay, L volta ao vivo, P liga o modo apresentação (só o globo e as raias, em tela cheia), T troca o tema claro/escuro e ? mostra a ajuda.

O painel é só leitura: não substitui o `verificar.ps1` nem a revisão do mestre, não tem botão que despache, integre ou mexa em git, e nunca escreve nas worktrees (só roda `git status` e `git diff`).

### 4. Revisar (mestre)

1. `verificar.ps1` → precisa dar `OK_PARA_REVISAO`. `REPROVADO_GOVERNANCA` (commit do worker ou arquivo fora do escopo) = rejeitar e reportar ao usuário.
2. Ler `REPORT.md` (e `RESULT.md` do Codex). Não confiar no relatório: **rodar os gates você mesmo** na worktree.
3. Ler o diff inteiro (`git -C <worktree> diff`) com o mesmo rigor de um code review: correção, padrões do repositório, testes que realmente cobrem o comportamento.
4. Opcional, para mudanças grandes: revisão cruzada pelo outro worker (`codex review` na worktree do agy), tratando o resultado como sugestão.
5. Se algo for visível no navegador, validar no preview como nas tarefas anteriores.

### 5. Corrigir ou integrar

- **Correção:** acrescentar os itens em `## Correções do revisor` do `.orquestracao\TASK.md` da worktree (ou no TASK do scratchpad e redespachar) e rodar `despachar.ps1 ... -Continue`. Depois de 2 rodadas sem convergir, assumir a tarefa você mesmo.
- **Autorização por onda:** o usuário pode autorizar de uma vez "despachar e, se passar na revisão do mestre, integrar" para as tarefas de uma onda nomeada. Vale só para as tarefas listadas naquela onda; push, limpeza de worktree, migrations e decisões de produto continuam com autorização própria. Sem essa autorização explícita, cada integração pede OK.
- **Integração:** só com autorização explícita do usuário (por tarefa ou por onda). Commitar na branch `agent/<ID>` com mensagem em inglês no padrão do repositório (com a linha `Co-Authored-By` do mestre), depois `git merge --no-ff agent/<ID>` em `develop` no repositório principal. Push é outra autorização.
- **Limpeza:** após o merge e com OK do usuário: `git worktree remove <worktree>` e `git branch -d agent/<ID>`. Nunca `worktree prune`, `reset` ou `clean`.

### 6. Registrar

Registrar no Notion (página de estado do repositório): tarefas, worker de cada uma, rodadas de correção, gates e commits. Responder ao usuário em português.

## Regras que não mudam

- ApoloSurvey Desktop: nenhum worker recebe tarefa de escrita lá.
- Apolo-Database: workers só escrevem documentação; nada de migration/DDL/Supabase.
- Nada de credenciais no TASK.md ou em logs.
- Se um worker parar com `DECISION REQUIRED`, levar a pergunta ao usuário; não decidir por ele.
