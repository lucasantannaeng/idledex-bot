---
title: "IdleDex Bot — auditoria e correções em andamento"
date: 2026-09-08
author: codex
status: em-andamento
---

- Avaliado o projeto Electron em D:/Projetos/1.Autorais/idledex-bot e comparado com o bundle público atual index-DwmEwqo-.js.
- Corrigidos reconexão, concorrência de carregamento de mapas, ações durante pausa, restauração de configuração, HP de combate, equipe/Box e estoque zero.
- Criados 13 testes de regressão do código real; todos aprovados. Distribuição candidata compilada e smoke de painel/preload em Electron real aprovado, em perfil isolado sem login.
- Documentação de contratos e evidências: research/2026-09-08-audit.md, progress.md e findings.md no projeto.
- Entrega final ainda pendente: validar mudanças no jogo, concluir auditoria de temporização, NPCs/IVs/descarte/autoviagem e reconstruir distribuição final. Aplicativo original não substituído.

## Continuação — combate, NPCs e teste real
- Ampliada a suíte para 23 testes aprovados: temporização, captura pelo result oficial, IVs completos, proteção de criaturas, Professor/Colecionador/autoviagem e sequência de movimento.
- Aplicativo atualizado com versão candidata e reconectado. Teste real de 30s identificou cura repetida recusada por saldo insuficiente; configuração pausada foi restaurada.
- Corrigida cura parcial conforme saldo (18 prata não paga equipe30, mas paga um integrante10), com cooldown e trava após erro; correção mais recente ainda aguarda teste real e nova compilação.
- Objetivo permanece em andamento; não entregue como pronto para uso.

## Continuação — persistência, recompensas e documentação
- Cura parcial e captura foram verificadas no jogo: uma captura e nenhum erro na janela observada; bot restaurado pausado.
- Corrigidos carregamento parcial, gravação atômica, tratamento de falha no painel e CDP opcional. Diárias e passe agora usam elegibilidade do cliente oficial.
- 29 testes aprovados, candidata compilada e smoke aprovado. README/QUICKSTART/tests.md atualizados para Electron.
- Distribuição final e auditoria das demais recompensas ainda pendentes; entrega não declarada concluída.

## Entrega — IdleDex Desktop 2.4.1
- Concluída revisão do aplicativo Electron e engenharia reversa do cliente público atual. Corrigidos conexão, configuração, combate, captura, recuperação, IVs, NPCs e recompensas.
- 31 testes aprovados, smoke Electron aprovado, execução real sem erros nas janelas verificadas e captura comprovada.
- Distribuição em D:/Projetos/1.Autorais/idledex-bot/dist-desktop/win-unpacked/IdleDex Desktop.exe. Sessão preservada, bot pausado e porta de diagnóstico desligada.
- Evidência completa e limites: research/delivery-audit.md e research/release-verification.json no projeto. Autor: Codex.

## Correção 2.4.2 — ciclo do laboratório
- Corrigido abandono do fluxo após shard:redirect/welcome; origem lembrada, entrega confirmada por estado do Professor, sem retorno fixo em3.5s nem patrulha liberada por timeout no lab.
- Bloqueada caça dentro do laboratório e repetição de viagens pelo mesmo conjunto de excedentes. Recuperação após pausa/reconexão e retorno com tentativas limitadas.
- 38 testes aprovados e smoke final aprovado. Teste real confirmou consulta ao Professor e retorno à Rota14 sem erros/movimento. Sem lote elegível na conta; entrega efetiva testada contra protocolo simulado.
- Distribuição2.4.2 atualizada e sessão deixada pausada na Rota14. Evidências no projeto: tests/lab-trip.test.cjs, research/live-validation-lab.json, research/release-verification.json. Autor: Codex.
