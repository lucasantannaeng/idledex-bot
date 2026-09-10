# Pedido de usabilidade — auditoria em andamento

## Evidências
- Tutorial e ajuda: `app/help.js`, 34 tópicos; teste Electron offline valida abertura, fechamento, Escape, cobertura de todos os campos e navegação para a seção correta.
- Presets: regressão reproduziu herança incorreta de filtro shiny e parâmetros do modo anterior. Agora os três presets preenchem captura de maneira determinística, preservando outras automações, alvos e pausa. Salvar aplica ao jogo.
- Contas: `electron/account-session.js` encerra páginas da partição do jogo antes de limpar sessão. Teste Electron com cookies sintéticos demonstra remoção da sessão Google/jogo e preservação de outra partição e das opções do bot. Não foi feito login em uma segunda conta real.
- Fontes das APIs: https://www.electronjs.org/docs/latest/api/session#sesclearstoragedataoptions e https://developers.google.com/identity/openid-connect/openid-connect (prompt select_account).
- Pacote canônico: `dist-desktop/win-unpacked/IdleDex_Desktop.exe`; versão 2.5.0. Candidata removida, verificador aprovou oito arquivos idênticos ao fonte e manifesto 2.5.0. Aplicativo reiniciado pelo caminho canônico; configuração pausada preservada.

## Grama — requisito NÃO concluído
- Cliente público baixado novamente em 2026-09-09: https://idledex.com/assets/index-BPTg-fzT.js. Cópia local ignorada pelo Git.
- O cliente define `V_={Grass:1,Path:2}` e `Wfe` para transitabilidade. `fringeMask` é usado por `isFringeTile` e `updateFringeFade` para renderização.
- `idle:set` envia `idle:start`/`idle:stop` ao servidor. A seleção de grama do automático não foi encontrada no cliente público; nenhum código do servidor foi disponibilizado.
- O bot atual ainda usa um filtro próprio: grid 1, exclui fringe, descarta componentes menores que 4 e usa BFS. Não há prova de que corresponda à fórmula nativa; NÃO rotular essa heurística como fórmula oficial.
- Solicitada referência/código do servidor ao usuário enquanto se concluem os outros itens. Não substituir este requisito por um algoritmo apenas plausível, nem marcar o objetivo completo.

### Revalidação na continuação
- Fonte oficial https://idledex.com/en/ confirma que passos, encontros, batalhas e capturas são decididos no servidor; AUTO funciona com aba fechada.
- Bundle local não inclui sourceMappingURL ou links GitHub. Busca no workspace e busca pública não localizaram fonte do servidor ou documentação da seleção de grama.
- verify-release.cjs novamente aprovado; não houve alteração da heurística sem referência verificável.
