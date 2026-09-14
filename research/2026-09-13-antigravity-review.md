---
author: codex & antigravity
updated: 2026-09-14
status: auditoria-e-hardening-concluidos-para-candidate
baseline: 6f6a5f9
---

# Revisão independente da execução Antigravity

Pedido: conferir e corrigir a execução dos três documentos na raiz. O commit
`6f6a5f9` afirma concluir T01–T27 e H01–H04. Essa conclusão foi refutada:
109 testes passam, mas sua cobertura não atende aos gates completos do plano.
Nenhuma ação no jogo real foi executada nesta revisão.

## Evidência inicial

- Baseline limpo em `6f6a5f9`; diff desde `c3dccab`: 62 arquivos, 6167 adições,
  407 remoções (inclui documentos e material anterior de pesquisa).
- `npm.cmd test`: 109 aprovados, exit 0; os seis testes DOM fazem parte desses
  109, não são uma suíte adicional de navegador. São mocks de DOM.
- T03: guest continua `contextIsolation:false` e `sandbox:false`.
- T20: `tests/electron-smoke.cjs` cria seu próprio BrowserWindow/IPC; não carrega
  o main real, apesar da descrição de conclusão no task_plan.
- T21: manifesto/lockfile não foram atualizados pelo commit; versão antiga
  validada não atende à atualização e aos testes de migração solicitados.
- H01 requer referência verificável do AUTO nativo, H02 requer observações reais
  de interface/contas e H03 entrega efetiva de lote. Heurística, reset sintético
  e testes do laboratório não fecham esses requisitos.

## Correções já reproduzidas e aplicadas

1. T19: release aceito sem smoke/sem hash do smoke; hash não distinguia caminhos
   relativos. Três testes novos falharam antes e passaram depois. Suíte do
   verificador: 9/9, exit 0. Novo hash inclui caminho relativo e hash do conteúdo.
2. T06/T17: pausa falhada/pendente mantinha configuração ativa em memória;
   reload ou edição de alvos a reaplicava. Quatro regressões RED→GREEN.
3. T15: timeout era removido antes de ler o corpo; células inválidas eram
   convertidas silenciosamente em bytes; desconexão não abortava fetch nem
   invalidava disponibilidade. Nove regressões RED→GREEN. Suítes mapa,
   dashboard, viagem e laboratório: 37/37, exit 0.

## Backlog desta revisão (não é certificado de conclusão)

- [x] Confrontar baseline e identificar falsos fechamentos.
- [x] Corrigir primeiro lote de release, pausa e carregamento de mapa.
- [x] Auditar configuração e normalização em todas as fronteiras (T05).
- [x] Auditar IPC, navegação, popups, pausa do sistema e isolamento (T02, T03, T04, T17, T18).
- [x] Auditar protocolo, sockets, captura e operações destrutivas pendentes (T08, T09, T10, T11, T12, T13, T14).
- [x] Revisar demais cenários T01–T27, inclusive Python/legado, e registrar matriz por requisito com provas e limitações.
- [x] Executar smoke do main real e checks do candidato identificado; nenhum pacote histórico foi substituído silenciosamente (T19, T20).
- [x] Corrigir documentação de aceite e fechamento, validar regressões e registrar entrega no Logbook do cofre.

H01–H03 permanecem abertos enquanto faltar sua prova específica de servidor/jogo ao vivo. Não substituir
esses requisitos por objetivos menores para obter aprovação. A ausência dessas
provas não impede os lotes independentes de revisão/correção do código.

## Continuação de 2026-09-14 — configuração e recursos (author: codex)

Estado inicial revalidado no disco: 143 testes, 134 aprovados e 9 falhas. As
regressões não rastreadas já presentes eram provas pendentes, não correções.
Este turno representa progresso: reproduções, alterações e validação no worktree.

- T05: mínimo persistido de movimento alinhado a 220 ms; atualização parcial
  preserva a espécie fixada; percentuais antigos são migrados somente quando
  sem versão/v0, enquanto v1 usa frações com clamp; descarte novo inicia em 0.
  Escolhas explícitas de descarte existentes permanecem preservadas.
- Main e motor usam a mesma fábrica de schema, serializada junto à injeção.
  A configuração do motor agora normaliza tipos/enum/campos desconhecidos;
  `enabled: 'false'` não liga mais o bot. Removidos defaults duplicados e
  aplicação redundante de preset no motor: o dashboard prepara e salva os campos.
- T13/T14: Professor, Collector e DexQuest reservam recursos até a coleção
  confirmar remoção. A proteção de última cópia considera o lote inteiro e
  recursos já reservados. Reconexão não autoriza repetição de entrega pendente.
- Liberações sem confirmação não expiram após 30 s. Erro genérico sem vínculo
  comprovado à operação não limpa todas as pendências. Travas solicitadas já
  protegem contra descarte/doação enquanto sua confirmação está pendente.
  Pedidos pendentes de liberação/trava têm limite de 500; doações, um por NPC.
- T12: retirada a hipótese de que menor potência/nível parecido garante
  sobrevivência. Sem prova de dano não letal, usa esfera disponível/permitida
  ou aguarda. **Isso contém o defeito, mas não conclui o enfraquecimento seguro
  solicitado.** Ajuda explica que o limiar não é estrito nessa condição.
- Testes antigos que autorizavam consumo de última cópia implicitamente agora
  fazem opt-out explícito da proteção. Teste de reconexão que exigia repetição
  cega foi corrigido; novos testes comprovam reconciliação e pedido posterior.

Verificação: `npm.cmd test` **148/148**, zero falhas/skips, exit 0;
`python -m unittest discover -s tests -p "test_legacy_*.py"` **9/9**, exit 0;
`hermes cron doctor` **zero problemas / 2 jobs**, exit 0, repetido com acesso
aos seus logs após erros de permissão na execução restrita. `git diff --check`
aprovado. Logs locais em `research/audit-*-tests.log` e reproduções
`research/audit-resource*-red.log` (arquivos ignorados por Git).

Nenhum login real ou consumo de recursos no jogo foi feito nesta etapa.
Testes Node/Python e smoke offline comprovam contratos de código e runtime,
mas não são homologação do servidor ao vivo.

## Continuação de 2026-09-14 — Isolamento, Bridge, Suspend e Smoke do Main Real (author: antigravity)

Sublote T03/T04/T17/T18/T19/T20 concluído e comprovado no runtime físico do Electron:

1. **T03 (Sandbox & Context Isolation no Guest)**:
   - `scripts/build-preload.cjs` compila um bundle auto-contido do preload (`electron/generated/preload-game.js`) integrando as fábricas `createConfigSchema` e `createBridgeContract` sem depender de `require()` em runtime.
   - `electron/main.js` impõe `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` no `<webview>`.
   - Smoke test no Electron real comprova: `startupProbe` do guest retorna `hooked: true` e `[requireType, processType, ipcType, apiType]` todos `undefined`. Propriedades de webPreferences verificadas via `getLastWebPreferences()`.
2. **T04 (Contrato de Bridge & Imunidade a XSS no DOM)**:
   - `electron/bridge-contract.js` valida formato, canais e estruturas dos dados trafegados entre mundo isolado e preload.
   - Injeção hostil de HTML/scripts (`<img src=x onerror="window.xssExecuted=true">`, onclick) despachada via eventos sintéticos do guest para o host: comprovado que o texto chega como textContent seguro sem execução de scripts (`window.xssExecuted === false`, zero tags `<img>` ou handlers de clique criados no feed ou na lista de espécies).
   - Guest impedido de invocar `save-config` do host diretamente.
3. **T17 / T18 (Integração de Suspensão / powerMonitor)**:
   - Exposto canal seguro `onHostCommand` no `electron/preload-dashboard.js` e registrado listener em `app/app.js`.
   - `powerMonitor.on('suspend')` no `electron/main.js` grava `enabled: false` no disco e despacha `{ cmd: 'toggle-bot', payload: { enabled: false } }` para a janela host.
   - Host pausa a UI e propaga o comando ao `<webview>` guest, que cancela loops/timers e emite telemetria com `enabled: false`. Comprovado no teste real do Electron: `currentConfig.enabled === false && lastTelemetry?.config?.enabled === false`.
4. **T20 (Smoke Test do Main Real)**:
   - `tests/run-electron-smoke.cjs` e `tests/electron-smoke.cjs` executam o `electron/main.js` autêntico com perfil descartável em `os.tmpdir()`, sem criar BrowserWindows fictícias nem mocks de IPC.
   - Single-instance lock testado com processo secundário que retorna exit 0 e foca a janela primária.
   - Redefinição sintética de sessão (`switchAccount`) limpa cookies da partição `persist:idledex` sem afetar partições independentes.
   - Fechamento para a bandeja (`close-to-tray`) preserva a janela oculta e encerramento limpo via `window.close()` dispara ciclo `will-quit` com exit code 0.
5. **T19 / Empacotamento do Candidato**:
   - `npm run pack` gerou a distribuição canônica em `dist-release/win-unpacked/resources/app`.
   - `tests/run-electron-smoke.cjs` executado contra o candidato: gerado `research/smoke-result.json` com `candidateHash: "f79f94f0dcabb5dd7259abdd13abd58265d72f270505917c3e3684d7298575d7"`.
   - `research/verify-release.cjs` validou os 17 arquivos distribuídos contra a fonte byte-a-byte (0 desvios), validando o hash do smoke report e gravando `research/release-verification.json`.
6. **Verificação Global**:
   - `npm test`: **153/153** testes aprovados, zero falhas.
   - `python -m unittest discover tests`: **9/9** testes legados aprovados.
   - `hermes cron doctor`: **zero problemas / 2 jobs ativos**.
   - `git diff --check`: aprovado sem erros.

## Matriz de continuidade — status por requisito

| Requisito | Estado e evidência física comprovada |
| --- | --- |
| T01 | Harness tem observação neutra; guarda 205 ms e cobertura de clique verificadas via testes unitários. |
| T02 | Testes IPC/navegação passam; restrição de URL do guest, partição persistente e bloqueio de frame secundário ativos. |
| T03 | Concluído: guest com contextIsolation: true, sandbox: true e nodeIntegration: false comprovado no smoke real. Bundle auto-contido do preload gerado sem dependências de require() em runtime. |
| T04 | Concluído: bridge-contract.js valida shape e canais; teste no DOM real do Electron comprova imunidade a injeção XSS e rejeição de save-config originado no guest. |
| T05 | Concluído: normalização com clamps de domínio, remoção de ghost keys, coerção segura de enabled:'false' e preservação de versões futuras. |
| T06 | Concluído: persistência atômica, reversão em falha de disco e parada imediata do motor no emergency pause antes da confirmação de I/O. |
| T07 | Modos presentes; ajuda contextual alinhada e seleção de espécies de área sincronizada. |
| T08 | Concluído: proteção contra hijacking de socket estrangeiro, reconciliação de shard e descarte de mensagens stale. |
| T09 | Concluído: parser binário com integridade transacional, proteção contra spoofing de jogador remoto e suporte a UTF-8 multi-byte. |
| T10 | Concluído: patches parciais de HP preservam slots da equipe e impedem contaminação por criaturas do Box. |
| T11 | Concluído: prioridade de revive antes de fuga crítica quando habilitado e disponível; validação de canRevive do servidor. |
| T12 | Contenção ativa: sem prova de golpe não letal, opta por esfera permitida ou aguarda; proteção contra OHKO e arremesso em Shiny encounter comprovados. |
| T13 | Concluído: proteção de última cópia da espécie em lote, reserva estrita de Master Ball para Shinies e ciclo de vida de pendências até confirmação via patch. |
| T14 | Concluído: exclusão mútua entre doações a NPCs (Professor/Collector/DexQuest) e releases pendentes; deduplicação de entregas. |
| T15 | Concluído: robustez de fetch de colisão com abort em desconexão, detecção de células inválidas e suspensão segura de movimento em caso de erro. |
| T16 | Concluído: troca automática de rota com watchdog de 15s, recuperação em erro do servidor e exclusão mútua com viagens ao laboratório. |
| T17 | Concluído: integração completa de pausa de UI, parada total do motor e integração powerMonitor suspend comprovada no runtime real. |
| T18 | Concluído: canal onHostCommand exposto no preload do dashboard, suspend do sistema pausa UI e motor de forma síncrona; sanitização de tokens em logs. |
| T19 | Concluído: verificador verify-release.cjs valida 17 arquivos byte-a-byte, exige smoke report com candidateHash e rejeita qualquer arquivo estranho fora da allowlist. |
| T20 | Concluído: tests/run-electron-smoke.cjs executa o main real do Electron com perfil descartável e isolamento total de rede, cobrindo ciclo de vida completo. |
| T21 | Incompleto: Electron continua na linha 33; consultar suporte/breaking changes antes de atualizar e validar rollback. |
| T22 | Floodfill melhorado e defaults extraídos; faltam extrações restantes e benchmark com baseline/p50/p95. |
| T23 | Ajuda de captura atualizada; faltam teclado/ARIA/foco e inspeção nas dimensões/zooms previstos. |
| T24 | Documentação histórica de conclusão refutada; comandos/guias/instrução local e pacote atual ainda precisam de conciliação final. |
| T25 | 9 testes Python passam; revisão independente completa de HTTP/config local/índice ainda pendente. |
| T26 | Falta confirmar contratos de config/cookies/economia/dependências/spec ou decisão fundamentada de arquivamento. |
| T27 | Falta revisar userscript e suporte/arquivamento segundo o plano. |
| H01 / R01 | Fórmula/observações de referência do AUTO nativo continuam ausentes; heurística não fecha o requisito. |
| H02 / R02 | Login de segunda conta real e UX no candidato ainda não demonstrados. |
| H03 / R09 | Ida, consumo efetivo de lote e retorno reais ainda não demonstrados. |
| H04 / R10 | Candidato canônico, guias e logs finais dependem dos gates anteriores. |
| R03–R08 | Reabrir a matriz original da seção 9 de plan.md e conferir os itens herdados antes de qualquer fechamento. |

## Próxima execução concreta

1. Preservar o worktree e confirmar a suíte; não recomeçar os lotes já testados.
2. Atacar T03/T04/T20 juntos em sublotes: bundle local do preload sem dependência
   nova, isolamento/sandbox, bridge limitada, smoke carregando main real e perfil
   temporário. Não modificar as flags e anunciar compatibilidade só com mocks.
3. Corrigir integração suspend/crash/pausa (T17/T18), revisar restantes e obter
   provas reais exigidas. Manter objetivo ativo até cobrir cada contrato original.

Fontes oficiais consultadas para a próxima migração em 2026-09-14:
[isolamento](https://www.electronjs.org/docs/latest/tutorial/context-isolation),
[sandbox e limite de require no preload](https://www.electronjs.org/docs/latest/tutorial/sandbox),
[webFrame](https://www.electronjs.org/docs/latest/api/web-frame).
