# idleDEX Bot Tests

## Teste Unitário do Type Chart

```python
# Test rapid
python -c "
from bot import get_effectiveness, Type

# Fire vs Water = 0.5
assert get_effectiveness(Type.FIRE, [Type.WATER]) == 0.5
# Electric vs Water = 2.0
assert get_effectiveness(Type.ELECTRIC, [Type.WATER]) == 2.0
# Normal vs Ghost = 0 (immune)
assert get_effectiveness(Type.NORMAL, [Type.GHOST]) == 0
print('✓ Type chart tests passed')
"
```

## Teste da Suite Autônoma Desktop v2.0 (Phase 9)

```bash
# Execução da suíte de verificação do motor BFS, dual-dispatch de combate e supressão de spam:
node "C:\Users\Luca Rodrigues\.gemini\antigravity\brain\2f45b7d2-b49b-4059-b306-0bccc58442bf\scratch\test_engine.js"
```

Valida:
1. Algoritmo BFS para roteamento do menor caminho navegável até a grama alta na malha 150x150.
2. Ingestão correta de `d.leader.moves` em `battle:start`.
3. Dual-dispatch com clique DOM real em botões de ataque/itens e despacho WebSocket com `battleId`.
4. Ausência de spam de `claim-all` (resgate automático desativado).
5. Guarda de combate na retomada do bot pós-pausa para evitar `bad_message undefined`.
