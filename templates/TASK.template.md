# TASK <TaskId> — <título curto>

**Repositório:** <Apolo-Website-V2 | Apolo-API | Apolo-Database>
**Worker:** <codex | agy>
**Branch base:** develop
**Checkpoint/Notion:** <link ou nome do congelamento de escopo>

## Objetivo

<O que deve estar verdadeiro ao final, em 2–4 frases. Comportamento observável, não implementação.>

## Contexto

- <Arquivos e padrões existentes que o worker deve seguir (ex.: AdminDialog, AdminButton, testes em *.test.tsx)>
- <Decisões já tomadas que não podem ser reabertas>

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados (globs relativos à raiz do repositório):

- `src/features/admin/<area>/*`
- `src/features/admin/<area>/**/*`

## Fora de escopo

- <O que parece relacionado mas NÃO deve ser feito>

## Proibições (governança Apolo)

- NÃO executar `git commit`, `push`, `merge`, `rebase`, `reset`, `clean`, `stash` nem `worktree prune`.
- NÃO rodar migrations, aplicar DDL nem alterar Supabase/bancos remotos.
- NÃO versionar credenciais, `.env` ou `.agents/mcp_config.json`; nada de `service_role` no browser.
- NÃO fazer hard delete de dados de domínio (somente soft delete).
- NÃO inventar fatos de produto: registrar como `DECISION REQUIRED` e parar.
- NÃO importar KML/KMZ no Mapa.

## Critérios de pronto

- [ ] <critério 1, verificável>
- [ ] <critério 2>
- [ ] Testes novos ou atualizados cobrindo o comportamento.

## Gates obrigatórios (rodar na worktree e colar o resultado no REPORT)

```bash
npm run typecheck
npm run lint
npm run test:run -- --pool=threads
npm run build
git diff --check
```

## Correções do revisor

<Vazio no primeiro despacho. O mestre acrescenta aqui os ajustes pedidos antes de um despacho com -Continue.>
