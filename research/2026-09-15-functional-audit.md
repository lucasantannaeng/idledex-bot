---
author: codex
updated: 2026-09-15
baseline: cd67b1a
version: 2.5.1
status: candidato-verificado-gates-reais-pendentes
---

# Revisão funcional: foco de captura e limpeza da Box

Luca confirmou que a lista de foco, limpeza da Box e outras funções falhavam
independentemente da forma de abertura. Os turnos anteriores produziram progresso:
reproduções e correções físicas no worktree. Não houve limpeza na conta real.

## Causas reproduzidas e correções

| Fluxo | Causa | Correção e evidência |
| --- | --- | --- |
| Foco de captura | ID numérico recebia `.trim()`; atualização de área comparava só quantidade | Conversão explícita de ID; comparação do conteúdo; smoke acompanha checkbox e pin até o motor |
| Lista e teclado | Troca de dados recriava checkbox focado | Restauração do foco e scroll; `focus-red-20260915.json` reproduz a falha anterior |
| Botão limpar Box | Não havia listener de clique | Listener real e salvamento dos critérios exibidos antes da ação; falha de save impede limpeza |
| IV individual | `change` do modo e `input` dos atributos não estavam ligados | Eventos abrem os campos e atualizam soma; smoke exige 31/186 (17%) |
| Abas | Código ainda procurava `onclick` removido | Usa `data-panel`; smoke exige aba Config ativa após clique |
| Última cópia | Seleção de lote ignorava outras criaturas já selecionadas | Reserva progressiva do lote; regressões mantêm uma cópia quando proteção ativa |
| Natureza e IV | Lookup por ID numérico e arredondamento do piso | Lookup por nome/espécie; percentual exato decide descarte |
| Capturas fora de ordem | Patch da coleção podia causar release antes da avaliação | Aguarda avaliação/trava; dados de natureza/nota ausentes não autorizam descarte ou doação |
| Pausa e recarga | Save pendente reativava motor; AUTO podia permanecer ativo | Invalidação da revisão; pausa de segurança de ambos os modos; guarda em memória se disco falhar |
| Troca de conta | Comando enviado a guest já destruído; ativação durante reset | Dashboard invalida guest; main recusa reativação enquanto limpa a sessão |
| Falha de gravação dos alvos | UI mantinha opções rejeitadas | Restaura lista, modo e os dois controles de comportamento |

`ui-audit-red-20260914.json` reproduz quatro controles quebrados no Electron real.
Os testes antigos chamavam funções diretamente e não detectavam os listeners
ausentes. A validação nova dispara os cliques/eventos no DOM real.

## Verificações locais

- `npm.cmd test`: 213 aprovados, zero falhas/skips; exit 0.
  Evidência: `regression-20260915.tap`.
- Python: 35 testes aprovados; exit 0. Evidência:
  `legacy-audit-final-20260915.log`.
- `git diff --check`: exit 0.
- Smoke do candidato aprovado em 15/09/2026 15:34:31 UTC com main real, sessão
  descartável, isolamento, IVs, limpeza, alvos/pin numéricos, preservação de foco
  e troca de sessão sintética. Relatório: `smoke-result.json`; imagem inspecionada:
  `smoke-result.png`. Nenhum erro de renderer registrado.
- Integridade: 17 arquivos conferidos, versão 2.5.1, exit 0. Hash do candidato:
  `b04bb6811b3da64bc4eaf722ed0c0fc872b2492e649633ad78a250bea1ba9327`.
  `release-verification.json` vincula código distribuído ao smoke aprovado.
- Build de pasta, portátil e instalador concluído com exit 0. Versões e SHA-256
  registrados em `artifacts-2.5.1.json`. `verify-installers.cjs` extraiu somente
  os arquivos da aplicação de ambos os executáveis e confirmou 17 arquivos com
  o mesmo hash do candidato; exit 0, `installer-verification.json`.
- Não foram usados relatórios de captura/laboratório de versões antigas como
  prova de comportamento no servidor para a 2.5.1.

## Legado preservado

Python: Host/Origin com porta exata, timeout de socket, limite de body, credenciais
ocultas, cookies string, erro HTTP 401 moderno, persistência atômica e tipos/faixas.
Economia: teto do score de IV e janela correta de dez preços. A spec usa a raiz
de seu próprio arquivo. O mínimo websockets foi alinhado à API usada, conforme
[migração oficial 14.0](https://websockets.readthedocs.io/en/14.2/howto/upgrade.html).
A variável de raiz da spec é documentada pelo
[PyInstaller](https://pyinstaller.org/en/stable/spec-files.html#globals-available-to-the-spec-file).

Userscript: constantes/protótipo/subclasses de WebSocket preservados, conexão
confirmada por welcome, timers cancelados ao pausar/trocar sessão/terminar batalha.
Seus sete testes incluem caracterização de envelopes antigos. Não se declara
compatibilidade do combate legado com o servidor atual. O executável Python não
foi reconstruído nem homologado.

## Requisitos ainda abertos

- H01/R01: referência verificável da grama nativa continua ausente.
- H02/R02: login/logout com segunda conta real não demonstrado; smoke é sintético.
- H03/R09: consumo efetivo de lote e retorno no laboratório não demonstrados.
- T21: migração do runtime Electron 33 ainda não executada.
- T22/T23: benchmark/extrações e matriz integral de dimensões/zoom do plano não
  se fecham pelos testes funcionais deste lote.
- T26/T27: distribuição Python e combate/userscript atuais não homologados.
- Gate de rotinas: `hermes cron doctor` executado com acesso aos logs retornou
  exit 1, duas falhas do job de memória (fallback de provedores e bot removido do
  grupo Telegram). Evidência: `cron-doctor-20260915.log`; nenhuma rotina alterada.

O objetivo permanece ativo. A entrega deste lote não encerra automaticamente os
requisitos herdados de `plan.md` e `task_plan.md`.
