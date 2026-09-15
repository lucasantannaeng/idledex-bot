# Auditoria do contrato Box — 2026-09-15

Escopo: leitura do bundle público `index-Ykq_gMSa.js` e comparação com `electron/preload-game.js`. Os offsets abaixo são índices JavaScript de caracteres no bundle (compatíveis com `node research/protocol-20260915/inspect.cjs --slice OFFSET TAMANHO`). Nenhuma operação foi enviada à conta. As reproduções usaram somente o WebSocket simulado de `tests/engine-harness.cjs`.

## Contrato observado no cliente oficial

| Área | Evidência | Consequência |
| --- | --- | --- |
| Carregar Box | `E8`, offset 269062 aproximadamente: emite `box:open` sem payload se `boxLoaded` for falso. `ts`, 824514, registra consumidor via `CE`. | Box usa carregamento sob demanda. |
| Welcome | 1833574 e 1835208: atribui `snapshot.player.team` e marca `boxLoaded:false`. | Um roster vindo de welcome não comprova que a Box foi carregada. |
| Snapshot completo | Handler `team`, 1685122: recebe `t.creatures`, substitui o roster e marca `boxLoaded:true`. | A coleção completa observável vem do evento `team`, não de `collection:patch`. |
| Patch | 1685325: cria mapa de `t.creatures` e executa `team: previous.team.map(mon => updates.get(mon.id) ?? mon)`. | Substitui objetos existentes por ID; não insere desconhecidos nem remove ausentes. Não interpreta `deleted`/`removed`. |
| Lista da UI Box | `B3e`, 1661692: `team.filter(mon => mon.teamSlot === null)`; ordena por `boxSlot ?? 0`. | A UI mostra também criaturas sem slot de Box, incluindo anunciadas. Visibilidade não prova disponibilidade para consumir. |
| Seleção múltipla | `Gd`, 1639931: `!mon.isLocked && !mon.isListed`; `Rd=50`, 1038055. | Listados e bloqueados não podem ser selecionados. Limite visual: 50. |
| Soltar unitário | 1654769: botão desabilitado quando último membro da equipe, bloqueado ou listado. | O cliente oficial permite confirmação de shiny/mega; as proteções automáticas do bot devem ser mais conservadoras. |
| Confirmação da UI | `w3e`, 1645229; envio em 1668442: `creature:release`, `{creatureIds:[...]}`. | Payload do bot corresponde ao cliente. O limite de 30 do bot está abaixo do limite visual de 50. |
| Confirmação do servidor | Traduções em 473920/481383: notices `creature_released` usam nome/nível; `creatures_released` usa contagem. | Esses textos não comprovam correlação por ID. Ausência em snapshot completo posterior é uma evidência de remoção do roster; não prova isoladamente a causa. |
| Recusas conhecidas | 340496: `release_last_creature`, `release_too_many`; 344898: `starter_locked`. | Traduções evidenciam códigos reconhecidos pelo cliente, não a execução das validações no servidor. |

### Remoção e completude

Há somente um handler oficial de `team:patch`; ele não contém semântica de tombstone. As quatro ocorrências de `deleted` no bundle são textos/códigos de presets, não campos de criaturas. Não há ocorrência de `collection:patch`. Portanto os testes legados baseados em `{id, deleted:true}` não demonstram o contrato atual. A confirmação por desaparecimento deve aguardar um evento `team` completo e válido, e não um novo welcome parcial.

### Interpretação dos slots

| Forma observada | Interpretação comprovável | Consumo automático |
| --- | --- | --- |
| `teamSlot` definido e não nulo | Membro da equipe no cliente oficial | Proteger |
| `teamSlot:null`, `boxSlot` inteiro >= 0, `isListed:false` | Slot explícito de Box | Avaliar demais proteções e critérios |
| `teamSlot:null`, `boxSlot:null`, `isListed:true` | Anunciado no mercado; a UI Box exibe com marca de anúncio | Proteger |
| `teamSlot:null`, `boxSlot:null`, sem anúncio conhecido | Localização/estado operacional não comprovado | Aguardar roster completo; não inferir disponibilidade |
| Campos de localização ausentes | Schema incompleto ou legado | Não inferir disponibilidade |

Outros consumidores oficiais mantêm critérios mais estritos que a lista visual: cura usa `teamSlot===null && boxSlot!==null` (974000); venda/troca usa `boxSlot!==null` (1505020); seleção de doação usa `boxSlot!==null && !isShiny && !isMega && !isLocked` (1573209). Depot tem store separado via `depot:state` (1690567), portanto não é possível identificar Depot apenas pelo par null/null do roster.

O registro real informado pelo agente principal (coleção 8, equipe 6, todos com boxSlot nulo) não prova erro de dados. Faltam completude do roster, `teamSlot`, `isListed` e `listingId` dos dois restantes para classificá-los. Esta auditoria não inspecionou a conta.

## Diferenças confirmadas no preload antes das correções

1. `isProtectedCreature` verificava `mon.mega`, mas o bundle usa `mon.isMega`. Reproduzido offline: uma criatura `isMega:true`, fora da equipe, com Box slot 0 e IVs baixos gerou `creature:release`.
2. Faltava proteção explícita de `isListed`. Reproduzido offline com `isListed:true` e slot 0: cleanup emitiu release. O caso demonstra ausência do guard mesmo se a combinação não ocorrer normalmente no servidor.
3. `updateCreatures(p.team)` no welcome seguia a mesma reconciliação de ausentes que o snapshot completo. Um pending ausente de welcome poderia ser marcado como confirmado antes do retorno de `box:open`.
4. `team:patch` no preload faz merge/inserção e admite tombstone; o cliente oficial substitui somente objetos de IDs já presentes. Isso precisa permanecer distinguido de suporte legado deliberado.

O guard atual de Box slot inteiro rejeitou corretamente a reprodução com ambos os slots nulos. Não há evidência suficiente para removê-lo apenas porque a UI exibe o objeto.

## Casos de regressão recomendados

- Mega oficial (`isMega:true`) e listado (`isListed:true`) jamais geram release, mesmo com IVs baixos e slot explícito.
- Welcome parcial após release pendente não confirma a operação; posterior `team` completo ausente pode reconciliar o ID, sem reenviar automaticamente.
- Welcome parcial após Box carregada não autoriza decisões destrutivas com base na contagem reduzida.
- `team:patch` só atualiza IDs existentes no contrato atual e não confirma remoções por omissão.
- Um patch de HP não deve tornar consumível um registro de localização desconhecida.
- Snapshot inválido ou sem `creatures` não esvazia coleção nem confirma operações.
- `teamSlot:null/boxSlot:null/isListed:true` permanece visível para diagnóstico e protegido de consumo.
- `teamSlot:null/boxSlot:null/isListed:false` permanece de localização indeterminada até evidência adicional.
- Notice `creatures_released {count}` não deve confirmar todos os IDs pendentes de lotes diferentes.
- O pedido mantém `{t:'creature:release',d:{creatureIds:[...]}}` e limite conservador de 30.

Validação executada: script Node com `createEngine()` real do harness, sockets inteiramente simulados, retorno 0. Resultados anteriores à correção: Mega=1 pedido, listado=1 pedido, null/null=0 pedidos. O agente principal ficou responsável pelas correções e testes permanentes.
