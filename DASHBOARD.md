# idleDEX Bot - Dashboard Completo

## 🚀 Iniciar

```bash
cd D:/Projetos/1.Autorais/idledex-bot
pip install websockets aiohttp
python bot.py
```

## 📊 Dashboard Unificado

**URL:** `http://localhost:8080/dashboard`

### Abas disponíveis:

| Aba | Funcionalidade |
|-----|---------------|
| 🗺️ **Mapa** | Visualização em tempo real do jogador e criaturas no mapa 20x20 |
| ⚔️ **Batalha** | HP em barras, log de ataques/poções/capturas |
| 📊 **Estatísticas** | Rank, vitórias, derrotas, capturas, shinies, XP |
| 💰 **Mercado** | Ofertas de trade em tempo real |
| 📦 **Coleção** | Lista de Pokémon capturados com IVs, naturezas, tipos |
| ⚙️ **Config** | Ajustar modos, thresholds de IV, HP para fugir/capturar |

### Funcionalidades:

- ✅ **Conexão WebSocket** autenticada com token
- ✅ **Mapa em tempo real** - entidade do jogador (🧙) e criaturas (🐉/✨)
- ✅ **Batalhas** - log detalhado com cores (dano, cura, captura)
- ✅ **Estatísticas** - rank, wins, losses, XP atualizados
- ✅ **Mercado** - ofertas de trade aparecem automaticamente
- ✅ **Coleção** - Pokémon capturados com IV total e naturezas
- ✅ **Configurações** - ajuste de thresholds em tempo real
- ✅ **Histórico** - últimos 100 logs na lateral direita

## 🎮 Visualizador Alternativo

**URL:** `http://localhost:8080/visualizer`
- Interface mais simples focada em mapa e batalha

## 🛠️ Troubleshooting

### Porta 8080 ocupada
Altere em `bot.py` linha 643:
```python
bot.start_dashboard(port=8081)
```

### Dashboard não abre
1. Confirme que o bot está rodando
2. Verifique firewall se necessário
3. Use `http://127.0.0.1:8080/dashboard`

### Token expirou
Obtenha novo cookie no navegador:
- DevTools → Application → Cookies → `https://idledex.com`
- Cookie: `__Secure-better-auth.session_token`
- Cole em `bot.py` linha 639
