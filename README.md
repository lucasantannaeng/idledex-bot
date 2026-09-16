# IdleDex Desktop v2.5.2

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-informational.svg)](#)
[![Electron](https://img.shields.io/badge/Electron-33.4.11-47848F.svg)](https://www.electronjs.org/)
[![Tests](https://img.shields.io/badge/Tests-109%20passed-success.svg)](#)
[![Security](https://img.shields.io/badge/Security-Sandboxed%20%7C%20Zero--Trust-brightgreen.svg)](#)

> **Aplicativo Desktop profissional em Electron com navegador Chromium embutido e motor de automação local para o jogo IdleDex.**

---

## ⚡ Visão Geral

O **IdleDex Desktop** integra o cliente do jogo diretamente em uma instância isolada do Electron, oferecendo controles locais avançados de combate, captura seletiva, patrulha, recuperação automática, entregas e gerenciamento inteligente de Box. 

Toda a automação roda localmente no seu computador, comunicando-se com a sessão do jogo sem necessidade de plugins de terceiros ou cópia manual de cookies.

---

## 🎯 Funcionalidades Principais

### 1. Foco e Seletividade de Captura
* **Spawns da Área:** Selecione quais espécies da rota atual devem ser capturadas. As alterações são sincronizadas e salvas imediatamente.
* **Fixar Espécie:** Permite travar até duas espécies prioritárias da área com salvamento de foco e bloqueio de opções conflitantes.
* **Modo Não Selecionados:** Controle se o bot deve lutar por XP ou fugir ao encontrar espécies não marcadas.
* **Prioridade de Shinies:** Preservação estrita de criaturas raras e Shinies em qualquer rota.

### 2. Limpeza Inteligente de Box (Clean & Keep)
* **Critérios Estritos (AND/OR):** Filtre descarte por percentual mínimo de IV, IVs individuais (HP, ATK, DEF, SP.ATK, SP.DEF, SPEED), natureza e nota de qualidade.
* **Proteção da Última Cópia:** Opção para jamais descartar o único exemplar de uma espécie na Box.
* **Preservação Automática:** Equipe ativa, Shinies, criaturas bloqueadas com cadeado e recursos reservados são 100% blindados contra descarte.
* **Execução Segura:** Sem critérios ativos, nenhuma criatura é liberada. O console exibe o detalhamento de cada ação recebida do servidor.

### 3. Autonomia e Ciclo de Vida
* **Auto-Idle & Pausa Inteligente:** Pausa automática em eventos de suspensão do sistema, troca de conta ou falhas no renderer.
* **Troca de Conta Simplificada:** Botão dedicado para limpar a sessão e permitir login em outra conta com configurações preservadas.

---

## 🚀 Como Executar e Desenvolver

### Pré-requisitos
* **Node.js:** `>= 18.0.0`
* **npm:** `>= 9.0.0`
* **Sistema Operacional:** Windows 10/11 x64

### Instalação e Execução Local

```bash
# 1. Clonar o repositório
git clone https://github.com/lucasantannaeng/idledex-bot.git
cd idledex-bot

# 2. Instalar dependências
npm ci

# 3. Executar em modo de desenvolvimento
npm start

# 4. Executar com depuração CDP habilitada (porta 9222)
npm start -- --inspect-bot
```

### Compilação de Pacotes para Distribuição

```bash
# Gerar executável portátil standalone (.exe)
npm run dist:portable

# Gerar instalador NSIS completo (.exe)
npm run dist:installer

# Gerar pacote descompactado para testes rápidos
npm run pack
```

Os artefatos compilados serão gerados no diretório `dist-release/`.

---

## 🧪 Testes e Validação de Integridade

O projeto possui suítes automatizadas cobrindo ciclo de vida do Electron, contrato da Box, regressão de UI e higienização de DOM:

```bash
# Executar a suíte completa de testes unitários e de integração
npm test

# Executar teste de fumaça (smoke test) isolado no Electron
npm run smoke

# Executar validação de integridade dos instaladores e allowlist
node research/verify-installers.cjs
```

---

## 🛡️ Segurança e Privacidade (DevSecOps)

* **Isolamento de Contexto (`contextIsolation: true`):** O renderer não tem acesso direto a APIs sensíveis do Node.js.
* **Zero-Trust de Credenciais:** As credenciais de acesso ficam restritas à sessão segura do Chromium embutido. Nenhuma senha, token ou chave privada é salva em disco ou enviada para servidores externos.
* **Git Protegido:** Regras universais de `.gitignore` impedem que builds `.exe`, `.asar`, perfis temporários e logs sejam enviados para o repositório.

---

## 📄 Licença e Autoria

Este projeto é distribuído sob a licença **MIT** — consulte o arquivo [LICENSE](LICENSE) para mais detalhes.

**Autor:** Luca Rodrigues Gomes de Sant'Anna ([lucasantannaeng@gmail.com](mailto:lucasantannaeng@gmail.com))

---

*Aviso: IdleDex é uma marca registrada de seus respectivos criadores. Este projeto é uma ferramenta independente desenvolvida para fins educacionais e de automação pessoal.*
