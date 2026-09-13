---
author: codex
date: 2026-09-09
status: partial
---

# IdleDex — avaliação de segurança em andamento

Alvo autorizado pelo usuário: https://idledex.com/play. Coleta em 09/09/2026, aproximadamente 13:22–13:27 UTC. Testes manuais de baixo volume, sem credenciais e sem alterações de dados. Nenhuma vulnerabilidade explorável confirmada nesta etapa. Isso não comprova segurança do sistema.

## Observações confirmadas

1. **CSP ausente na resposta de /play (informativo).** Não há Content-Security-Policy nos cabeçalhos coletados nem política equivalente no HTML. Isso reduz defesa em profundidade caso exista uma injeção; não demonstra XSS. Recomenda-se elaborar uma política compatível com recursos reais, inicialmente em Report-Only e depois aplicar nonces/hashes e diretivas restritivas.
2. **HSTS ausente nas respostas HTTPS examinadas (informativo, impacto pendente).** HTTP /play redireciona com 301 para HTTPS. Sem HSTS efetivo ou preload, o primeiro acesso HTTP pode ficar sujeito a interferência de rede. Não foi verificado preload nem realizado ataque de rede; não atribuir exploração confirmada. Recomenda-se avaliar HSTS com max-age adequado; includeSubDomains/preload somente após validar todos os subdomínios.
3. **Ticket WebSocket em query string (revisão de arquitetura).** O bundle constrói /ws?token=...&v=5. Não foi observado vazamento. Verificar no servidor expiração curta, uso único e remoção dos tokens em logs e telemetria. A presença na URL, isoladamente, não comprova vulnerabilidade.

## Controles observados

| Verificação | Resultado | Limite |
|---|---|---|
| /api/ws-token sem sessão | 401 Unauthorized | Não valida comportamento autenticado |
| /api/ws-token com Origin https://audit.invalid | 401, sem Access-Control-Allow-Origin | Allow-Credentials isolado não constitui CORS explorável |
| /api/auth/get-session sem sessão | 200, corpo null, Cache-Control: no-store | Resposta esperada sem usuário |
| /api/push/preferences sem sessão | 401 Unauthorized | Não testa isolamento entre contas |
| /ws com token fictício | 101 seguido de erro unauthorized e fechamento | Upgrade HTTP não equivale a autenticação aceita |
| /assets/index-DwmEwqo-.js.map | 404 | Não implica ausência de todos os mapas |
| /play | X-Frame-Options: DENY; nosniff; strict-origin-when-cross-origin | Sem teste de navegador nesta etapa |

O frame final coletado contém código de fechamento 4401 (bytes 0x11 0x31) e motivo unauthorized. O bundle inclui código interno de React com dangerouslySetInnerHTML; não foi identificado fluxo de entrada controlável até esse destino. Não reportar a simples ocorrência textual como XSS.

## Evidências e reprodução

Arquivos de cabeçalhos/corpos estão em evidence/. Nenhuma sessão pessoal foi usada. Bundle SHA256: B2DF02277738381598B3B31B045B3E85EB9A6BC7E53D8432EFCCADE436864172.

Exemplos de reprodução sem credenciais:

```powershell
curl.exe -sS -D - https://idledex.com/play
curl.exe -sS -D - http://idledex.com/play
curl.exe -sS -D - https://idledex.com/api/ws-token -H 'Origin: https://audit.invalid'
curl.exe -sS -D - https://idledex.com/api/auth/get-session
curl.exe -sS -D - https://idledex.com/api/push/preferences
```

## Trabalho pendente

Atualização em 09/09/2026, 13:46 UTC: a conta de teste do bot foi acessada com autorização explícita do usuário. GET /api/auth/get-session confirmou autenticação. O cookie __Secure-better-auth.session_token tem Secure=true, HttpOnly=true, SameSite=Lax e path=/. Evidência sanitizada em evidence/test-session-summary.json. Não foram exportados tokens, cookies, email ou nome. A segunda conta segue pendente.

- Obter duas contas de teste e identificar ambiente de homologação para validar autorização entre jogadores, notificações e recursos próprios.
- Validar tickets: expiração, reutilização, revogação e política de origem com sessão de teste.
- Avaliar entradas de chat/perfil e regras de inventário/mercado em ambiente de teste.
- Verificar cookies autenticados, CSRF e comportamento de cache para respostas sensíveis.
- Confirmar o impacto das observações antes de atribuir severidade de vulnerabilidade.

Strix e Docker não foram encontrados no PATH. Nenhum scan Strix foi iniciado. A investigação atual é manual. A declaração do usuário sobre chatgpt.com/cyber foi registrada como contexto, sem verificação independente.

## Complemento — notificações e service worker

Coleta adicional em 09/09/2026, 13:31 UTC:

- GET /api/push/config retornou 200 com {"enabled":false,"publicKey":null}; a resposta não contém segredo. Isso descreve apenas a configuração observada nesse momento.
- GET /api/push/notifications/codex-audit-nonexistent, sem sessão, retornou 401 Unauthorized. O identificador é fictício; nenhum dado de outro jogador foi solicitado.
- O código de /sw.js restringe a navegação de notificationclick com `t.origin===self.location.origin`. A análise estática não indica redirecionamento direto para origem externa nesse fluxo.
- As rotas explícitas de cache em tempo de execução são navegações /play e /play/..., além de recursos de mesma origem em /sprites/, /fx/, /ui/ e /maps/. Não foi identificada rota explícita de cache para /api/ nesse código. Ainda falta verificar o comportamento real com sessão e troca de contas no navegador.
- SHA256 do service worker: 17F376EFB2ABC21CCA4D735F6EFA0B072FAA3AD69A7C4536B67FBC8C84A4C1DC.

Evidências adicionais: evidence/service-worker.body, evidence/push-config.*, evidence/notification-invalid.*. Nenhuma nova vulnerabilidade confirmada. A validação de isolamento, tickets e regras de negócio continua dependendo de contas de teste ou código do servidor disponibilizado pelo proprietário.
