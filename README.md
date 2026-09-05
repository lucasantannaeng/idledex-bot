# IdleDex Desktop Suite v2.0 — Embedded Chromium & Autonomous Engine

Suíte desktop completa em Electron para o jogo IdleDex. Integra navegador Chromium nativo (`https://idledex.com/play`) em layout split-screen com barra lateral cibernética retrátil de telemetria e automação autônoma.

> [!IMPORTANT]
> **Zero Desconexões & Zero Cópia Manual de Token:**
> O motor autônomo opera diretamente dentro do WebSocket nativo do navegador embutido via preload de protocolo (`preload-game.js`). Isso elimina 100% dos conflitos de conexão única do servidor, prevenindo os kicks automáticos e deslogamentos (`authClient.signOut()`).

---

## ⚡ Inicialização Rápida

### Opção 1: Executável Desktop Portátil (Recomendado — Sem Dependências)
1. Navegue até a pasta da distribuição:
   ```cmd
   cd dist-desktop\win-unpacked
   ```
2. Execute o binário:
   ```cmd
   "IdleDex Desktop.exe"
   ```
3. Faça login no jogo normalmente na janela embutida à esquerda. A barra lateral à direita assume o controle e a telemetria instantaneamente!

### Opção 2: Modo de Desenvolvimento (Node.js)
1. Instale as dependências:
   ```bash
   npm install
   ```
2. Inicie a aplicação:
   ```bash
   npm start
   ```

---

## 🖥️ Arquitetura da Suíte Desktop

- **Split-Screen Integrado**: O jogo oficial roda em Chromium com persistência total de cookies (`partition="persist:idledex"`).
- **Injeção de Protocolo no Preload (`preload-game.js`)**: Intercepta a criação do `window.WebSocket` da página e escuta/transmite frames binários e pacotes JSON diretamente pela mesma conexão da aba.
- **Barra Lateral Cibernética Retrátil (`app/app.js`)**:
  - **Radar Tático (Grid 20x20)**: Canvas matricial em tempo real plotando a posição do jogador (azul), monstros selvagens (vermelho/rosa pulsante) e outras entidades (cinza).
  - **Painel de Batalha**: Monitoramento de duelo ao vivo com barras dinâmicas de HP do Pokémon ativo e do oponente.
  - **Telemetria & KPIs**: Rank, XP acumulado, vitórias, derrotas, capturas, shinies raros, moedas e cristais.
  - **Mochila (Inventário)**: Pokébolas, Greatbolas, Ultrabolas e Poções em tempo real.
  - **Parâmetros Estratégicos**: Modos equilibrado/coleção/venda, limites de IV, gatilhos de fuga, poção e captura, com salvamento atômico em disco.
- **Bandeja do Sistema (Tray)**: Permite minimizar para a bandeja e continuar caçando em segundo plano sem congelamento (`backgroundThrottling: false`).

---

## 📦 Compilação da Aplicação Desktop
Para gerar novamente a distribuição desktop portátil (`win-unpacked`):
```cmd
npm run pack
```
Os arquivos e executável serão gerados em `dist-desktop/win-unpacked/IdleDex Desktop.exe`.

---

## 🐍 Modo Legado / Alternativo (Python Standalone Engine)

---

## 🔑 Renovação de Token Sem Reiniciar (Zero-Downtime)

Quando seu token do jogo expirar ou se você estiver iniciando pela primeira vez:
1. Acesse o jogo no navegador (`https://idledex.com`) e copie seu token de sessão (via Cookie `session_token` no DevTools Application ou Storage).
2. Abra o dashboard do bot: [http://localhost:8080/dashboard](http://localhost:8080/dashboard).
3. Caso o token não esteja configurado ou tenha expirado, um alerta vermelho pulsante e um modal de renovação aparecerão imediatamente no topo da tela.
4. Cole o token (ou cookie completo) e clique em **"Salvar & Conectar"**.
5. O bot sanitiza o token, persiste automaticamente no arquivo `config.json` e dispara a reconexão imediata ao WebSocket do gateway sem necessidade de reiniciar o executável!

---

## 📊 Recursos do Dashboard Web (`:8080`)

- **Radar Canvas 20x20**: Visualização matricial em tempo real da posição do jogador (`P`) e das criaturas selvagens (`W`) detectadas pelo radar binário.
- **Painel de Batalha**: Monitoramento ao vivo do combate ativo com barras de progresso dinâmicas de HP do seu pet vs HP do monstro selvagem.
- **Cards de Telemetria e KPIs**:
  - Status da conexão WebSocket (Online / Desconectado / Token Expirado).
  - Shard ativo e Latência de Heartbeat (`ping`).
  - Total de Capturas e Taxa de Sucesso.
  - Ouro acumulado e saldo de DolarDex.
- **Controle Dinâmico de Estratégia**:
  - Sliders para Limite Mínimo de IV de Captura e IV de Venda.
  - Seleção de estratégia de inventário (`balanced`, `collection`, `monetize`).
  - Toggle de Auto-Battle, Auto-Catch e Auto-Idle.
  - Botão **"Salvar Ajustes"** que sincroniza em tempo real com o backend via `/api/config`.
- **Feed de Logs em Tempo Real**: Console estilo terminal com auto-scroll para inspecionar eventos do gateway, encontros e capturas.

---

## 🛠️ Endpoints da API REST Local

O bot expõe uma API REST leve no endereço `http://localhost:8080`:

| Endpoint | Método | Descrição |
|---|---|---|
| `/dashboard` | `GET` | Interface visual de controle e telemetria |
| `/visualizer` | `GET` | Mapa visual da grade de entidades |
| `/state` | `GET` | JSON com estado completo da sessão, jogador, inventário e logs |
| `/logs` | `GET` | JSON contendo os últimos 100 eventos do terminal |
| `/api/token` | `POST` | Atualiza o token de sessão e aciona reconexão imediata (`{"token": "..."}`) |
| `/api/config` | `POST` | Atualiza parâmetros operacionais e persiste em `config.json` |
| `/api/connect` | `POST` | Inicia o loop de conexão WebSocket |
| `/api/disconnect` | `POST` | Desconecta do gateway do jogo |

---

## ⚙️ Configuração (`config.json`)

As configurações são mantidas em `config.json` e recarregadas a cada inicialização:

```json
{
  "token": "seu_token_aqui",
  "shard": 0,
  "strategy": "balanced",
  "min_iv_keep": 130,
  "min_iv_sell": 130,
  "auto_catch": true,
  "auto_battle": true,
  "auto_idle": true,
  "discord_webhook": ""
}
```

---

## 📦 Compilação do Executável Standalone

Para gerar novamente a distribuição standalone multi-arquivos (`--onedir`):

```cmd
pyinstaller idledex-bot.spec --noconfirm
```

Os binários prontos para uso serão gerados na pasta `dist/idledex-bot/`.
