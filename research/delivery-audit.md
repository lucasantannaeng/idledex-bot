# Entrega verificada — IdleDex Desktop 2.4.1

Data: 2026-09-08 (America/Sao_Paulo). Autor: Codex.

| Requisito | Evidência inspecionada | Resultado |
| --- | --- | --- |
| Entender ideia e funcionamento | README; main, preload e painel; sessão real | Electron integra jogo oficial e motor pela mesma conexão |
| Engenharia reversa do site | HTML/bundle index-DwmEwqo-.js; SHA256 b2df02277738381598b3b31b045b3e85eb9a6bc7e53d8432efccade436864172; inspect-bundle.cjs | Contratos de movimento, equipe, batalha, cura, IVs, NPCs e recompensas comparados |
| Corrigir erros reproduzidos | 31 testes Node aprovados, incluindo casos que falhavam antes da correção | Configuração, reconexão, mapas, combate, recuperação, capturas, NPCs e recompensas corrigidos |
| Verificar execução real | live-validation-capture.json: captura1 sem erros; live-validation-rewards.json: cinco consultas e recuperação sem erros; live-validation.json: pacote final em movimento/combate sem erros | Integração real exercitada; última batalha terminou, bot restaurado pausado |
| Distribuição utilizável | dist-desktop/win-unpacked/IdleDex Desktop.exe 2.4.1; release-verification.json | Seis arquivos de execução idênticos ao fonte; manifesto de produção consistente |
| Inicialização e sessão | Reinício do executável 2.4.1 via CDP: conectado, configuração carregada e pausa preservada; segunda abertura manteve um processo principal | Sessão persistente e instância única verificadas |
| Painel | smoke-result.json aprovado em 2026-09-09T02:03:46.718Z; smoke-dashboard.png | Pacote candidato abre e restaura pausa/limite zero |
| Encerramento do diagnóstico | Reinício normal; processos IdleDex presentes; conexão à porta9222 recusada | Aplicativo aberto sem CDP |
| Instruções de uso | README.md, QUICKSTART.md e tests.md | Caminho Electron documentado sem cópia de token |

Limites da evidência: o teste real não força todas as espécies, NPCs, recompensas ou condições de rede. As condições de proteção e elegibilidade são verificadas por testes do preload contra os contratos do cliente. Não se promete estabilidade indefinida nem compatibilidade automática com futuras mudanças do site. O executável não tem assinatura comercial. Python/userscripts históricos foram preservados e não compõem esta distribuição.

Abrir: dist-desktop/win-unpacked/IdleDex Desktop.exe. Revisar configurações e ligar o bot; a sessão foi deixada pausada. Para controle manual, desativar também o Idle nativo. Não iniciar implementações antigas em paralelo.
