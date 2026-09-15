# IdleDex Desktop 2.5.1

Aplicativo Electron com o jogo embutido e controles locais de captura, combate,
patrulha, recupera??o, Box e entregas. O produto principal ? o Desktop.

## Abrir a vers?o corrigida

- Port?til: `dist-release/IdleDex_Desktop_Portable_2.5.1.exe`.
- Instalador: `dist-release/IdleDex_Desktop_Setup_2.5.1.exe`.
- Pasta completa: `dist-release/win-unpacked/IdleDex_Desktop.exe`.

Feche a vers?o anterior antes de abrir a nova. Para atualizar um atalho de uma
instala??o existente, use o instalador 2.5.1. A sess?o e as op??es ficam no perfil
local do Electron, separadas do pacote. Fa?a login pelo jogo; n?o ? necess?rio
copiar cookies ou tokens.

## Foco de captura

Em **Config ? Spawns da ?rea**, marque as esp?cies desejadas. As altera??es da
lista s?o salvas imediatamente. **Marcar Todos** seleciona todas as esp?cies;
**Desmarcar** remove os alvos comuns. **N?o Selecionados** determina se o bot luta
por XP ou foge. Esp?cies fixadas e Shinies mant?m a prioridade descrita no Tutorial.

Os dois campos **Fixar Esp?cie** aceitam as esp?cies detectadas na ?rea. Selecione
o foco e clique em **Salvar Ajustes**. O foco bloqueia op??es conflitantes de
troca de rota e captura apenas de in?ditos. A lista aceita IDs num?ricos e mant?m
o foco do teclado durante atualiza??es de captura.

## Limpeza da Box

Escolha o percentual m?nimo de IV ou os m?nimos individuais, natureza e nota
m?nima. **Executar Limpeza de Box Agora** salva os ajustes exibidos, aplica ao
motor e solicita a limpeza. Se a grava??o falhar ou o jogo estiver recarregando,
a limpeza n?o inicia. O Console informa falta de conex?o, aus?ncia de crit?rios,
nenhum candidato e pedidos enviados ao servidor.

- Sem crit?rios ativos, nenhuma criatura ? liberada.
- Equipe, Shinies, criaturas bloqueadas e recursos reservados n?o s?o descartados.
- A prote??o da ?ltima c?pia ? ativada por padr?o e considera o lote inteiro.
- Dados necess?rios ausentes mant?m a criatura at? uma atualiza??o suficiente.
- A nota m?nima funciona como prote??o adicional: atingir a nota conserva a
  criatura mesmo quando ela n?o passa em IV/natureza.
- Um pedido enviado n?o equivale a descarte confirmado. O motor aguarda o servidor.

A rotina autom?tica de limpeza usa as op??es salvas. IVs e natureza s?o avaliados
ap?s captura; o bot n?o conhece valores que o servidor n?o enviou.

## Pausa e conta

**Pausar Bot** interrompe o motor local. Se **Auto-Idle Nativo** estiver marcado,
o jogo pode continuar pelo AUTO. Desative essa op??o para controle manual.
Suspens?o do computador, falha do renderer e troca de conta param ambos os modos.
Uma grava??o pendente n?o deve reativar uma pausa autom?tica.

Use **Sair / Trocar conta** para limpar a sess?o do jogo. As configura??es s?o
preservadas, com automa??o pausada. Revise os alvos antes de retomar na nova conta.
O teste de troca de sess?o ? sint?tico; login em uma segunda conta real continua
sem comprova??o nesta revis?o.

## Desenvolvimento e distribui??o

```powershell
npm.cmd ci
npm.cmd test
npm.cmd start
npm.cmd run pack
npm.cmd run dist:portable
npm.cmd run dist:installer
```

O preload ? gerado automaticamente pelos scripts de teste, execu??o e build.
O runtime instalado e testado nesta revis?o ? Electron 33.4.11. A atualiza??o de
runtime do backlog continua pendente; a vers?o 2.5.1 corrige a aplica??o.

Consulte [tests.md](tests.md) para smoke e integridade do candidato, e
[QUICKSTART.md](QUICKSTART.md) para opera??o. Diagn?stico local:
`npm.cmd start -- --inspect-bot`; a porta de depura??o n?o abre no uso normal.

## Evid?ncia e limites

A revis?o cobre o c?digo real com simula??es de protocolo e cliques no DOM do
Electron, usando perfil descart?vel e rede offline. N?o houve libera??o de
criaturas na conta real. Isso n?o comprova todos os contratos do servidor, login
real de segunda conta ou consumo efetivo de lote no laborat?rio. A navega??o
local usa heur?stica; n?o h? prova de equival?ncia ao algoritmo de grama nativo.

A auditoria atual est? em [research/2026-09-15-functional-audit.md](research/2026-09-15-functional-audit.md).
`plan.md` e `task_plan.md` preservam requisitos e hist?rico; checkboxes hist?ricos
n?o substituem evid?ncia do candidato atual.

## Legado

`bot.py`, `config.py`, `economy.py`, a spec PyInstaller e o userscript foram
preservados. H? regress?es locais de HTTP, persist?ncia, cookies, economia e
ciclo de vida WebSocket. O Python requer `websockets>=14.0` para a API usada.
O userscript ainda cont?m mensagens de combate antigas e n?o ? equivalente ao
Desktop. Os execut?veis Python antigos n?o foram reconstru?dos nesta entrega.

<<<<<<< HEAD
### Option A: Portable Standalone Executable (Recommended for End Users)
1. Baixe o executável compilado `IdleDex_Desktop_Portable_2.5.0.exe` (com o ícone da **Master Ball**).
2. Execute o arquivo diretamente em qualquer computador com Windows 10/11 x64 (não requer instalação de Node.js, Python ou extensões).
3. Faça login normalmente na sua conta IdleDex pela janela embutida.
4. Ajuste suas preferências no painel lateral, clique em **Salvar Configurações** e ative o botão **Ligar Bot**.

### Option B: Running from Source (Developers)

#### Prerequisites
* Node.js `>= 18.0.0`
* npm `>= 9.0.0`

#### Installation & Development
```bash
# Clone the repository
git clone https://github.com/lucasantannaeng/idledex-bot.git
cd idledex-bot

# Install dependencies
npm ci

# Run test suites
npm test

# Launch in development mode
npm start

# Launch with Chrome DevTools Protocol diagnostics enabled (port 9222)
npm start -- --inspect-bot
```

#### Compiling the Portable Executable
```bash
# Build standalone single-file portable .exe
npm run dist:portable
```
O executável gerado estará disponível em `dist-release/IdleDex_Desktop_Portable_2.5.0.exe`.

---

## 🧪 Testing & Verification

O projeto conta com suítes automatizadas de testes cobrindo integridade de empacotamento, regressão de protocolo e ciclo de vida Electron:

```bash
# Run full Node test suite (109 unit/integration tests)
npm test

# Run DOM sanitization, CSP & tutorial offline tests
node --test tests/dashboard-dom.test.cjs

# Run legacy Python server security unit tests (9 tests)
python -m unittest discover tests

# Build distribution package into dist-release
npm run pack

# Run isolated Electron candidate smoke test
npx electron tests/electron-smoke.cjs --app-dir dist-release/win-unpacked/resources/app

# Run candidate release integrity and allowlist verifier
node research/verify-release.cjs --app-dir dist-release/win-unpacked/resources/app
```

---

## 📄 License & Credits

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
Autor: Luca Rodrigues Gomes de Sant'Anna.

*Disclaimer: IdleDex is an independent educational automation tool.*
