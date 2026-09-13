# Validação Electron

Na raiz do projeto:

```powershell
npm.cmd test
npm.cmd run pack -- --config.directories.output=dist-candidate
& './node_modules/electron/dist/electron.exe' tests/electron-smoke.cjs
```

A suíte Node executa preload e dashboard com WebSocket, IPC e relógio simulados. Cobre configuração, persistência, reconexão, mapas, movimento, combate, recuperação, captura, IVs, proteção de criaturas e elegibilidade de recompensas/NPCs.

O smoke abre arquivos do pacote candidato em Electron com perfil isolado e página HTTPS local de teste. Confira a data de `research/smoke-result.json` e a imagem `research/smoke-dashboard.png`. Não comprova autenticação, servidor real nem toda a inicialização do processo principal.

Para inspeção real, abra o aplicativo com `--inspect-bot` e execute `node research/inspect-live.cjs`. O diagnóstico lê telemetria sem extrair credenciais.

`node research/validate-live.cjs --capture` executa 30 segundos de ações reais, podendo consumir poções e bolas. Restaura a configuração ao terminar e grava `research/live-validation.json`. Uma batalha iniciada pode continuar depois da observação.

Evidência obtida: recuperação, combate e uma captura sem erros do servidor na janela observada. Isso não prova todos os NPCs, recompensas ou estabilidade indefinida. A distribuição 2.4.1 foi atualizada e reiniciada com a sessão preservada; consulte `research/delivery-audit.md`.

`node research/validate-live.cjs --rewards` verifica consultas de recompensas sem patrulhar; pode resgatar prêmios elegíveis e usar itens de recuperação. `node research/verify-release.cjs` compara os arquivos distribuídos com o fonte e confere o manifesto. A última suíte completa passou com 31 testes.

## Correção 2.4.2 — laboratório

Suíte completa: 38 testes aprovados. `tests/lab-trip.test.cjs` cobre resposta atrasada, confirmação de consumo, falta de cargas, timeout, pausa/retomada, chegada por nova conexão/welcome e ausência de movimento em lab caminhável.

Teste real em `research/live-validation-lab.json`: Professor respondeu, não havia lote elegível preservando uma cópia, e o bot voltou do npclab à route_014. Houve shard:redirect e nova conexão; nenhum erro do servidor nem comando move na observação. Entrega efetiva de lote foi verificada por simulação do protocolo, pois a coleção atual não oferecia lote elegível. A cura habilitada recuperou10HP do líder e custou42prata.

Smoke final aprovado em 2026-09-09T02:34:02.961Z. Distribuição 2.4.2 conferida por verify-release.cjs.

## 2.5.0 — Usabilidade e contas
- npm.cmd test: 41 testes aprovados (baseline inicial).
- tests/electron-smoke.cjs usa por padrão dist-desktop. IDLEDEX_SMOKE_SOURCE=1 permite testar fonte sem outro pacote.
- Smoke offline: tutorial com 34 seções, todos os campos com ajuda, navegação à seção certa, fechamento e Escape, limpeza de cookies sintéticos de jogo/Google preservando outra partição e configuração.
- research/verify-release.cjs exige smoke da distribuição, saída validada, igualdade dos arquivos e ausência de dist-candidate.
- Sem prova de fórmula nativa da grama e sem login numa segunda conta real. Não extrapolar o teste sintético para autenticação completa com o provedor.

## 2.5.0 — Execução Integral do Backlog Mestre (T01–T27, H01–H04, R01–R10)
- `npm test`: 109 testes aprovados (motor de combate, captura autoritativa, parsing binário transacional, segurança de IPC/webview, precedência de revives, máquina de estados de rotas, confirmação de descarte de Box, deduplicação de NPCs e integridade de distribuição).
- `node --test tests/dashboard-dom.test.cjs`: 6 testes aprovados (CSP restrita sem scripts inline, sanitização contextual contra XSS, inicialização segura "BOT PAUSADO").
- `python -m unittest discover tests`: 9 testes aprovados (contenção do servidor HTTP legado, bind estrito em loopback 127.0.0.1, autenticação por token local efêmero, limite de body 64KB, drenagem segura de socket em 413).
- Empacotamento canônico: `npm run pack` compila para `dist-release/win-unpacked`.
- Smoke de distribuição: `npx electron tests/electron-smoke.cjs --app-dir dist-release/win-unpacked/resources/app` aprovado, com registro de hash do candidato em `research/smoke-result.json` e captura em `research/smoke-dashboard.png`.
- Verificador de integridade: `node research/verify-release.cjs --app-dir dist-release/win-unpacked/resources/app` aprovado (15 arquivos distribuídos conferidos contra allowlist estrita, hash do candidato correspondente ao smoke e zero vazamento de arquivos sensíveis).
- Rastreabilidade H01–H04: heurística de grama isolada com floodfill/fringe sem alucinar equivalência nativa (H01/R01); isolamento sintético de sessões e logout auditado (H02/R02); máquina de estados do lab com retenção de última cópia e sem falsos acks (H03/R09); documentação e cadeia de distribuição canônica unificada (H04/R10).

