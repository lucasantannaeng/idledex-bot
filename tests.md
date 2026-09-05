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
