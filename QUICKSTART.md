# Início Rápido — IdleDex Desktop v2.5.2

Versão estável atual: **2.5.2**. 

Se você já possuía uma versão anterior aberta, feche-a antes de iniciar a nova.

---

## ⚡ Passo a Passo para Usuários

1. **Abrir o Executável:**
   * **Versão Portátil:** Execute `dist-release/IdleDex_Desktop_Portable_2.5.2.exe`.
   * **Instalador:** Utilize `dist-release/IdleDex_Desktop_Setup_2.5.2.exe`.
   * **Pasta Descompactada:** Abra `dist-release/win-unpacked/IdleDex_Desktop.exe`.

2. **Login Seguro:**
   * Faça login na sua conta IdleDex pela janela embutida do jogo.
   * Não é necessário copiar tokens nem cookies; a sessão é mantida com segurança pelo Chromium.

3. **Configuração de Foco e Rotas:**
   * Em **Configuração > Spawns da Área**, selecione as espécies desejadas (salvamento automático).
   * Caso queira priorizar alvos específicos, utilize o campo **Fixar Espécie**.

4. **Gerenciamento de Box:**
   * Configure os critérios de IV, natureza e nota mínima desejados.
   * O botão **Executar Limpeza de Box Agora** aplica os critérios e processa os lotes elegíveis com proteção de Shinies e última cópia.

5. **Controle de Execução:**
   * Clique em **Ligar Bot** para iniciar as rotinas de patrulha e captura.
   * Utilize **Pausar** sempre que desejar assumir o controle manual.
   * Para trocar de conta, utilize o botão **Sair / Trocar Conta** para redefinir a sessão com segurança.

---

## 🛠️ Para Desenvolvedores

```bash
npm ci
npm test
npm start
```

Consulte o [README.md](README.md) e [tests.md](tests.md) para detalhes da arquitetura e suíte de validação.
