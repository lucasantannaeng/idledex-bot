---
title: Auditoria e plano de melhoria do IdleDex Bot
author: codex
created: 2026-09-10
updated: 2026-09-10
status: plano-pronto-para-execucao
baseline_commit: c3dccab
---

# IdleDex Bot — plano de melhoria e ordens de execução

## 1. Objetivo e responsabilidade

Este documento é o plano mestre solicitado por Luca para melhorar o bot com execução por outras IAs. Codex é o orquestrador responsável por especificar contratos, resolver ambiguidades, revisar diffs, reproduzir verificações e aceitar ou rejeitar entregas. Antigravity/Gemini e Hermes são executores. Um erro decorrente destas instruções exige correção do plano pelo orquestrador; atribuir o erro à IA executora não constitui solução.

A entrega desta auditoria é o plano, não a implementação das melhorias. Nenhuma tarefa abaixo está concluída apenas por constar aqui. Não existe garantia de ausência absoluta de erros: a responsabilidade é operacionalizada com evidência, limites de escopo, testes negativos e bloqueios de integração.

Prioridade do produto: preservar conta e coleção; fazer configuração e pausa corresponderem ao comportamento real; manter combate, captura e viagens confiáveis; comprovar a distribuição; só depois otimizar e ampliar funcionalidades.

## 2. Base factual e cobertura do scan

Auditoria em 2026-09-10, fonte inicialmente sem alterações em `git status --short`, commit `c3dccab`. Manifesto 2.5.0; dependências instaladas Electron 33.4.11 e electron-builder 25.1.8. `npm.cmd test` executado nesta auditoria: **42 testes, 42 aprovados, zero falhas ou skips**. Isso comprova os cenários simulados existentes, não estabilidade indefinida nem equivalência ao servidor.

| Superfície examinada | Evidência e alcance |
| --- | --- |
| Processo principal e contas | `electron/main.js`, `account-session.js`, `preload-dashboard.js`: ciclo de vida, partição, IPC, configuração, OAuth, fechamento e bandeja |
| Motor Electron | `electron/preload-game.js` (2.489 linhas): interceptação, protocolo, captura/IVs, combate, inventário, NPCs, viagens, mapas, temporizadores, telemetria e comandos |
| Interface | `app/app.js`, `index.html`, `styles.css`, `help.js`: persistência, seleção, renderização, ajuda, controles e estados |
| Testes | Seis arquivos `*.test.cjs`, harness do motor e smoke Electron; execução da suíte Node; inspeção dos limites dos mocks |
| Distribuição | `package.json`, lockfile, `.gitignore`, `research/verify-release.cjs`, smoke e diretórios de saída; comparação pontual de arquivos fonte/pacote |
| Legado | `bot.py`, `config.py`, `economy.py`, userscript, HTMLs antigos, requirements e spec PyInstaller; revisão estática, sem iniciar bot Python |
| Documentação/histórico | README, QUICKSTART, DASHBOARD, tests.md, BLAST e relatórios em research; usados como histórico, não prova atual de execução |
| Memória compartilhada | `00_Meta/INDEX.md`, `AGENT_PROTOCOL.md`, Guia Mestre Antigravity e guia Hermes; `02_Areas/Scripts_Automação_Python` existe e está vazio na inspeção |

QMD está instalado, mas não havia `vault-manifest.json` com índice e a consulta de coleções falhou por diretório do banco inexistente; foi usada leitura direta do cofre. Não reparar a instalação global como parte do bot. Não há necessidade de cookie LinkedIn: este projeto não é `career-ops`.

Limites: não houve login, ações no jogo, inspeção de credenciais, execução do Python, novo build, novo smoke gráfico, teste de instalador ou pentest em servidor. Relatórios de setembro de 8/9 são históricos. Não se conclui que um segredo foi vazado: `config.json` é rastreado, mas `session_token` e `ws_token` estão vazios no estado observado. Não foi auditado todo o histórico Git à procura de segredos.

Comparação pontual: `electron/main.js`, `electron/preload-game.js` e `app/app.js` coincidem com ambos os pacotes `dist-desktop` e `dist-release`. O manifesto bruto difere, o que pode ser transformação normal do builder. Isso não prova igualdade de todo pacote, do runtime ou do EXE portable.

Referências externas consultadas em 2026-09-10: [segurança Electron](https://www.electronjs.org/docs/latest/tutorial/security) e [calendário de releases](https://www.electronjs.org/docs/latest/tutorial/electron-timelines). Fundamentam revisão de isolamento, permissões, navegação, IPC e atualização do runtime. A versão alvo deverá ser verificada novamente na execução; este plano não inventa CVEs ou fixa uma versão futura.

## 3. Achados priorizados

> **Correção de escopo em 2026-09-10:** a primeira versão consultou task_plan.md sem reconciliar cada pendência. A seção 9 acrescenta a matriz obrigatória de continuidade, com dez itens antigos abertos e quatro pacotes H01–H04. task_plan.md continua sendo fonte de requisitos pendentes; este plano não o substitui por um histórico descartável. Os pacotes H são trabalho obrigatório herdado, além das melhorias T01–T27.

Legenda: **C** = comportamento/estrutura confirmado por leitura; **R** = reproduzido nesta auditoria; **V** = hipótese ou risco que precisa de teste específico; **O** = oportunidade. P0 bloqueia nova distribuição/uso da superfície afetada; P1 corrige confiabilidade; P2 melhora manutenção/experiência; P3 opcional.

| ID | Nível | Evidência e consequência | Tarefa |
| --- | --- | --- | --- |
| F01 | P0 C | `main.js:291–303` força guest sem isolamento/sandbox, não valida `params.src`/partição; HTML permite popups. Não há política explícita de navegação/permissões/janelas. A superfície remota precisa de contenção; exploração nativa não foi demonstrada. | T02–T03 |
| F02 | P0 C | `main.js:233–240,257,272`: get/save-config e controles sem checagem de remetente/frame. `switch-account` já verifica ambos e serve como padrão. | T02 |
| F03 | P0 C/V | `preload-game.js:10–15` encaminha qualquer canal de CustomEvent; `app.js:339–355` interpola frequência, níveis e ID em HTML/handler inline. `escapeHtml` não resolve contexto JavaScript dentro de atributo. Possível execução no dashboard via telemetria forjada deve ser reproduzida offline. | T04 |
| F04 | P1 C | `main.js:32–87` valida só objeto; mescla campos desconhecidos e valores sem domínio. Defaults diferem dos do motor; erros de leitura são silenciosos. Configuração inválida chega às decisões. | T05 |
| F05 | P1 C | `app.js:385–402` altera estado antes de salvar, ignora retorno false e envia ao guest. `toggleBotState:568–581` também aplica antes de persistir. O teste de falha existente cobre apenas `saveBotSettings`. | T06 |
| F06 | P1 C | `app.js:337–358`: lista só atualiza por troca de mapa/quantidade de filhos; alterações de caught ou espécies no mesmo mapa ficam antigas. `[]` significa todos no motor e na UI; “Desmarcar” pode virar captura de todos. | T07 |
| F07 | P1 C/R | `HookedWebSocket:2332–2336` promove todo socket a ativo, sem identificar protocolo/endpoint. Reprodução com dois sockets do harness: comando posterior foi só ao segundo. Cenário de endpoint estranho ainda requer fixture própria. | T08 |
| F08 | P1 C/V | `parseBinaryFrame:616–691` aceita prefixos parciais, muda moveSeq/playerPos durante parse; identificação `includes('player:')` pode tomar outro jogador por si. Blob não é tratado. Confirmar semântica binária antes de alterar. | T09 |
| F09 | P1 C | `updateCreatures:1155–1167`: patch sem campo teamSlot em seus itens substitui equipe por toda a coleção, mesmo que slots já existam no estado mesclado. Pode orientar cura/líder usando Box. | T10 |
| F10 | P1 C/V | `processBattleTurn:2057–2072` avalia fuga antes de revive; HP zero com limite padrão passa em fuga antes de usar revive. Dependência do estado emitido pelo servidor precisa de fixture. | T11 |
| F11 | P1 C | Captura em `processBattleTurn:2100–2130`: com alvo, bolas e canThrowBall, condição `isDirectThrow || canThrowBall` torna limite de HP irrelevante para esperar dano. É preciso decidir contrato, não apenas mudar operador e arriscar shiny. | T12 |
| F12 | P1 C/O | `getBestBall:957–1005` pode consumir Master Ball como fallback; `isUncaught` consulta coleção atual, não necessariamente registro permanente da Pokédex. Escolhas podem gastar item raro/recapturar espécie já registrada. | T12–T13 |
| F13 | P1 C/V | `checkMonIVStrategy:1809–1830` marca ID como liberado antes de confirmação e loga liberação ao enviar. Set não tem limite; não há proteção explícita da última cópia nessa função. Preservação da última cópia deve ser política explícita, não suposição. | T13 |
| F14 | P1 C/V | NPC/claims já têm proteções e deduplicação, mas alguns logs anunciam sucesso na solicitação. Confirmar rejeições, snapshots atrasados e exclusão mútua entre lock, release e doação. | T13–T14 |
| F15 | P1 C | `checkAutoRouteSwitch:305–361` supõe rota sequencial até 150 e envia viagem sem watchdog próprio. `loadMapCollision:401–498` não tem timeout/abort, engole erro e depende de heurística própria de grama. | T15–T16 |
| F16 | P1 C | `toggle-bot` pausado envia `idle:start` se auto_idle ativo. “Pausado” não significa zero automação do servidor. Defaults do main ligam bot/NPC/descarte na primeira configuração. | T17 |
| F17 | P1 C/V | Pausa automática de laboratório altera só botConfig.enabled; precisa confirmar persistência e comportamento após reload. Reconnect, sleep/resume e perda de renderizador não têm uma prova integrada de recuperação. | T17–T18 |
| F18 | P1 C | Build sai em `dist-release`, mas smoke/verificador fixam `dist-desktop`. Verificador aceita smoke antigo sem vínculo ao hash testado e confere arquivos esperados sem rejeitar arquivos extras. Pode certificar saída errada/incompleta. | T19–T20 |
| F19 | P1 C | Runtime instalado 33.4.11; atualização e compatibilidade não têm gate automatizado visível. README anuncia isolamento e segurança em termos mais fortes que a implementação demonstra. | T21,T24 |
| F20 | P2 C | Harness `state()` envia update-config, tornando observação mutação; querySelector sempre null, sem caminho de clique real. Smoke cria main alternativo e intercepta todo HTTPS, não testa o main real nem OAuth real. | T01,T20 |
| F21 | P2 C/O | Motor monolítico, presets/defaults duplicados, parâmetros iv_collection_threshold/iv_sell_threshold persistidos sem uso localizado no motor. Floodfill usa shift; telemetria e UI redesenham frequentemente. | T05,T22 |
| F22 | P2 C/O | Ajuda e focus-visible já existem; tabs usam onclick para reconhecer painel, sidebar tem 440px, janela mínima 1040x700; teclado/DPI/zoom e falhas de carregamento exigem validação real. | T23 |
| F23 | P0 C, legado | `bot.py:154–285`: bind 0.0.0.0, CORS *, endpoints que alteram token/config sem autenticação e corpo sem limite. Só afeta quem executa Python; não afirmar que Electron abre essa porta. | T25 |
| F24 | P1 C, legado | `config.py:update` testa int antes de bool (bool é subclasse de int); `/api/token` chama .get em cookies antes de tratar string; config grava sem atomicidade. | T26 |
| F25 | P1 C, legado | Userscript substitui WebSocket sem copiar OPEN/prototype; sendEvent depende de WebSocket.OPEN. Timers e protocolo divergem do Electron. Não apresentá-lo como alternativa equivalente. | T27 |
| F26 | P2 C, legado | `economy.py:_base_iv_score` diz normalizar 0–60 usando divisor 126; seis IVs 31 com pesos excedem 60. Média anunciada de 10 usa todo histórico. Não integrar decisões econômicas sem contrato. | T26 |
| F27 | P1 C | `config.json` rastreado e usado para persistência de tokens do legado: possibilidade de commit acidental futuro, mesmo com tokens vazios agora. `.gitignore` não protege arquivo já rastreado. | T25 |
| F28 | P2 C | README manda executar `tests/regression-suite.js` e `tests/smoke-electron.js`, inexistentes. tests.md mantém 31/38/41 testes históricos e instruções de pacote conflitantes. Não há CI rastreado. | T20,T24 |

O que preservar: lock de instância única, debug opt-in, gravação temporária/rename, proteção de eventos de socket antigo, generation para callbacks, ação única por janela de batalha, confirmação de entrega ao Professor, gates de IV completo/lock/shiny/equipe, perfil de smoke separado e ajuda contextual. Não reescrever essas soluções porque outra IA prefere outra arquitetura.

## 4. Contrato entre orquestrador e executores

### Papéis

| Papel | Responsabilidade e limite |
| --- | --- |
| Codex/orquestrador | Selecionar tarefa, preencher pacote de execução, definir decisões pendentes, revisar fontes oficiais necessárias, testar independentemente, integrar e manter plano/BLAST. Único aceite final. |
| Antigravity com Gemini configurado pelo usuário | Implementar lotes delimitados de interface e código. O rótulo Gemini 3.8 Flash (High) vem da preferência do workspace; não é garantia de disponibilidade/capacidade. Registrar o modelo real, sem mudar automaticamente. |
| Hermes Agent | Testes, fixtures sanitizadas, diagnóstico reproduzível, documentação e rotina de verificação; pode implementar tarefa quando explicitamente designado. Não enviar dados de conta para provedores. |
| Revisor de segundo passe | Outro executor disponível recebe contrato, diff e cenários negativos; procura violação de invariantes. Não aprova o próprio trabalho. Codex ainda decide. |

Não é necessário que todos os executores estejam disponíveis. Trabalho não entregue não existe. Se um executor parar, registrar último estado verificável e redistribuir o mesmo escopo após inspeção, sem presumir que terminou. Não inferir sucesso por tempo decorrido, status de conversa ou saída textual da IA.

### Regras de execução obrigatórias

1. Trabalhar na raiz deste projeto; começar por git status, commit atual e arquivos autorizados. Não sobrescrever alterações de Luca. Não executar reset/clean, remover pacotes ou mexer no perfil real para “limpar o ambiente”.
2. Uma tarefa por lote; no máximo cinco arquivos funcionais/testes por sublote. Se exceder, Codex divide e fixa contrato antes. Não instalar dependências para tarefas que stdlib resolve.
3. Ordem de verdade: pedido de Luca, invariantes deste plano, código/fixtures atuais, documentação oficial versionada e evidência do servidor. Histórico e comentários não provam regra oficial.
4. Antes de corrigir bug, adicionar cenário que falha no comportamento atual e passa na correção. Teste deve observar comando/estado/DOM real, não procurar texto no fonte. Não relaxar teste para ficar verde.
5. Nunca inventar mensagem do protocolo, endpoint, fórmula de grama, limite de rota, resposta de servidor ou seletor DOM. Se não há evidência, produzir investigação delimitada e bloquear só o comportamento dependente.
6. Não rodar `validate-live.cjs`, ligar bot, liberar/doar criaturas, consumir itens, limpar sessão real, publicar ou substituir EXE instalado durante tarefas offline. Este pedido autoriza planejamento, não essas operações. Preparar candidato verificável antes de pedir ação real necessária.
7. Não logar cookies, token, querystring de WebSocket ou perfil Chromium. Fixtures usam IDs sintéticos e dados mínimos. Não acessar ferramentas de carreira.
8. Nenhum executor trabalha simultaneamente em `preload-game.js` com outro. Para paralelizar, usar worktrees isolados e contratos estáveis; o orquestrador integra um lote por vez e repete testes após a integração.
9. Atualizar BLAST com ID, evidência, comando e resultado. Não apagar fases históricas nem marcá-las retroativamente como validadas.
10. Encerrar lote com handoff curto; se contexto degradar, salvar estado antes de nova sessão. Não depender de memória implícita nem prometer abertura automática de outro chat.

### Pacote que Codex deve entregar a cada executor

```text
Tarefa: Txx e sublote, commit base e caminho do worktree.
Leia: seção específica deste plan.md, funções citadas e testes relacionados.
Problema: trigger, comportamento atual, comportamento esperado e evidência.
Decisões já resolvidas: valores, precedências, timeout, política de falha.
Edite somente: lista fechada de até 5 arquivos.
Preserve: invariantes e testes existentes aplicáveis.
Passos: sequência da tarefa abaixo, começando pelo teste que reproduz o erro.
Verifique: comando exato e cenários positivos/negativos exigidos.
Pare e relate: falta de contrato, arquivo adicional necessário, regra de jogo desconhecida.
Entregue: diff, testes adicionados, comandos/exit codes, limitações e rollback.
Proibido: mudanças oportunistas, ações em conta real, inventar evidência.
```

Não despachar esse modelo com campos em aberto. O orquestrador deve preenchê-lo a partir das tarefas e resolver decisões sem delegá-las implicitamente ao executor.

## 5. Backlog executável

Todos os itens estão pendentes de implementação. Dependências indicam aceite efetivo, não apenas início. Para cada tarefa aplicar também o gate global da seção 6. Os nomes de novos testes abaixo são destinos propostos, não arquivos já existentes.

### T01 — Tornar a observação do harness neutra (P1, Hermes)
- **Depende:** nenhuma. **Arquivos:** `tests/engine-harness.cjs`, `tests/engine.test.cjs`.
- **Passos:** separar leitura de última telemetria de solicitação explícita de publicação; eliminar update-config em state(); oferecer socket com URL configurável e emissão binária; manter relógio determinístico. Ajustar os testes afetados em sublotes, sem mudar produção.
- **Aceite:** ler estado não envia comandos, não configura motor nem muda timers; testes antes dependentes da mutação passam a fazer a ação explicitamente; suite continua exercitando preload inteiro.
- **Verificar:** `node --test tests/engine.test.cjs tests/lab-trip.test.cjs`, depois `npm.cmd test`. Comparar contagem de comandos/timers antes e após duas leituras consecutivas.

### T02 — Validar IPC e limitar navegação/permissões (P0, Codex define; Gemini executa)
- **Depende:** nenhuma. **Arquivos:** `electron/main.js`, `tests/main.test.cjs`, novo `tests/security.test.cjs`.
- **Passos:** reutilizar checagem de janela e frame principal em todos os IPCs; validar URL com URL parser, protocolo e host exatos, sem endsWith permissivo; restringir anexação à janela/partição/fontes aprovadas. Negar permissões por padrão e especificar exceções observadas. Controlar criação de janelas e navegação do dashboard/guest.
- **Aceite:** guest, subframe e janela estranha não salvam config/controlam host; hosts semelhantes e file/javascript externos são rejeitados; fluxo permitido do jogo e OAuth preserva parâmetros e partição. Lista OAuth só é ampliada com evidência, não com wildcard geral.
- **Verificar:** `node --test tests/main.test.cjs tests/account.test.cjs tests/security.test.cjs`; testes de URL adversarial, senderFrame ausente, popup e permissões negadas. Login real não se deduz de mocks.

### T03 — Isolar preload preservando interceptação (P0, Codex lidera)
- **Depende:** T02,T04,T20 para aceite integrado. **Arquivos por sublote:** primeiro main/preloads e teste; depois HTML/smoke.
- **Passos:** desenhar bridge mínima; manter interceptação necessária no mundo principal sem APIs Node expostas; remover fs/path do preload sandboxed ou resolver recursos no main; habilitar contextIsolation e sandbox no host/guest. Não basta mudar duas flags: validar o hook antes do primeiro script do jogo com fixture real de navegador.
- **Aceite:** primeiro socket continua observável, config chega em reload, página não acessa IPC genérico/Node; smoke do pacote com flags reais passa. Se a migração exige WebContentsView, abrir ADR e subplano, sem trocar framework incidentalmente.
- **Verificar:** suíte completa + smoke corrigido em T20 e teste Electron de acesso negado. Rollback do candidato inteiro, nunca “corrigir” falha desligando isolamento silenciosamente.

### T04 — Telemetria tratada como dado não confiável (P0, Gemini)
- **Depende:** nenhuma. **Arquivos:** `electron/preload-game.js`, `app/app.js`, `app/index.html`, `tests/dashboard.test.cjs`, novo teste de DOM.
- **Passos:** permitir só canais documentados (telemetria/log) e validar payload/limites; construir lista/última captura/log com textContent e listeners; remover ID interpolado em onchange. Validar números finitos para níveis, posição, IVs. Migrar handlers inline em sublote antes de CSP restritiva.
- **Aceite:** strings contendo aspas, tags e handlers aparecem como texto; eventos de canal desconhecido não chegam ao host; CSP do dashboard não precisa unsafe-eval/unsafe-inline para scripts. Página do jogo não é tratada como fonte confiável de comandos administrativos.
- **Verificar:** teste DOM em Electron offline com payloads sintéticos; `node --test tests/dashboard.test.cjs`; confirmar botões, lista e tutorial após remoção dos inline handlers. Não declarar XSS corrigido apenas com mock que não interpreta HTML.

### T05 — Contrato único de configuração (P1, Gemini)
- **Depende:** T02. **Arquivos:** novo módulo de configuração, `main.js`, preload e testes em sublotes.
- **Passos:** inventariar cada chave em main/motor/UI/ajuda; tabela chave→tipo→unidade→default→domínio→consumidor. Centralizar normalização sem dependência nova. Adotar schemaVersion e migração explícita. Percentuais de motor 0..1, descarte 0..100, IV total 0..186; zero válido não vira default. Delays/limiares com faixa definida por Codex antes de edição. Campos sem consumidor devem ser marcados obsoletos, não ganhar lógica inventada.
- **Aceite:** NaN, infinito, arrays no lugar de objeto, enum estranho e chaves desconhecidas não chegam ao motor; arquivo corrompido gera diagnóstico e estado seguro; versão futura não é sobrescrita silenciosamente. Defaults novos pausados; migração preserva escolhas válidas existentes.
- **Verificar:** `node --test tests/main.test.cjs tests/engine.test.cjs tests/dashboard.test.cjs`; tabela de fixtures vazia/parcial/zero/inválida/versão antiga/futura; falha rename conserva arquivo anterior.

### T06 — Salvar alvos/ativação de modo consistente (P1, Gemini)
- **Depende:** T05. **Arquivos:** `app/app.js`, `tests/dashboard.test.cjs`.
- **Passos:** criar configuração candidata sem mutar currentConfig; aguardar persistência para ativar/aplicar alvos. Serializar cliques ou usar revisão monotônica para resposta antiga não vencer. Pausa de emergência atua imediatamente; falha ao persistir pausa fica explícita e bloqueia reativação automática até reconciliação.
- **Aceite:** false/rejeição ao salvar alvos conserva estado e não envia update-config; falha ao ativar não liga motor; pausa para já e avisa que reinício ainda não está garantido se disco falhar.
- **Verificar:** `node --test tests/dashboard.test.cjs`; cobrir false, throw, dois saves resolvidos em ordem inversa, reload e clique duplo.

### T07 — Seleção e atualização do radar (P1, Gemini)
- **Depende:** T05,T06. **Arquivos:** `app/app.js`, `electron/preload-game.js`, `app/help.js` e testes, por sublote.
- **Passos:** definir `target_mode: all|selected|none`; migrar lista vazia antiga para all e não-vazia para selected. “Desmarcar” vira none. Definir prioridade de shiny separadamente e mostrar a exceção. Atualizar conteúdo por mudança de dados, preservando foco/scroll. Normalizar speciesId como string na fronteira.
- **Aceite:** all/none/selected têm comportamento inequívoco após salvar e reiniciar; caught e espécies atualizam no mesmo mapa; dados recebidos não apagam edição não salva.
- **Verificar:** testes dashboard+engine de três modos, ID numérico/string, troca de mapa e caught tardio; teste DOM de foco preservado. Política de alvos por rota pode ser melhoria posterior, não alterar silenciosamente semântica global existente.

### T08 — Identificar a conexão do jogo (P1, Gemini)
- **Depende:** T01. **Arquivos:** preload, harness e engine.test.
- **Passos:** obter endpoint/handshake de fixtures sanitizadas e registro de protocolo; passar sockets estranhos sem promover. Trocar sessão apenas em handshake válido; invalidar callbacks antigos no ponto correto. Preservar prototype, constantes, binaryType e send originais.
- **Aceite:** socket de serviço/analytics não recebe comandos; reconexão e shard válidos assumem controle sem aceitar mensagens antigas; abertura malsucedida não descarta imediatamente sessão saudável.
- **Verificar:** `node --test tests/engine.test.cjs tests/lab-trip.test.cjs`; dois endpoints simultâneos, novo sem welcome, close atrasado, URL inválida e redirecionamento de shard.

### T09 — Parser e identidade transacionais (P1, Hermes)
- **Depende:** T01,T08. **Arquivos:** preload e testes de protocolo/harness.
- **Passos:** documentar campos binários a partir de evidência; parsear para estrutura temporária validando tamanho/flags/limites antes de atualizar estado; usar ID próprio confirmado, nunca categoria genérica player:. Identificar se snapshots são completos ou delta. Suportar Blob só se necessário, guardando geração após await.
- **Aceite:** frame truncado/malformado não altera posição/ack/equipe nem derruba motor; outro jogador não vira posição local; limites evitam alocações desproporcionais.
- **Verificar:** novos testes de prefixos truncados, flags desconhecidas, UTF-8, entidade remota, delta sem posição e Blob atrasado de socket substituído. Comando `node --test tests/protocol.test.cjs` após criar arquivo.

### T10 — Equipe consistente com patches (P1, Gemini)
- **Depende:** T01. **Arquivos:** preload e engine.test.
- **Passos:** reproduzir coleção com equipe e Box seguida de patch só HP; derivar equipe do estado mesclado. Se protocolo legado realmente usa team sem slots, tratar como contrato distinto, não fallback baseado no último patch. Definir remoção/tombstones conforme protocolo observado.
- **Aceite:** patch de Box não vira equipe; patch de HP não troca líder; snapshot completo substitui estado e patch parcial preserva campos não enviados.
- **Verificar:** `node --test tests/engine.test.cjs`, cenários Box/equipe/remoção/HP/slots null e out-of-order documentado.

### T11 — Precedência de recuperação e fuga (P1, Gemini)
- **Depende:** T10. **Arquivos:** preload, engine.test, ajuda se contrato mudar.
- **Passos:** fixture HP=0, canRevive, estoque positivo e limite padrão. Codex define regra: se revive permitido e habilitado, avaliar antes de fuga por HP; sem revive, usar somente ação permitida pelo servidor. Confirmar também interseção de potion_hp_pct e flee_hp_pct.
- **Aceite:** revive acessível quando configurado; zero itens/sem permissão não envia ação inválida; uma ação por janela, sem loop de gasto por confirmação atrasada.
- **Verificar:** engine.test com HP 0/1/limiares, líder trocado, estoque zero e janela de animação.

### T12 — Contrato de captura e consumo de bolas (P1, Codex define; Gemini executa)
- **Depende:** T07,T09,T11. **Arquivos:** preload, engine.test, help.js em sublotes.
- **Passos:** criar tabela alvo×HP×canThrow×estoque×shiny×filtros. Preservar a decisão já registrada na Phase 16 do task_plan.md: arremesso direto para shinies/baixo nível/inéditos e enfraquecimento não letal para alvos de nível alto; bot ativo interrompe AUTO nativo. Não reabrir essa decisão como se Luca nunca a tivesse tomado. Definir o papel de catch_hp_pct dentro desse contrato; hoje não funciona como limiar estrito. Sem fórmula de dano comprovada, não inventar segurança de golpe nem atacar um alvo protegido para cumprir o limiar. Consultar caught permanente para inéditos quando disponível; estado desconhecido não equivale automaticamente a falso.
- **Aceite:** teste demonstra efeito real do limite; janela fechada não arremessa; espécie registrada e ausente da Box não é confundida com inédita. Regras sem evidência ficam desativadas/explicitamente heurísticas.
- **Verificar:** engine.test com matriz e snapshot Pokédex; comparar UI/ajuda ao comportamento. Decisão final de limiar aprovada por Codex no pacote de execução antes de mudar código.

### T13 — Proteger recursos e confirmar descarte (P1, Codex lidera)
- **Depende:** T05,T09,T10. **Sublotes:** (a) política pura + testes; (b) integração de release/lock; (c) controles e ajuda. Até cinco arquivos cada.
- **Passos:** política única de proteção consultada imediatamente antes de liberar/doar; preservar equipe, shiny, evento, lock, mega e IV desconhecido. Proposta conservadora adicional: última cópia protegida, descarte desativado em perfil novo, Master Ball reservada por default e consumo raro configurável. Migração não apaga preferências antigas. Registrar pending/succeeded/rejected para release; só confirmar por snapshot/ack observado e nunca repetir operação destrutiva às cegas.
- **Aceite:** corrida lock vs release não libera protegido; rejeição não aparece como sucesso; set/histórico é limitado por sessão/TTL com reconciliação; última cópia e Master Ball obedecem política visível.
- **Verificar:** testes de release duplicado, ack ausente, rejeição, reconnect, lock tardio, IV ausente, última cópia, estoque apenas de Master Ball. Criar testes das novas políticas antes de integrar.

### T14 — NPCs e recompensas com resultado confirmado (P1, Hermes)
- **Depende:** T13. **Arquivos:** preload, engine.test, lab-trip.test.
- **Passos:** mapear consulta, elegibilidade, solicitação e confirmação para Professor/Collector/DexQuest/claims. Usar proteções compartilhadas e snapshots atuais; diferenciar “solicitado” de “recebido”. Definir limite de tentativas e cooldown por geração, sem ampliar frequência de chamadas.
- **Aceite:** estado duplicado não duplica consumo; lote protegido/sem carga não é enviado; timeout retorna/pausa sem anunciar entrega. Deduplicação entre sessões não bloqueia recompensa válida indefinidamente.
- **Verificar:** `node --test tests/engine.test.cjs tests/lab-trip.test.cjs`; preview recusado, mudanças na Box, ausência de ack, pausa em cada fase e reconexão. Entrega real continua não comprovada até teste autorizado específico.

### T15 — Falhas de mapa e grama honestas (P1, Hermes)
- **Depende:** T09. **Arquivos:** preload, testes de mapa, research de contrato.
- **Passos:** impor timeout/AbortController ao fetch; cancelar carga anterior e validar dimensões/valores/mask com limite documentado. Expor estado mapa indisponível e permitir retry limitado. Separar transitabilidade de hipótese de grama; remover “genuíno/oficial” de logs heurísticos.
- **Aceite:** request pendurado não bloqueia motor para sempre; resposta velha não vence mapa atual; mapa inválido não inicia movimento inseguro. Equivalência à grama nativa só pode ser aceita com fórmula ou observações suficientes de referência, hoje ausentes.
- **Verificar:** teste mapa 404/500/timeout/grid inválido/fringe curto/sem grama/ilhas pequenas e ordem invertida. A tarefa de robustez pode concluir; a equivalência nativa permanece pendente separadamente.

### T16 — Viagem entre rotas com confirmação (P1, Gemini)
- **Depende:** T08,T14,T15. **Arquivos:** preload e testes de viagem.
- **Passos:** catálogo de rotas acessíveis baseado em dados observados, sem assumir 150 como prova de acesso. Máquina de estados para pedido/chegada/rejeição/timeout; não deixar patrulha parada sem motivo visível. Não sobrepor laboratório e troca de rota. Os controles auto_route_switch/pinned_species JÁ EXISTEM em app/index.html:313,317 e são carregados/salvos em app/app.js:656–657,730–731; preservar e testar sua integração, não criar controles duplicados. A caracterização anterior como features ocultas estava incorreta.
- **Aceite:** destino bloqueado ou inexistente não gera loop; pausa cancela callbacks; welcome/shard confirma destino; origem e alvo fixado são preservados.
- **Verificar:** `node --test tests/lab-trip.test.cjs tests/route-trip.test.cjs` após criar segundo arquivo; cenários última rota, acesso negado, resposta tardia e mudança manual.

### T17 — Estado operacional e pausa inequívocos (P1, Gemini)
- **Depende:** T05,T06,T14. **Sublotes:** motor e testes; UI/ajuda e testes.
- **Passos:** separar conectado, configuração carregada, bot ativo, idle nativo, pausa manual e pausa por falha. Mostrar “Bot pausado; AUTO do jogo ativo” quando aplicável. Criar parada total distinta que solicita idle:stop sem prometer reversão de ação já aceita no servidor. Pausa automática deve chegar ao main e persistir com sender validado.
- **Aceite:** perfil novo não executa ações antes de escolha; pausa automática não retoma após reload; tela e bandeja refletem estado real/confirmado ou pendente, sem confundir conexão com atividade.
- **Verificar:** engine/dashboard/main testes de boot, disconnect, auto_idle true/false, pausa de laboratório, disco falhando e reload. Preservar possibilidade de o jogo concluir batalha já iniciada.

### T18 — Recuperação de falhas e diagnóstico (P2, Hermes)
- **Depende:** T08,T17. **Arquivos:** main, preload, app.js, testes em sublotes.
- **Passos:** tratar render-process-gone/did-fail-load e sleep/resume de modo limitado, preservando pausa; adicionar razão da última decisão e contador de erros parse/mapa/IPC. Logs estruturados com timestamp, fase, geração e tipo; remover forwarding irrestrito de console ou restringir ao diagnóstico com redação. Exportação só de diagnóstico sanitizado, sem perfil/URL com token.
- **Aceite:** falha visível com recuperação limitada, sem reload infinito; erro identificável sem dados de conta; sem novos timers por reconexão acumulada.
- **Verificar:** teste Electron offline de crash/falha e soak simulado de 100 reconexões; contar listeners/timers/coleções antes e depois. Não chamar soak simulado de prova 24/7 real.

### T19 — Uma cadeia verificável de distribuição (P1, Gemini)
- **Depende:** nenhuma para iniciar; T02–T18 aplicáveis antes de release final. **Arquivos:** package.json, verify-release.cjs, smoke, testes de verificador, por sublote.
- **Passos:** adotar `dist-release` como saída corrente conforme manifesto; receber caminho de candidato explicitamente e usar o mesmo no smoke/verificador. Gerar manifesto de hashes completo, versão, commit, runtime, lockfile e timestamp. Verificar arquivos extras por allowlist. Ligar smoke ao hash exato do candidato e não a caminho/data apenas. Não exigir remoção de dist-candidate para poder validar.
- **Aceite:** fonte divergente, arquivo extra sensível, runtime/versão errada ou smoke de outro hash reprovam; candidato isolado válido aprova; nenhum pacote antigo é deletado automaticamente.
- **Verificar:** fixtures temporárias do verificador, adulterando arquivo, extra e relatório; comando proposto após implementação: `node research/verify-release.cjs --app-dir <caminho-do-candidato>`. Confirmar que o parser da opção existe antes de usar.

### T20 — Smoke do main real e CI Windows (P1, Hermes)
- **Depende:** T19; coordenação com T03. **Sublotes:** bootstrap isolado de teste e smoke; workflow e relatório.
- **Passos:** executar main real com perfil temporário e origem offline substituída por mecanismo exclusivo de teste; não duplicar main em harness e anunciar teste integrado. Encerrar processo com timeout e código de falha. Testar boot/reload/config/tray/fechamento/segunda instância/troca sintética de conta. Workflow Windows com npm ci/test/build/smoke/verificação e artifacts sem perfil. Fixar runtime Node suportado e ações por revisão verificada.
- **Aceite:** fluxo comprova candidato da T19 e sai limpo; perfil real nunca é usado; falha de teste bloqueia distribuição. Installer e portable têm etapas próprias, não herdam aprovação apenas do win-unpacked.
- **Verificar:** rodar pipeline local equivalente e primeira execução CI quando houver autorização de publicação; se CI não foi executada, registrar “configurada, execução remota pendente”. Login OAuth real permanece gate separado.

### T21 — Atualizar runtime e dependências com rollback (P1, Gemini)
- **Depende:** T19,T20. **Arquivos:** package.json, lockfile, testes de compatibilidade e doc da migração.
- **Passos:** consultar linha Electron suportada e breaking changes oficiais no dia da execução; avaliar builder compatível; salvar baseline, atualizar uma cadeia por vez e instalar por npm ci. Usar auditoria completa, incluindo devDependencies: Electron é empacotado apesar de estar em dev. Nunca usar audit fix --force como estratégia.
- **Aceite:** versão exata registrada e candidato funcional com preload/OAuth/tray; achados de dependências triados com alcance real. Não prometer zero CVEs com base somente em npm audit.
- **Verificar:** npm test, build, smoke do candidato, verificador e teste de migração de perfil descartável. Rollback preserva dados reais e exige avaliar incompatibilidade de perfil Chromium antes de downgrade.

### T22 — Modularização e desempenho medidos (P2, Gemini)
- **Depende:** T01,T05,T09–T18 aceitos. **Sublotes:** extrair política de coleção; parser; config; decisão de combate, um por vez.
- **Passos:** caracterização antes de extração; preservar contrato de entrada/saída e ordem de comandos. Substituir shift do floodfill por índice de cabeça; limitar/cachear trabalho de mapa por versão; agrupar renderizações por frame com exceção para desconexão/pausa. Medir antes/depois em fixture fixa e hardware identificado.
- **Aceite:** replay produz mesmos comandos e estados nas extrações; CPU/latência não pioram em cenário definido; telemetria não perde último estado. Sem introduzir React, TypeScript, fila externa ou banco só por preferência.
- **Verificar:** suite completa a cada extração; benchmark determinístico de mapa e rajada de telemetria, p50/p95 e volume de mensagens. Fixar orçamento numérico com baseline medido antes de otimizar.

### T23 — Usabilidade e acessibilidade reais (P2, Gemini)
- **Depende:** T04,T07,T17. **Arquivos:** app HTML/CSS/JS/ajuda e teste DOM, no máximo cinco por lote.
- **Passos:** tabs com estado semântico/teclado; labels explícitas, foco visível em campos, anúncio moderado de erros e estado. Testar 1040x700, 1366x768, 1480x920 e zoom/DPI 125/150/200%; corrigir overflow e controles inacessíveis. Preservar identidade Master Ball e ajuda existente.
- **Aceite:** fluxo configuração→salvar→pausar→ajuda executável por teclado; Escape restaura foco; erro de save visível sem depender de cor; estado inicial não diz BOT ATIVO antes de receber configuração.
- **Verificar:** smoke DOM + inspeção visual e navegação real em Electron; guardar capturas com dimensão/zoom. Não declarar conformidade WCAG completa sem auditoria de escopo correspondente.

### T24 — Documentação e regras locais confiáveis (P2, Hermes)
- **Depende:** T19,T20 e contratos alterados das tarefas anteriores. **Arquivos por lote:** README, tests.md, QUICKSTART, AGENTS.md/GEMINI.md e BLAST separados.
- **Passos:** corrigir comandos/caminhos inexistentes; separar guia Electron atual de legado. Descrever hook como injeção de motor/interceptação, não zero-injection. Qualificar proteção de credenciais e não prometer perda de energia segura sem fsync testado. Marcar relatórios históricos por versão/hash. Criar instrução local curta apontando este plano, evitando dois textos divergentes entre AGENTS/GEMINI.
- **Aceite:** cada comando aponta a script existente e seu efeito é explicado; nenhuma contagem histórica aparece como prova atual; fórmulas não verificadas permanecem identificadas; novo executor sabe de onde retomar.
- **Verificar:** checagem de links/caminhos locais e execução dos comandos offline permitidos; leitura independente por Codex usando somente docs e pacote de execução.

### T25 — Conter legado HTTP e risco de segredo rastreado (P0 no legado, Hermes)
- **Depende:** nenhuma. **Arquivos por lote:** bot.py e testes Python; depois config exemplo/.gitignore/docs.
- **Passos:** manter legado desativado por padrão na documentação até hardening; bind 127.0.0.1, token local efêmero para APIs mutantes, validação Origin/Host e limites de body/timeout. CORS só para origem explicitamente suportada; não aceitar qualquer site só por ser requisição localhost. Retirar config pessoal do rastreamento preservando cópia local e criar exemplo vazio. Varredura de histórico deve emitir só caminhos/tipos, nunca valores; rotação apenas se exposição for comprovada.
- **Aceite:** acesso sem autenticação ou origem inesperada não muda token/config; arquivo local não entra em commit; não iniciar bot real durante teste. Proteção de segredo não é obtida simplesmente adicionando arquivo rastreado ao gitignore.
- **Verificar:** `python -m unittest discover -s tests -p "test_legacy_*.py"` após criar testes; HTTP fixture em loopback efêmero com fake bot; git diff --cached revisado antes de qualquer commit.

### T26 — Corrigir contratos Python/economia se mantidos (P1/P2, Hermes)
- **Depende:** T25 e decisão Codex de suporte legado. **Sublotes:** config/token; economia; ambiente/spec.
- **Passos:** checar bool antes de int; validar cookies objeto/string antes de .get; rejeitar payload não objeto; persistir com temp/replace e comunicar erro. Economia: decidir faixa do score, calcular denominador a partir dos pesos/max IV e alinhar média à janela documentada. Fixar dependências Python testadas; remover caminho absoluto da spec. Não adaptar protocolos Python ao servidor por suposição.
- **Aceite:** true/false e strings válidas são booleanos corretos; cookies string não derruba handler; score respeita faixa declarada; Python instalável em ambiente isolado com comandos documentados.
- **Verificar:** unittest legado e fixtures de boundary; compilação estática sem iniciar bot; build PyInstaller somente se suporte ao binário legado for aprovado. Se legado arquivado, registrar decisões e encerrar como não aplicável com evidência, não como corrigido.

### T27 — Userscript: delimitar suporte (P1 no legado, Hermes)
- **Depende:** decisão de suporte em T26. **Arquivos:** userscript, teste próprio, DASHBOARD/README.
- **Passos:** preferência de escopo: arquivar como histórico e impedir recomendação de uso simultâneo ao Electron. Se mantido, preservar WebSocket.OPEN/prototype, selecionar sessão, cancelar timers por geração e validar comandos contra fixtures do protocolo atual antes de liberar.
- **Aceite:** nenhuma alegação de paridade sem teste; userscript mantido só envia para socket correto e pausa/reconnect não deixam callbacks antigos; documentação evita dois motores na mesma sessão.
- **Verificar:** `node --test tests/userscript.test.cjs` se mantido; se arquivado, checar entrada de documentação e caminhos preservados. Não deletar arquivos antigos sem justificativa e rollback.

## 6. Ordem, gates e evidência de aceite

### Ordem recomendada
0. **Continuidade obrigatória:** reconciliar R01–R10 da seção 9 antes de delegar; iniciar a investigação H01 e preparar H02/H03/H04. Correções de contenção podem avançar, mas melhorias novas não eliminam nem rebaixam os requisitos herdados. Fechar cada pendência somente com a prova correspondente.
1. **Preparação:** T01 e T19; T25 pode ser feito em paralelo, pois não compartilha motor.
2. **Contenção:** T02 e T04; avançar T20 para permitir aceite integrado de T03. T03 depende do smoke pronto, não de finalizar toda a CI.
3. **Estado confiável:** T05→T06→T07; T08→T09; T10→T11. Todos os lotes que tocam preload são serializados.
4. **Recursos e automação:** T13→T14; T12 após dependências; T15→T16; T17→T18.
5. **Distribuição:** fechar T19/T20, atualizar T21 e repetir gate do candidato completo.
6. **Qualidade:** T22/T23/T24; T26/T27 somente conforme suporte legado. Documentação pode preparar correções factuais imediatamente, mas só declara novo comportamento após aceite.

Checkpoint após cada dois ou três lotes: orquestrador lê diff integrado, executa suites afetadas e suíte completa quando houver integração de comportamento. Não esperar o fim de todas as tarefas para descobrir regressão. Não há dependência circular: T20 começa com T19 e serve de infraestrutura a T03; gate de release aguarda ambos.

### Gate global por lote
- [ ] Commit base e diff real correspondem ao pacote delegado; nenhum arquivo fora do escopo sem decisão registrada.
- [ ] Caso de regressão demonstra falha antes e sucesso depois, quando se trata de bug.
- [ ] Cenários negativos descritos na tarefa foram executados; relatório contém comando, exit code e caminho da evidência.
- [ ] Invariantes relevantes preservados: zero ação antes de config; sessão antiga não age; uma ação por janela; protegido não é consumido; pausa não se perde silenciosamente.
- [ ] Nenhum segredo/dado pessoal no diff/fixture/log; não foi usado perfil real.
- [ ] Codex revisou o código e reproduziu verificação necessária, sem aceitar apenas “testes passaram” do executor.
- [ ] Plano, task_plan, findings e progress registram ID e resultado sem destruir histórico.

### Gate de release, distinto do aceite de código
- [ ] npm ci em ambiente limpo e suportado; npm test com cenários novos efetivamente cobertos.
- [ ] Pacote candidato construído uma vez e identificado por hash; smoke/main real usa exatamente esse candidato.
- [ ] Verificador reprova arquivos extras e smoke de outro candidato; manifesto/runtimes conferidos.
- [ ] Portable e installer, se entregues, têm teste próprio de primeiro uso e upgrade em perfil descartável. Hash externo do EXE, versão e origem de download registrados; assinatura de código é melhoria opcional dependente de certificado, nunca requisito inventado para concluir esta auditoria.
- [ ] Recuperação/rollback testados em perfil descartável; pacote anterior preservado.
- [ ] OAuth real e ações de conta que ainda não foram exercitados são listados como pendentes; nenhuma simulação é vendida como validação real.
- [ ] Publicação/substituição do aplicativo somente após autorização correspondente, com resultado concreto para revisão.

### Comandos conhecidos agora (não confundir com scripts propostos)

```powershell
Set-Location -LiteralPath 'D:\Projetos\1.Autorais\idledex-bot'
git status --short
npm.cmd test
node --test tests/main.test.cjs tests/account.test.cjs
node --test tests/dashboard.test.cjs
node --test tests/engine.test.cjs tests/lab-trip.test.cjs
```

`npm.cmd run pack` existe e usa dist-release hoje. O smoke atual e `node research/verify-release.cjs` ainda miram dist-desktop; não usar seus resultados para certificar novo dist-release antes de T19. `IDLEDEX_SMOKE_SOURCE=1` testa fonte, não distribuição. Scripts `research/validate-live.cjs` podem consumir recursos; não fazem parte da bateria offline deste plano.

## 7. Questões que precisam de decisão/evidência antes da tarefa dependente

| Questão | Decisão padrão proposta / tratamento | Responsável |
| --- | --- | --- |
| Python e userscript ainda são produtos suportados? | Electron é produto principal; conter riscos e preservar legado até decisão. Não portar tudo automaticamente. | Codex registra escopo com Luca se manutenção for necessária |
| Pausar deve ativar AUTO do jogo? | Manter função existente explicitamente nomeada; oferecer parada total separada. | Codex fixa contrato em T17 |
| Descarte da última cópia e Master Ball automática? | Defaults novos conservadores; opções antigas migradas sem ocultar mudança. | Codex fixa política em T13 |
| Qual significado de catch_hp_pct? | Definir limiar real com exceções documentadas e evidência de segurança de dano. | Codex antes de T12 |
| Como funciona a grama nativa? | Fonte do servidor/fórmula ainda ausente; heurística identificada como tal. Não afirmar equivalência. | Investigação T15 |
| O que identifica socket, snapshot binário e rotas liberadas? | Fixtures sanitizadas e contrato observado; não inferir por semelhança de nomes. | T08,T09,T16 |
| Login em segunda conta funciona? | Teste sintético não responde; validação real é etapa separada e autorizada. | Gate de release |

## 8. Fora do escopo imediato e critério de sucesso

Não priorizar painel web novo, migração para React, banco de dados, servidor na nuvem, economia automática, IA decidindo cada turno, múltiplas contas concorrentes ou redesenho completo. Não são necessários para corrigir os achados. `asar: false` sozinho não comprova vazamento nem deve ser tratado como substituto para verificação de artefatos.

O sucesso **deste pedido** é este plan.md existente, fundamentado no repositório atual, cobrindo motor, UI, configuração, segurança, dados, legado, testes, performance, operação e distribuição, com ordens que permitam execução e revisão sem ambiguidades ocultas. O sucesso **da implementação futura** exige os gates por tarefa e por release; não é concedido pela conclusão do documento.

Handoff: iniciar por T01/T19 e contenção T02/T04/T25. Fonte baseline c3dccab; 42 testes passaram. Não há correções implementadas neste scan. A equivalência da grama nativa e login em segunda conta continuam sem comprovação. Codex deve revisar estas ordens à luz de cada evidência nova e assumir a correção das instruções quando forem insuficientes.

## 9. Conciliação obrigatória com task_plan.md — correção após revisão de Luca

**Autor: codex. Data: 2026-09-10.** A primeira versão não deu rastreabilidade suficiente ao backlog anterior. Isso foi uma falha de planejamento do orquestrador. Esta seção corrige o plano e prevalece sobre qualquer indicação anterior de que task_plan.md seria somente histórico. Nenhum requisito aberto foi cancelado por este scan.

Foram encontrados **dez checkboxes antigos abertos**, além do agregador T01–T27 adicionado nesta entrega. A existência de um fechamento posterior pode explicar um checkbox antigo, mas só comprova o escopo e a versão descritos naquele fechamento. Não converter automaticamente todos os itens para [x]. As linhas abaixo identificam o estado antes da inserção desta seção; o texto do requisito e o título da seção são os identificadores estáveis.

### Matriz de rastreabilidade das pendências

| ID | Origem em task_plan.md | Estado reconciliado e evidência | Destino e prova necessária |
| --- | --- | --- | --- |
| R01 | Pedido atual, linha 8: verificar algoritmo nativo e alinhar grama | **Pendente real.** research/2026-09-09-usability-audit.md declara ausência da fórmula e que fringe/floodfill não comprovam equivalência. | **H01**, com T15 apenas como robustez auxiliar. Timeout corrigido ou heurística melhorada não fecha R01. |
| R02 | Pedido atual, linha 9: interface real, autenticação, navegação e regressões | **Parcial.** Testes Node e smoke sintético existem; segunda conta real não foi validada. | **H02**, T20/T23. Exigir relatório de interface real, login/logout/segunda conta e navegação; suite simulada isolada não fecha. |
| R03 | Pedido atual, linha 11: documentação, auditoria e diário | **Parcial/desatualizado.** Há registros anteriores e log deste plano, mas docs ainda têm comandos errados e a auditoria de grama permanece aberta. | **H04**, T24. Atualizar docs/status da entrega correspondente; registrar um plano não equivale a documentar correções implementadas. |
| R04 | Auditoria Codex 2026-09-08, linha 294: config no boot/dom-ready | **Correção presente; checkbox antigo desatualizado.** Fechamento 2.4.1 registra correção; app.js:17,62–64,94 sincroniza e dashboard.test.cjs cobre boot/recarga. Suíte 42/42 passou no scan. | Preservar regressão em T06/T20. Pode reconciliar esse item específico como atendido mediante referência ao teste; não reimplementar a correção nem inferir que todos os saves são corretos. Checkbox original preservado nesta revisão para não confundir atualização documental com implementação. |
| R05 | Auditoria Codex 2026-09-08, linha 295: auditar protocolo atual completo | **Fechamento histórico, validade atual parcial.** delivery-audit.md descreve bundle index-DwmEwqo-.js e contratos da 2.4.1; não prova protocolo do servidor em execução futura. | **H01/H03** e T08–T16. Criar matriz de mensagens/contratos com hash/data da referência corrente, indicando desconhecidos. |
| R06 | Auditoria Codex 2026-09-08, linha 296: ampliar testes reais do motor | **Parcial, com avanços comprovados.** Suites existentes cobrem preload inteiro com mocks; há registros antigos de combate/captura/recuperação. Não cobrem integralmente todos os caminhos reais ou novos achados. | T01,T09–T18 e **H02/H03**. Separar testes que executam código real com mocks de testes conectados ao jogo; exigir evidência de cada cenário antes do fechamento. |
| R07 | Auditoria Codex 2026-09-08, linha 297: Electron/jogo/build/artefato | **Fechamento histórico 2.4.1; novo candidato não validado.** delivery-audit.md tem evidência daquela versão; diretórios e scripts atuais divergem. | **H02/H04**, T19/T20. Smoke, jogo e artefato devem identificar o mesmo candidato; a aprovação antiga não certifica build novo. |
| R08 | Auditoria Codex 2026-09-08, linha 298: README/QUICKSTART/tests/logbook | **Fechamento histórico; documentação corrente precisa correção.** O fechamento 2.4.1 cobre a época, não inconsistências posteriores. | **H04**, T24; mesma execução documental pode atender R03/R08 sem duplicar trabalho, mantendo ambas as referências. |
| R09 | Correção do laboratório, linha 314: ida/entrega/retorno no jogo | **Pendente real para entrega efetiva.** Fechamento posterior comprova consulta/retorno/reconexão; tests.md declara ausência de lote elegível. Entrega confirmada foi simulada. | **H03**, T14/T16. Exigir consumo de lote elegível confirmado pelo servidor e retorno; consulta sem entrega não fecha o item composto. |
| R10 | Correção do laboratório, linha 315: publicar pacote e evidências | **Publicação histórica 2.4.2 registrada; não é nova publicação pendente automática.** Fechamento registra pacote/testes/diário daquela versão. | **H04**, T19/T20. Reconciliar versão histórica separadamente; pacote futuro somente após verificação e autorização aplicável. Não publicar outra vez só porque checkbox antigo está vazio. |

### Itens marcados [x] que exigem ressalva ou revalidação

1. **Phase 19, grama “genuína”/100%:** a implementação heurística pode existir, mas a prova da fórmula nativa é explicitamente negada pela auditoria posterior. Manter R01 aberto; teste que apenas repete o filtro não comprova o requisito de Luca.
2. **Trocar conta, pedido atual:** o próprio item limita o aceite à sessão sintética. Não esconder a falta de login da segunda conta sob o [x]; completar em H02.
3. **Pacote único, pedido atual:** registro histórico aponta dist-desktop, enquanto package.json atual aponta dist-release e ambos existem. T19 deve conciliar o requisito de uma distribuição canônica; não assumir que mudar diretório resolve. Não apagar um pacote de Luca sem verificar uso e preservação do rollback.
4. **Phase 20, chaves fantasmas eliminadas:** iv_collection_threshold/iv_sell_threshold ainda aparecem em main.js:36–37. T05 resolve a divergência; o [x] anterior não é evidência de ausência.
5. **Phase 20, revive e operação 24/7:** existência de função/watchdog não demonstra precedência correta nem soak prolongado. T11/T18 exigem testes; não usar a expressão 24/7 como certificado.
6. **Phase 20, troca de rota e espécie fixada:** controles e bindings existem. T16 melhora o fluxo já implementado; este plano corrige a afirmação anterior de que faltava UI.
7. **Phase 9, dual dispatch:** foi substituído pela Phase 13 (single dispatch). Não restaurar uma implementação obsoleta para “cumprir” item histórico.
8. **Phase 18, retorno por 3,5 segundos:** foi substituído pela espera de confirmação nas correções posteriores do laboratório. Preservar a solução atual; timer fixo não pode voltar.
9. **Phase 16, decisões de Luca:** controle autoritativo do bot e captura direta/enfraquecimento seletivo já foram aprovados no registro. T12 deve respeitá-los, especificando lacunas técnicas sem pedir novamente uma decisão já tomada.

### H01 — Concluir requisito herdado da grama nativa (obrigatório, pendente)
- **Origem:** R01/R05. **Responsável:** Codex especifica e revisa; Hermes investiga. **Dependência:** nenhuma para pesquisa; T09/T15 para integração.
- **Escopo por lote:** relatório de protocolo e fixtures; depois preload e testes, separados. Usar research/2026-09-09-usability-audit.md como ponto de partida, não reiniciar pesquisa sem consultar o que já foi tentado.
- **Ordens:** identificar referência atual por URL/data/hash; localizar algoritmo do AUTO nativo e distinguir seleção de terreno, transitabilidade e renderização. Se houver fonte verificável, traduzir regras em fixtures antes de editar. Comparação empírica limitada deve declarar mapas/casos observados e não ser promovida a equivalência geral. Não substituir o objetivo por “melhorar BFS”.
- **Aceite:** regra nativa verificável e implementação alinhada com testes derivados de referência independente; documentar limitações residuais. Sem essa referência, entregar investigação, evidência do bloqueio e próximo dado necessário, mantendo H01/R01 abertos.
- **Verificação:** relatório + fixtures e testes de navegação; observação real apenas no escopo autorizado. Nem smoke, nem classificação fringe, nem testes de quatro mapas isolados comprovam fórmula universal.

### H02 — Completar validação real de interface, contas e navegação (obrigatório, pendente)
- **Origem:** R02/R06/R07. **Responsável:** Hermes executa roteiro preparado por Codex. **Dependências:** candidato identificado em T19 e roteiro offline pronto em T20/T23.
- **Ordens:** preparar primeiro roteiro reproduzível com versão/hash, tela inicial, tutorial/ajuda/fechamento, presets antes/depois de salvar, radar, pausa, reload, login, logout, segunda conta e navegação. Reutilizar autorização válida se já existir; não iniciar nova ação de conta com base somente neste plano. Credenciais são inseridas pelo usuário, sem coleta pelo executor.
- **Aceite:** evidência real separada por etapa e perfil; troca não mistura dados/configuração indevidamente; navegação não deixa motor agir na sessão antiga; regressões do mesmo fonte aprovadas. Etapa não exercitada permanece pendente mesmo se outras passarem.
- **Verificação:** relatório com timestamp/hash e resultados, capturas sem dados sensíveis quando necessárias; teste sintético identificado como sintético. Ausência de segunda conta disponível bloqueia apenas esse subitem.

### H03 — Comprovar ciclo completo de entrega no laboratório (obrigatório, pendente)
- **Origem:** R09 e parte de R05/R06. **Responsável:** Codex define lote/limites; executor observa e registra. **Dependências:** T13/T14, candidato identificado e autorização aplicável para consumo real.
- **Ordens:** verificar previamente lote elegível com cópia preservada, IVs completos, sem shiny/lock/evento/equipe e cargas disponíveis. Fixar limite de uma entrega no roteiro; registrar estado anterior sanitizado. Observar ida, resposta do Professor, solicitação única, confirmação de consumo/recompensa, retorno e retomada/pausa. Se não existe lote seguro, não fabricar excedente nem baixar proteções: manter pendência explicitamente.
- **Aceite:** entrega efetiva comprovada pelo servidor e delta consistente da coleção/cargas; retorno confirmado. Consulta vazia, ausência de erro e simulação de ack não atendem esse aceite. Falha/rejeição gera investigação e teste de regressão antes de nova tentativa.
- **Verificação:** relatório sanitizado vinculado à versão/hash; confrontar comandos e snapshots. Não prometer rollback de criatura consumida: qualquer consumo depende da autorização correspondente e da política de proteção.

### H04 — Reconciliar documentação, distribuição canônica e encerramento (obrigatório, parcial)
- **Origem:** R03/R07/R08/R10 e requisito de pacote único. **Responsável:** Hermes prepara; Codex aceita. **Dependências:** T19/T20/T24 para nova distribuição; atualizações factuais podem ocorrer antes.
- **Ordens:** mapear fonte→candidato→artefato entregue com hashes; distinguir pacote histórico de novo. Documentar um caminho canônico de distribuição e tratar outras cópias como candidato/rollback explicitamente, sem entregas concorrentes ambíguas. Preservar evidência e obter autorização aplicável antes de publicação/remoção/substituição. Atualizar README/QUICKSTART/tests/auditoria/diário com resultados e pendências reais.
- **Aceite:** documentação corresponde ao artefato verificado, checkboxes antigos reconciliados com referência específica e H01/H02/H03 continuam abertos enquanto faltar prova. Não marcar uma entrega global como concluída se ainda exige grama ou ciclo real não atendidos.
- **Verificação:** verificador do candidato, links/comandos e comparação da matriz R01–R10 com task_plan.md; revisão independente por Codex. Atualizar o registro histórico sem apagar justificativas nem publicar novamente versão já entregue por engano.

### Regra de fechamento e handoff corrigidos

As 27 tarefas T continuam válidas com as correções acima, mas não esgotam as pendências herdadas. Antes de delegar, informar ao executor quais R/H sua tarefa atende e qual prova permite fechar cada uma. T15 não fecha H01; T20 não fecha login real em H02; T14 não fecha entrega real em H03; registrar este plano no diário não fecha H04.

Nesta revisão foram corrigidos somente documentos. Os dez checkboxes antigos foram preservados. A matriz explica quais estão desatualizados, quais têm fechamento histórico e quais continuam pendentes de fato. A próxima execução deve começar por essa distinção, não por presumir que o backlog anterior foi encerrado.
