---
title: "IdleDex Bot — instruções de correção verificadas"
author: codex
updated: 2026-09-13
baseline_commit: c3dccab
status: revisado-contra-repositorio-local
---

# IDLEDEXBOT — Guia de correções e limites de validação

Revisão em 13/09/2026, com leitura do código e execução da suíte local. **O documento original era parcialmente válido, mas continha instruções incompletas, APIs removidas, dependências omitidas e comportamentos já implementados apresentados como ausentes.** Esta revisão corrige as instruções; não implementa o backlog no bot.

Repositório: `D:\Projetos\1.Autorais\idledex-bot`. Este guia complementa o `plan.md` e o `task_plan.md` desse diretório. O plano mestre contém T01–T27, H01–H04 e a matriz R01–R10: a seleção detalhada abaixo não substitui nem encerra os demais requisitos. Havendo divergência, reconciliar pedido do usuário, fontes atuais e contrato da tarefa; não executar cegamente um registro histórico.

## 1. Pré-voo: estado observado, não garantia permanente

- HEAD observado: `c3dccab`; versão do aplicativo no `package.json`: **2.5.0**; Electron instalado: **33.4.11**. O intervalo declarado `^33.2.1` não é a versão exata instalada.
- `npm.cmd test`: **43 testes aprovados, 0 falhas, 0 cancelados e 0 skips; exit code 0**. Resultado desta revisão, não contagem obrigatória para futuros lotes. A suíte usa simulações e não comprova login, ações no servidor ou integridade do executável.
- Nove arquivos rastreados modificados: `electron/preload-game.js`, `app/app.js`, `app/help.js`, `app/index.html`, `tests/engine-harness.cjs`, `tests/engine.test.cjs`, `findings.md`, `progress.md` e `task_plan.md`.
- Itens não rastreados observados: `plan.md` e `idledex-security/`. Não adicioná-los automaticamente a um commit de movimentação.
- Preservar as alterações existentes e revisar o diff antes de consolidar qualquer lote. Testes verdes, sozinhos, não tornam todo o diretório pronto para commit.

### Movimentação: o que está comprovado

No código local, `stepInDirection` agenda `keyup` **40 ms** após `keydown`; o loop de patrulha limita o intervalo a pelo menos **220 ms** e verifica **205 ms** entre execuções pelo seu caminho de movimento. A interface aplica mínimo de 220 ms. Esses valores são escolhas locais de implementação; temporizadores reais não garantem disparo pontual sob carga.

O bundle histórico `research/index-BPTg-fzT.js` contém `Cn=200` e a guarda `performance.now() - this.lastSentAt < Cn` no envio de movimento. Isso sustenta a origem técnica dos 200 ms **na cópia local inspecionada**. Não foi conferido o bundle atualmente servido pelo site, nem se trata de prova de limite do servidor ou de que 40 ms garante um passo por pulso em toda condição.

**Lacuna do teste novo:** apesar de o nome citar cooldown de 205 ms, ele só exige a existência de eventos e compara o primeiro `keyup` com o primeiro `keydown` em 40 ms. Não compara passos consecutivos nem exercita diretamente a rejeição abaixo de 205 ms. Antes de declarar o cooldown validado, acrescentar cenário observável que cubra essa guarda, além do intervalo mínimo de 220 ms. Não basta testar passos já espaçados por um timer de 220 ms.

### Comandos de inspeção e baseline

```powershell
Set-Location -LiteralPath 'D:\Projetos\1.Autorais\idledex-bot'
git status --short
git rev-parse --short HEAD
git diff --stat
git diff --check
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Baseline reprovada; investigar antes de prosseguir.' }
```

`git diff --check` verifica problemas de whitespace; não valida lógica. Registrar quantidade real, falhas, skips e exit code. O guia anterior ordenava `git add`/`git commit` imediatamente após 43 testes; essa ordem foi retirada porque o lote inclui trabalho preexistente e o teste não cobre tudo o que seu título anuncia. Após revisão e autorização aplicável, consolidar apenas arquivos/hunks pertinentes, revisar `git diff --cached` e usar Conventional Commits em inglês.

## 2. Dependências e continuidade obrigatória

Antes dos lotes do motor, tratar **T01**: `state()` do harness atualmente envia `update-config` e, portanto, observar estado pode alterar o comportamento. O plano exige observação neutra. Não usar essa função para provar ausência de efeitos sem levar isso em conta.

| Tarefa detalhada neste guia | Dependências do `plan.md` |
| --- | --- |
| T02, T04, T25 | Nenhuma; T25 tem alcance no legado Python |
| T08 | T01 |
| T09 | T01, T08 |
| T10 | T01 |
| T11 | T10 |
| T13 | T05, T09, T10 |
| T14 | T13 |
| T15 | T09 |
| T16 | T08, T14, T15 |
| T19 | Pode iniciar preparação; release final aguarda correções aplicáveis e gates de distribuição |
| H03 | T13, T14, candidato identificado e autorização aplicável para consumo real |

O recorte anterior não incluía tarefas necessárias: **T03** (isolamento), **T05–T07** (configuração, persistência e seleção), **T12** (captura), **T17–T18** (pausa e recuperação), **T20–T21** (smoke/CI e runtime), **T22–T24** (manutenção, interface e documentação) e **T26–T27** (legado, se mantido). Consultar seus contratos no plano antes de fechar dependências ou anunciar estabilização completa.

Preservar ainda: **H01**, prova da grama nativa; **H02**, interface e contas reais; **H03**, entrega efetiva no laboratório; **H04**, documentação e distribuição canônica. Testes sintéticos não encerram requisitos de observação real. Conferir a matriz **R01–R10** no `plan.md` e as pendências do `task_plan.md` sem apagar o histórico.

## 3. Roteiro de correções verificado

Os itens seguintes distinguem achado, implementação existente e trabalho proposto. Critérios de aceite são requisitos futuros, salvo quando explicitamente descritos como testes já executados.

### T02 — IPC, navegação, anexação e permissões (P0)

**Achado confirmado:** `get-config`, `save-config`, `minimize-to-tray` e `toggle-fullscreen` não validam remetente/frame. `switch-account` já verifica `event.sender` e `event.senderFrame`. Falta política explícita de navegação, janelas e permissões. Isso identifica superfície de risco; não demonstra exploração.

**Arquivos:** `electron/main.js`, `tests/main.test.cjs`, novo `tests/security.test.cjs`; ajustes no HTML em sublote se necessários para popups.

1. Reutilizar em todos os IPCs a validação de janela existente e não destruída, `event.sender === mainWindow.webContents` e frame principal exato. Tratar `senderFrame` ausente como rejeição, sem lançar erro por janela nula. Validar também o payload conforme T05.
2. Em `will-attach-webview`, validar proprietário, `params.src`, partição esperada `persist:idledex` e opções/preload permitidos. O código atual força o preload em qualquer webview anexado sem essas verificações.
3. Separar a navegação do dashboard local, carregado por `loadFile(app/index.html)`, da navegação remota do guest. O dashboard deve permanecer no documento local autorizado. No guest, usar `new URL`, protocolo, origem/host e porta exatos; `https://idledex.com` é origem observada e `https://accounts.google.com` aparece no fluxo OAuth local. A lista completa de redirecionamentos OAuth depende de evidência. Não usar sufixos permissivos nem permitir todo domínio Google.
4. Registrar os eventos de navegação/redirecionamento nos `webContents` apropriados e validar também URLs passadas pelo aplicativo a métodos de navegação. `will-navigate` sozinho não cobre todo caminho de carregamento programático. Usar `webContents.setWindowOpenHandler()` no processo principal, inclusive no guest obtido na anexação. **`new-window` de WebContents e de `<webview>` foi removido no Electron 22**, portanto não é API válida para o Electron 33 instalado. Controlar popups/OAuth com política explícita e preservar a partição correta. [Mudanças oficiais](https://www.electronjs.org/docs/latest/breaking-changes#removed-webcontents-new-window-event), [API webContents](https://www.electronjs.org/docs/latest/api/web-contents).
5. Configurar `setPermissionRequestHandler` e `setPermissionCheckHandler` nas sessões relevantes, inclusive a partição persistente do jogo, negando por padrão. Só admitir exceções demonstradas por origem, frame e tipo; áudio de reprodução não justifica conceder captura de microfone, nem notificações devem ser autorizadas automaticamente. [API Session](https://www.electronjs.org/docs/latest/api/session#sessetpermissioncheckhandlerhandler).

**Aceite:** guest, subframe, remetente ausente e janela estranha não controlam o host; host parecido, URL com credenciais/porta inesperada e popup indevido são rejeitados; dashboard carrega e fluxo autorizado permanece funcional. Mocks não provam login real. T02 também não substitui T03: `contextIsolation: false`/`sandbox: false` do guest exigem migração da bridge, não apenas troca de flags. [Segurança do Electron](https://www.electronjs.org/docs/latest/tutorial/security).

### T04 — Telemetria e renderização contra XSS (P0)

**Achado confirmado com correção de alcance:** `renderAreaSpecies` interpola frequência e níveis em HTML e insere ID escapado em `onchange="onAreaSpeciesToggle(...)"`. `escapeHtml` não resolve o contexto de JavaScript dentro de atributo. Nomes e mensagem do log já passam por `escapeHtml`; é incorreto afirmar que todas essas strings entram sem escape. O preload também encaminha canais de `CustomEvent` sem allowlist.

**Arquivos, divididos em sublotes:** `electron/preload-game.js`, `app/app.js`, `app/index.html`, `tests/dashboard.test.cjs` e novo teste DOM.

1. Validar canais e formato/tamanho dos dados na bridge; aceitar somente telemetria/log documentados.
2. Construir conteúdo dinâmico com nós DOM e `textContent`; usar `addEventListener` em vez de IDs dentro de handlers inline. Auditar níveis, frequência, última captura e outros campos interpolados, preservando os escapes que já funcionam até a substituição.
3. Validar tipo, finitude e domínio de números antes da renderização; `Number.isFinite` sozinho não impede valores finitos fora da faixa. Normalizar IDs na fronteira.
4. Migrar handlers inline antes de endurecer a CSP, preservando botões, seleção e tutorial.

**Aceite:** aspas, tags e handlers sintéticos aparecem como texto e não executam; canais desconhecidos não chegam ao host. Teste em DOM real offline é necessário: o harness atual de dashboard não interpreta HTML suficiente para provar ausência de XSS. Executar também `node --test tests/dashboard.test.cjs`.

### T25 — Conter o legado Python e retirar configuração pessoal do Git (P0 no legado)

**Achado confirmado:** `bot.py` usa `HTTPServer(("0.0.0.0", p), ...)`, CORS `*` e endpoints mutantes sem autenticação. `config.json` é rastreado e não está protegido pelo `.gitignore`. Esses achados afetam o legado quando iniciado; não significam que o Electron abra a porta HTTP ou que credenciais tenham sido vazadas. Esta revisão não auditou valores de tokens nem todo o histórico Git.

**Arquivos por sublote:** `bot.py` e testes Python; depois `.gitignore`, novo `config.example.json` e documentação.

1. Manter o legado desativado enquanto se prepara hardening. Usar bind `127.0.0.1`, autenticação local efêmera nas operações mutantes, validação de `Origin`/`Host`, limites de corpo e timeout. Restringir CORS às origens realmente suportadas. **Loopback sozinho não autentica requisições e não impede acesso por páginas maliciosas.**
2. Criar exemplo com o schema real, defaults válidos e campos de credenciais vazios, sem copiar tokens pessoais. Adicionar `config.json` ao ignore.
3. Preservar a cópia local antes de `git rm --cached -- config.json`; conferir que o arquivo continua no disco e revisar a remoção somente do índice com `git diff --cached --name-status`. Não usar `--force` para contornar conflito sem investigar. A mudança do índice só passa a valer no repositório compartilhado após commit revisado.
4. Retirar do índice não apaga versões passadas. Caso se faça varredura de histórico, emitir somente metadados sanitizados; rotação depende de exposição comprovada. Não prometer “expurgo de segredos” apenas com `.gitignore`.

**Aceite:** teste HTTP isolado com fake bot prova que origem não autorizada/ausência de autenticação não altera configuração; cópia pessoal permanece local e fora de novos commits normais. Criar os testes antes de usar `python -m unittest discover -s tests -p "test_legacy_*.py"`; descoberta vazia não é validação.

### T08 — Selecionar o WebSocket do jogo (P1)

**Achado confirmado:** `HookedWebSocket` promove toda nova instância a `activeWs` e incrementa `commandGeneration` antes de validar conexão. Já existem verificações `activeWs !== ws` e controle de geração para eventos/callbacks antigos; preservar essas proteções.

**Arquivos:** `electron/preload-game.js`, `tests/engine-harness.cjs`, `tests/engine.test.cjs`; após T01.

1. Identificar endpoint e handshake a partir de evidência sanitizada. A URL fixa do mock não prova endpoint atual de produção. Não registrar querystrings de autenticação.
2. Combinar validação da URL com reconhecimento do handshake de gameplay antes de trocar a sessão ativa. URL plausível ou socket recém-construído não bastam; socket secundário ou abertura malsucedida não deve invalidar uma sessão saudável.
3. Preservar constantes/prototype/comportamento nativo do WebSocket e invalidar ações antigas no ponto correto da troca. Cobrir reconexão e `shard:redirect` sem inventar formato de mensagem.

**Aceite:** dois sockets, conexão sem `welcome`, endpoint estranho, close atrasado e shard válido exercitados em testes. Comandos chegam somente à sessão confirmada; callbacks/timers obsoletos não agem. Suíte do motor e laboratório aprovadas.

### T09 — Parser binário e identidade transacionais (P1)

**Achado confirmado:** `parseBinaryFrame` atualiza `moveSeq` antes de terminar o parse e pode atualizar `playerPos` antes de descobrir truncamento posterior. Aceita identificação genérica por `includes("self")`/`includes("player:")`, além do ID exato.

**Arquivos:** `electron/preload-game.js`, testes de protocolo/motor e harness em sublotes; após T01/T08.

1. Documentar o formato comprovado; validar tamanhos, flags, contagens e campos em estrutura temporária. Só aplicar ack/posição após a integridade do frame, conforme o contrato real. Não inventar rejeição de campos de extensão sem consultar o protocolo.
2. Usar identidade própria confirmada no `welcome`; não confiar em categoria genérica de jogador nem em ID antigo de `sessionStorage` após troca de sessão. Distinguir snapshot completo de delta.
3. Se Blob for necessário, tratar conversão assíncrona e conferir geração depois do `await`.

**Aceite:** truncamentos em todos os limites relevantes, outro jogador, flags inválidas conforme contrato, delta sem posição e resposta assíncrona antiga não alteram indevidamente estado. Criar `tests/protocol.test.cjs` antes de executar seu comando; manter a suíte existente.

### T15 — Carregamento de mapas, colisão e falhas (P1)

**Achado parcialmente confirmado:** falta timeout/`AbortController` e os erros são ignorados. **Já existem** `mapLoadVersion`, comparação de mapa e validação básica de dimensões; a suíte aprovada inclui respostas resolvidas em ordem inversa. Fetch assíncrono pendurado não bloqueia por si o event loop; pode manter a patrulha esperando indefinidamente, enquanto falha concluída pode liberar fallback sem malha.

**Arquivos:** `electron/preload-game.js`, testes de mapa/motor e registro de contrato; após T09.

1. Adicionar cancelamento efetivo e prazo definido no pacote da tarefa. **8–10 segundos era sugestão**, não regra oficial: escolher um valor único e testá-lo, inclusive no fallback de URL e leitura do corpo.
2. Preservar a guarda de versão; cancelar carga anterior na mudança de mapa, desconexão e encerramento pertinentes. Uma resposta cancelada/antiga não deve liberar `loadingMap` da requisição atual.
3. Em falha, expor “mapa indisponível”, impedir patrulha insegura e usar retry limitado com backoff, sem apagar pausa manual. Validar limites de tamanho, células e máscara de franja.
4. Distinguir transitabilidade de classificação heurística de grama. Robustez de fetch não comprova equivalência ao AUTO nativo; H01 permanece separado.

**Aceite:** 404/500, corpo inválido, timeout, cancelamento, ordem invertida e mapa sem grama têm comportamento explícito e limitado. Não anunciar algoritmo “oficial/genuíno” sem a evidência correspondente.

### T10 — Equipe e Box em patches parciais (P1)

**Achado confirmado:** `updateCreatures` primeiro deriva a equipe da coleção mesclada, mas substitui `team` por toda a coleção quando nenhum item do pacote recebido possui `teamSlot`. Um patch só de HP pode disparar o fallback, mesmo que os slots estejam corretos no estado anterior.

**Arquivos:** `electron/preload-game.js`, `tests/engine.test.cjs`; após T01.

1. Derivar a equipe do estado mesclado confirmado; patch ausente não equivale a remover slot. A coleção e `team` já existem: não é necessário impor uma nova estrutura imutável como pré-condição da correção.
2. Distinguir ausência de campo, `null` explícito e snapshot completo. Caso haja protocolo sem slots, dar-lhe tratamento próprio baseado em evidência, sem inferi-lo pelo último patch.

**Aceite:** patch de HP preserva líder e formação; Box não vira equipe; slot **0** é preservado; remoções seguem o protocolo comprovado. O teste existente de equipe/patch não cobre sozinho o caso problemático; acrescentar cenário específico.

### T11 — Revive antes da fuga por HP crítico (P1)

**Achado confirmado:** a fuga por `myHpPct <= flee_hp_pct` vem antes do bloco de revive. A função de revive já existe; o problema é sua precedência e os estados em que é alcançável.

**Arquivos:** `electron/preload-game.js`, `tests/engine.test.cjs` e ajuda se o contrato mudar; após T10.

1. Quando o líder estiver desmaiado, `use_revive_battle` estiver habilitado, **`canRevive` permitir**, a janela de ação estiver aberta e houver `revive`/`max-revive`, avaliar o item antes da fuga por HP.
2. Sem revive utilizável, seguir somente ação permitida pelo servidor. Estoque sozinho não autoriza o comando; não remover travas de animação ou ação única. Tratar separadamente fugas por filtro de espécie e ausência de bolas, sem mudar essas políticas incidentalmente.

**Aceite:** HP 0/1/limiar, flag desabilitada, estoque zero, `canRevive=false`, animação, troca de líder e confirmação atrasada testados; nenhuma repetição indevida ou gasto por loop.

### T13 — Proteções de coleção, confirmação de descarte e Master Ball (P1)

**Achado com correções de nomenclatura:** `isProtectedCreature` **já existe**, protegendo shiny, `isLocked`, líder, mega, evento, qualquer `teamSlot` não nulo e membros de `team`. `hasCompleteIVs` já bloqueia liberação/doação de IVs incompletos. O guia anterior usava `is_locked` e slots “1 a 6”; o código usa `isLocked` e os fixtures incluem **slot 0**. Não introduzir aliases não observados. Não foi localizada a opção `auto_discard_duplicates` no motor/interface/testes inspecionados; a liberação usa `discard_iv_pct` e `checkMonIVStrategy`.

**Lacunas confirmadas:** não há proteção explícita da última cópia em `checkMonIVStrategy`; o ID entra em `releasedCreatureIds` e o log anuncia liberação antes de confirmação. `getBestBall` permite Master Ball como fallback para alvo não shiny. A viagem/doação já contém verificações de excedente, que devem ser preservadas.

**Arquivos por sublote:** política/testes; integração no preload; controles/ajuda. Dependências T05/T09/T10.

1. Reutilizar e completar a política existente para toda liberação/doação; consultar estado atualizado imediatamente antes do envio. Preservar mega, equipe, lock, evento, shiny e IV desconhecido.
2. Implementar proteção conservadora de última cópia com contagem confiável e operações pendentes consideradas. Dois descartes simultâneos não podem consumir juntos a última cópia; coleção incompleta/desconhecida deve impedir decisão destrutiva.
3. Diferenciar `pending`, confirmado e rejeitado; limitar histórico e reconciliar por ack/snapshot comprovado. Não repetir descarte incerto nem registrar envio como sucesso consumado.
4. **Política proposta no plano:** Master Ball reservada por padrão, descarte desativado em perfil novo e consumo raro configurável, preservando preferências válidas na migração. Tornar a política visível e testável antes de aplicá-la. O código já prioriza shiny, mas não foi identificada configuração de “lendário” que justifique a exceção escrita no guia anterior. Definir esse contrato e sua fonte, se necessário, antes de adicionar a exceção.

**Aceite:** proteção de última cópia, slot 0, mega, lock tardio, IV ausente, rejeição, ack ausente, reconexão e estoque apenas de Master Ball cobertos. Nenhuma promessa de proteção absoluta enquanto houver estado ou operação concorrente não validada.

### T14 e H03 — Professor e ciclo de laboratório (P1)

**Correção factual:** o ciclo descrito como faltante já está parcialmente implementado e testado. `beginLabDelivery`, `returnFromLab`, `pendingDelivery` e as guardas de patrulha já aguardam estado/confirmam entrega simulada, impedem caça no `npclab` e limitam retorno. Os prazos atuais são **25 s** para viagem/entrega e **10 s** por espera de retorno, com até **3 solicitações de retorno**. Não substituir por 20 s sem motivo e testes.

**Arquivos:** `electron/preload-game.js`, `tests/engine.test.cjs`, `tests/lab-trip.test.cjs`; após T13.

1. Preservar os testes existentes de espera, ausência de cargas, timeout, pausa/retomada, reconexão e laboratório transitável sem patrulha.
2. Completar T14 para Professor, Collector, DexQuest e claims: consulta, elegibilidade, solicitação, confirmação e rejeição explícitas; proteção compartilhada e deduplicação por sessão/geração. Não limitar T14 apenas ao Professor.
3. Não iniciar novos passos de patrulha no laboratório ou durante viagem. Se uma tecla estiver pressionada, liberar a tecla pendente de forma controlada: **não bloquear indiscriminadamente `keyup`**, o que pode deixá-la presa. Validar o efeito de callbacks pendentes após transição de mapa.
4. Em entrega sem confirmação, não repetir consumo nem anunciar recompensa; solicitar retorno/pausar conforme máquina de estados. Não retomar caça até confirmação de chegada compatível com o protocolo (`map:change`/`welcome` e transições de shard relevantes).

**Aceite de T14:** cenários offline de rejeição, snapshot atrasado, lote alterado/protegido, ausência de ack, pausa e reconexão. Os 43 testes aprovados demonstram apenas os cenários existentes.

**Aceite distinto de H03:** observar entrega efetiva de um lote seguro, com autorização aplicável ao consumo, confirmação do servidor/delta de coleção e cargas/recompensa, retorno e retomada/pausa. Consulta sem entrega e ack sintético não fecham H03. Este trabalho documental não executou ações na conta.

### T16 — Troca de rota com confirmação (P1)

**Achado com ressalva:** já existem cooldown de 30 s, bloqueio de sobreposição com laboratório, checagem de `pinned_species` e guarda `nextRouteNum > 150`. Logo, não se comprovou que o código tenta viajar além de 150. Porém, o número é fixo, o acesso não é comprovado e falta watchdog próprio para rejeição/timeout de viagem; a guarda também pode repetir o log de conclusão sem provar que todas as rotas foram completadas.

**Arquivos:** `electron/preload-game.js`, testes de motor/viagem; após T08/T14/T15.

1. Usar catálogo/acesso a rotas baseado em evidência, sem tratar o teto 150 como prova de desbloqueio. Quando acesso for desconhecido, não inventar pré-requisito nem repetir solicitação indefinidamente.
2. Implementar pedido/chegada/rejeição/timeout com tentativas limitadas e preservação da origem. Após falha, retomar a rota atual somente se sua identidade e malha estiverem confirmadas; caso contrário, pausar com motivo visível.
3. Preservar a trava de espécie fixada e os controles já existentes em `app/index.html`/`app/app.js`. Testar IDs numéricos/string, mudança manual e pausa durante viagem.

**Aceite:** última rota, acesso negado, resposta tardia, timeout e espécie fixada não produzem loop nem sobreposição com laboratório. Criar `tests/route-trip.test.cjs` se adotado antes de executar seu comando.

### T19 — Distribuição canônica e verificador (P1)

**Achado confirmado:** `package.json` usa `build.directories.output = "dist-release"`. O verificador e o smoke fixam `dist-desktop/win-unpacked/resources/app`. O smoke aceita fonte via `IDLEDEX_SMOKE_SOURCE=1`, mas ainda não recebe um caminho arbitrário de candidato. O verificador compara bytes dos arquivos em `electron/` e `app/` e gera SHA-256; portanto não falta simplesmente acrescentar hashes. O problema é qual artefato e evidência são verificados.

**Correção da orientação anterior:** manter **`dist-release` como saída corrente**, conforme T19 do plano, e parametrizar ferramentas. Não mudar para `dist-desktop` apenas para acomodar scripts antigos, nem apagar pacotes anteriores automaticamente.

**Arquivos em sublotes:** `package.json` se necessário, `research/verify-release.cjs`, `tests/electron-smoke.cjs` e novos testes do verificador. Coordenar T20.

1. Receber caminho explícito de candidato no smoke/verificador e usar exatamente o mesmo diretório. `--app-dir` é interface **proposta**, ainda não implementada no verificador atual.
2. Comparar o conjunto completo de arquivos esperados, rejeitar extras indevidos e registrar versão, commit, runtime, lockfile e hashes. Considerar a transformação legítima do manifesto pelo builder. O pacote atual usa `asar: false`; `resources/app` corresponde a esse formato, não a toda configuração possível.
3. Vincular o resultado do smoke aos hashes do candidato efetivamente exercitado. O verificador atual aceita relatório antigo pelo caminho/flags e exige ausência de `dist-candidate/win-unpacked`, condição que não comprova integridade e não deve exigir remover um candidato/rollback.
4. Em T20, substituir o main alternativo do smoke por teste do main real com perfil isolado. O script atual intercepta HTTPS e simula sessão; não comprova OAuth real. Installer/portable precisam de verificações próprias.

**Aceite:** fixtures de fonte divergente, arquivo extra, runtime/versão errados e smoke de outro hash reprovam; candidato correto aprova sem excluir pacotes alheios. Só depois de implementar e testar a CLI executar build → smoke do mesmo candidato → verificador. **Hoje, `npm.cmd run pack` seguido do verificador antigo não é gate confiável do pacote recém-gerado.** Nenhum build, smoke ou release foi executado nesta revisão documental.

## 4. Modelo de execução por lote

Preencher todos os campos antes de entregar a outra IA. Seguir a regra do `plan.md` de até **cinco arquivos funcionais/testes por sublote**, com atualizações documentais de controle explicitadas; o limite anterior de 2–3 conflita com várias listas do próprio guia. Dividir tarefas maiores em contratos claros.

```text
Execute somente a tarefa [Txx/sublote] do IdleDex Bot.
Raiz/worktree: [caminho exato]. Commit e diff-base: [estado conferido].
Leia: [seções de plan.md/task_plan.md e fontes atuais].
Dependências já aceitas: [IDs e evidências]. Requisitos R/H atendidos: [IDs].
Problema e resultado esperado: [trigger, antes/depois e limites].
Decisões resolvidas: [política, prazo, precedência, protocolo comprovado].
Edite somente: [lista fechada, até cinco arquivos funcionais/testes].
Atualize registros: [plan/task_plan/findings/progress e Logbook pertinentes].

1. Confira git status/diff e preserve alterações preexistentes.
2. Execute npm.cmd test e registre contagem, skips, falhas e exit code.
3. Para bug de comportamento, reproduza a falha com teste significativo.
4. Aplique o menor diff funcional, preservando invariantes do contrato.
5. Execute testes específicos e a suíte apropriada após a integração.
6. Confira comandos emitidos/estado/DOM, não apenas texto no código.
7. Entregue diff, evidências, comandos, resultados, limites e rollback.

Não invente endpoints, campos ou regras do jogo. Se faltar evidência,
conclua a investigação independente e mantenha o comportamento dependente
pendente. Não marque aceite por nome de teste, relatório antigo ou tempo.
Operações em conta, consumo de criaturas/itens, publicação e substituição
de executáveis seguem a autorização vigente e os gates correspondentes.
Finalize o lote para revisão; não inicie outra tarefa implicitamente.
```

Consultar o cofre antes e registrar a entrega em `04_Logbook/Logbook.md`. Guardar evidência e um handoff quando necessário; este modelo não garante ausência de travamentos do agente nem presume capacidade de abrir outro chat automaticamente. `LINKEDIN_SESSION_COOKIE` aplica-se a scrapers de carreira, não a esta revisão do IdleDex.

## 5. Comandos atuais e limites

Executar na raiz do repositório. A existência dos scripts foi conferida; somente a suíte Node completa foi executada nesta revisão.

| Objetivo | Comando PowerShell | Alcance/condição |
| --- | --- | --- |
| Suíte automatizada Node | `npm.cmd test` | `node --test tests/*.test.cjs`; não inclui smoke `.cjs` sem sufixo `.test.cjs` |
| Motor | `node --test tests/engine.test.cjs` | Harness simulado |
| Laboratório | `node --test tests/lab-trip.test.cjs` | Ciclo simulado, sem consumo real |
| Contas e main | `node --test tests/account.test.cjs tests/main.test.cjs` | Mocks; não valida login real |
| Dashboard | `node --test tests/dashboard.test.cjs` | Harness; complementar com DOM real para XSS |
| Iniciar Electron | `npm.cmd start` | Pode carregar perfil real e ativar configuração persistida; não é verificação offline |
| Empacotar diretório | `npm.cmd run pack` | Saída atual `dist-release`; cria/atualiza artefatos |
| Smoke atual | `.\node_modules\.bin\electron.cmd tests/electron-smoke.cjs` | Exige runtime Electron, não Node puro; usa `dist-desktop` por padrão e main alternativo; corrigir T19/T20 |
| Verificador atual | `node research/verify-release.cjs` | Lê `dist-desktop` e smoke histórico; grava relatório, não certifica automaticamente `dist-release` |
| Inspecionar Git | `git status --short` | Somente saída vazia indica ausência de alterações reportadas |
| Revisar whitespace | `git diff --check` | Não substitui teste funcional |
| Diagnóstico do agendador | `hermes cron doctor` | Registrar resultados e avisos; não executar jobs para testar o documento |

Arquivos novos citados no backlog (`security`, `protocol`, `route-trip`, DOM e testes Python/verificador) são destinos propostos, não scripts já disponíveis. Não executar comandos futuros antes de criá-los e confirmar que descobrem testes reais.

## 6. Evidências e conclusão da revisão

- Fontes locais lidas: `plan.md` (T01–T27 e H/R), `task_plan.md`, `findings.md`, `progress.md`, `package.json`, `.gitignore`, `electron/main.js`, trechos relevantes de `electron/preload-game.js` e `app/app.js`, ajuda/HTML, harnesses/testes, `bot.py`, verificador/smoke e bundle histórico citado.
- Suíte completa aprovada (43/43) com saída em `D:\Projetos\idledex-document-review\npm-test.txt`. O resultado não resolve lacunas de cobertura apontadas neste documento.
- `hermes cron doctor`: **nenhum problema em 2 jobs ativos; exit code 0** na repetição com acesso aos logs locais, registrada em `D:\Projetos\idledex-document-review\hermes-cron-doctor.txt`. A primeira tentativa encontrou restrições de escrita dos logs; o diagnóstico foi repetido sem esses erros. Essa checagem não equivale a executar cada rotina.
- Consulta ao cofre realizada em `00_Meta`, `02_Areas` e `03_Recursos/Antigravity_Guia_Mestre.md`. QMD foi tentado, mas falhou por diretório do banco inexistente; usada consulta direta sem reparar a instalação global.
- Referências oficiais Electron consultadas online para IPC/isolamento, navegação/janelas, remoção de `new-window` e permissões, com links nas instruções correspondentes. As páginas `latest` são referências dinâmicas; conferir compatibilidade com o runtime alvo ao implementar.
- Não foram executados bot real, login, liberação/doação, compra/consumo, build, publicação ou commit. O código do repositório e suas alterações preexistentes foram preservados.

**Resultado:** usar este guia como instrução revisada e datada. Os riscos e pendências de implementação continuam abertos nos respectivos contratos; não há certificação de segurança total, equivalência ao servidor ou conclusão do backlog apenas porque o documento foi corrigido.
