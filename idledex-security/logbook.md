---
author: codex
date: 2026-09-09
---
Avaliação autorizada de https://idledex.com/play iniciada. Evidências e relatório parcial em D:/Projetos/idledex-security. Controles de acesso sem sessão responderam com rejeição; CSP/HSTS ausentes nas respostas examinadas, sem exploração demonstrada. Próxima etapa: contas de teste para validação autenticada. Nenhum scan autônomo ativo.

Complemento: service worker revisado; checagem de mesma origem em links de notificação, sem rota explícita de cache de API. Push público desabilitado e consulta a notificação fictícia sem sessão retorna 401. Nenhuma nova vulnerabilidade confirmada. Relatório atualizado; acesso de teste continua pendente.

13:46 UTC: acesso à conta de teste do bot autorizado pelo usuário e confirmado via get-session. Cookie Secure, HttpOnly, SameSite=Lax; resumo sem credenciais em evidence/test-session-summary.json. Acesso a uma conta resolvido; segunda conta pendente.
