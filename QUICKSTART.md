# IdleDex Bot — Guia de Início Rápido (Quick Start)

Este guia cobre a execução do bot, renovação de token pelo navegador e personalização de estratégias.

---

## 1. Executando o Bot

### Opção A: Executável Standalone (Recomendado)
Sem necessidade de Python instalado ou comandos complexos:
1. Abra a pasta `dist\idledex-bot\`
2. Dê um duplo clique em `idledex-bot.exe` (ou execute via terminal).
3. Uma janela de console se abrirá informando que o Dashboard foi iniciado na porta 8080:
   ```text
   [INFO] Servidor HTTP Dashboard ativo em http://localhost:8080
   [INFO] Dashboard UI: http://localhost:8080/dashboard
   ```

### Opção B: Via Python Direto
```bash
cd D:\Projetos\1.Autorais\idledex-bot
pip install -r requirements.txt
python bot.py
```

---

## 2. Acessando o Painel de Controle (Dashboard)

Abra qualquer navegador moderno (Chrome, Edge, Firefox) e acesse:
👉 **[http://localhost:8080/dashboard](http://localhost:8080/dashboard)**

---

## 3. Configurando / Renovando seu Token de Acesso (Sem Reiniciar)

O bot foi projetado com tolerância a falhas: se o token expirar ou se você estiver usando pela primeira vez, o bot não trava nem fecha.

1. Faça login na sua conta em [https://idledex.com](https://idledex.com).
2. Pressione `F12` para abrir as Ferramentas do Desenvolvedor.
3. Vá na aba **Application** (ou Armazenamento) ➔ **Cookies** ➔ `https://idledex.com`.
4. Copie o valor do cookie `session_token` (ou copie todo o cabeçalho Cookie).
5. No dashboard do bot ([http://localhost:8080/dashboard](http://localhost:8080/dashboard)), cole o valor no campo de token (no banner de alerta vermelho ou no modal central).
6. Clique no botão **"Salvar & Conectar"**.
7. O bot salvará a chave em `config.json` e estabelecerá a conexão com o WebSocket imediatamente!

---

## 4. Funcionalidades em Destaque

- **Radar Matricial 20x20**: O canvas superior mapeia a posição do jogador (`P` em azul) e as criaturas selvagens (`W` em verde) ao redor.
- **Painel de Combate**: Visualize os pontos de vida (HP) em tempo real do seu pet e da criatura adversária.
- **Sliders de Estratégia**:
  - Ajuste os limiares de IV de captura e venda diretamente pelos sliders da interface.
  - Alterne entre os modos `balanced`, `collection` e `monetize`.
  - Clique em **"Salvar Ajustes"** para aplicar imediatamente sem reiniciar.
- **Auto-Idle**: Habilite o toggle de Auto-Idle para treinar seu monstro automaticamente enquanto ocioso.

---

## 5. Resolução de Problemas (Troubleshooting)

### Porta 8080 em uso
Se outra aplicação estiver usando a porta 8080, inicie com uma porta alternativa via Python:
```bash
python bot.py --port 8081
```

### O token não é aceito
Certifique-se de que o token foi copiado enquanto você estava autenticado no jogo. O bot aceita tanto o valor puro do token quanto a string de cookie completa (`session_token=...`).

### Executável fecha imediatamente
Execute `idledex-bot.exe` a partir de uma janela de prompt de comando (`cmd.exe`) para visualizar mensagens de erro de permissão ou firewall.
