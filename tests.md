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
- npm.cmd test: 41 testes aprovados.
- tests/electron-smoke.cjs usa por padrão dist-desktop. IDLEDEX_SMOKE_SOURCE=1 permite testar fonte sem outro pacote.
- Smoke offline: tutorial com 34 seções, todos os campos com ajuda, navegação à seção certa, fechamento e Escape, limpeza de cookies sintéticos de jogo/Google preservando outra partição e configuração.
- research/verify-release.cjs exige smoke da distribuição, saída validada, igualdade dos oito arquivos e ausência de dist-candidate.
- Sem prova de fórmula nativa da grama e sem login numa segunda conta real. Não extrapolar o teste sintético para autenticação completa com o provedor.
