'use strict';

// One source for contextual help and the offline tutorial.
const HELP_TOPICS = [
    ['account', 'Sair e trocar conta Google', 'Encerra o login no aplicativo e permite entrar com outra conta.', [
        'Clique em Sair / Trocar conta na barra superior. O bot é pausado, as páginas do jogo e do login são fechadas e a sessão interna do Electron é limpa. A tela do jogo recarrega para você entrar novamente. No login Google, escolha outra conta ou informe suas credenciais.',
        'Isso afeta apenas o navegador interno do IdleDex Desktop. O login do Chrome e de outros aplicativos não é alterado. O progresso da conta continua no servidor do jogo. Cookies e preferências locais do jogo são removidos, mas as configurações do bot são preservadas.',
        'Após entrar na nova conta, confira os alvos da área, descarte e entregas antes de clicar em Iniciar Bot: as opções salvas são compartilhadas entre contas neste computador. Se a saída falhar, o Console mostra a falha e você pode tentar novamente.'
    ]],
    ['start', 'Primeiros passos e controle do bot', 'Inicie ou pause a automação sem fechar o jogo.', [
        'Entre no jogo, espere o personagem e o mapa carregarem e mantenha o bot pausado enquanto ajusta as opções. Abra Config, escolha um preset, revise captura, cura e automações e clique em Salvar Ajustes. Depois clique em Iniciar Bot.',
        'Pausar Bot interrompe novas ações do motor. Uma ação já aceita pelo servidor pode terminar. O jogo continua aberto para uso manual. A configuração e o estado ligado/pausado são gravados no computador; fechar pela cruz oculta a janela na bandeja. Use Sair Completamente no menu da bandeja para encerrar.',
        'Alternar Barra recolhe ou expande os painéis sem parar a automação. Bandeja oculta a janela; restaure pelo ícone próximo ao relógio. O botão Tutorial continua acessível na barra superior mesmo com o painel recolhido.'
    ]],
    ['radar', 'Radar, criaturas e alvos da área', 'Veja a posição, os encontros próximos e escolha espécies de interesse.', [
        'O radar representa uma região de 20 × 20 tiles em torno do personagem: azul é você, vermelho são criaturas e cinza são outras entidades. A lista próxima vem da telemetria do mapa; não é a lista completa de espécies que podem aparecer.',
        'Spawns da Área mostra as espécies informadas pelo jogo para a rota atual. Use Marcar Todos para caçar todas as espécies da área (modo all); use Desmarcar Todos para não focar em nenhuma espécie comum da área (modo none, focando apenas em Shinies prioritários ou não registrados se ativos); ou selecione individualmente as espécies desejadas (modo selected).',
        'As alterações de alvos no Radar são salvas de forma consistente e enviadas ao jogo após persistência. Variantes Shinies continuam com prioridade máxima absoluta de captura independente do modo de alvos da área. Use Não Selecionados para escolher entre lutar por XP e fugir dos encontros fora dos filtros.'
    ]],
    ['combat', 'Batalha e avaliação da captura', 'Acompanhe HP, ações e a qualidade da última captura.', [
        'O painel de batalha acompanha os participantes e seus pontos de vida. O motor aguarda a janela de ação e a permissão de arremesso do jogo; durante animações, é normal não enviar outro comando. Os percentuais nas configurações são relativos ao HP máximo.',
        'A avaliação ocorre depois da captura: soma dos seis IVs sobre 186, percentual, natureza e nota. IVs ausentes ficam pendentes até chegar a ficha completa. A nota não prevê os IVs de um selvagem antes de capturá-lo.',
        'A automação de captura, cura e fuga depende de itens, HP e permissões do servidor. Confira o Console de Operações quando um encontro não tiver a ação esperada.'
    ]],
    ['stats', 'Estatísticas e economia', 'Consulte resultados, saldo e rendimento da sessão.', [
        'Rank, XP, vitórias, derrotas, capturas e shinies usam os dados disponíveis do jogo e da sessão. Tempo ativo, capturas/h, XP/h, prata/h e reconexões ajudam a acompanhar o período atual; não são uma previsão de rendimento futuro.',
        'Prata e ouro são os saldos informados pelo servidor. Cura, consumíveis e outras ações podem reduzir o saldo, então prata/h pode ser negativa. Recarregar a sessão pode reiniciar contadores do motor.'
    ]],
    ['inventory', 'Mochila e consumíveis', 'Veja o estoque usado por captura, cura e boosts.', [
        'Suprimentos & Esferas mostra as quantidades disponíveis: Poké 1×, Great 2×, Super 3×, Ultra 4× e Master 100×. Esses valores são multiplicadores do catálogo utilizado pelo bot, e não porcentagens garantidas de captura.',
        'Cura & Revives separa poções e revives por tipo. Boosts & Consumíveis mostra os reforços de shiny, XP, captura e mapa. Estoque zero impede o uso do item; o painel é atualizado pelas mensagens do jogo.',
        'Ativar uma opção de consumo autoriza o motor a gastar os itens correspondentes nas condições descritas. Escolha os modos de poção e de esfera em Config antes de iniciar.'
    ]],
    ['cfg-move-mode', 'Seleção de golpes', 'Escolha como o bot decide o ataque.', [
        'Inteligente considera o golpe e a relação de tipos; Dano Máximo prioriza a estimativa de dano; Primeiro Golpe usa a primeira opção válida. Só são usados golpes disponíveis no estado atual da batalha.',
        'A lógica de captura tenta preservar alvos elegíveis quando precisa reduzir HP. Nenhum modo garante que um ataque não derrote o adversário: dano, resistências e estado da batalha influenciam o resultado.'
    ]],
    ['cfg-flee', 'Fugir com HP baixo', 'Define o limiar de HP próprio para tentar fugir.', [
        'Informe um percentual entre 5 e 60. Por exemplo, 30 corresponde a 30 HP de um máximo de 100. Ao chegar ao limiar, o motor pode tentar encerrar o encontro por fuga.',
        'Fuga só funciona quando permitida pelo jogo. Revive, filtros de alvos e recuperação também entram na decisão; não trate esse campo como garantia contra derrotas.'
    ]],
    ['cfg-catch', 'HP inimigo para captura', 'Define o limiar de arremesso direto, com prioridade à preservação do alvo.', [
        'Ao atingir esse percentual de HP, o alvo recebe uma tentativa de captura quando há esfera e o jogo permite o arremesso.',
        'Shinies, alvos com grande diferença de nível e espécies inéditas de nível baixo recebem arremesso direto. Nos demais casos, o enfraquecimento automático aguarda validação de uma fórmula de dano ou golpe comprovadamente não letal.',
        'Enquanto essa validação estiver pendente, o motor também pode arremessar acima do limiar para preservar o alvo. O campo não funciona como limite estrito de HP e não autoriza ataques com risco de nocaute.'
    ]],
    ['cfg-ball-priority', 'Prioridade de esferas', 'Equilibra economia e força das esferas disponíveis.', [
        'Econômica começa pelas Pokébolas mais simples. Balanceada escolhe conforme o HP e o estoque. Forçar Ultra / Super prioriza esferas mais fortes disponíveis.',
        'O motor não compra esferas por este seletor. Confira Mochila antes de começar e acompanhe o consumo. O multiplicador da esfera não elimina as demais condições de captura.'
    ]],
    ['cfg-unselected-action', 'Encontros fora dos filtros', 'Escolha lutar por XP ou fugir dos alvos não elegíveis.', [
        'Lutar por XP usa os encontros fora da seleção para combater. Fugir Imediato tenta sair deles para procurar o próximo alvo. A opção também aparece no Radar e representa a mesma configuração.',
        'Com a lista de espécies vazia, todas são candidatas por espécie. Os filtros de shiny e de não registrados podem excluir encontros mesmo assim. Salve alterações feitas em Config; a alteração no Radar é imediata.'
    ]],
    ['cfg-only-shiny', 'Capturar apenas shinies', 'Restringe tentativas de captura a criaturas shiny.', [
        'Ative para caçar variantes shiny. Um encontro comum segue a ação configurada para não selecionados. O filtro não aumenta a chance de surgirem shinies.',
        'Quando combinado com espécies selecionadas e Apenas Não Registrados, o encontro precisa satisfazer os filtros aplicáveis. Os presets removem este filtro; reative-o depois de escolher o preset se esse for seu objetivo.'
    ]],
    ['cfg-only-uncaught', 'Capturar apenas não registrados', 'Prioriza espécies ainda não marcadas como capturadas.', [
        'Ative para ampliar a coleção de espécies. O motor usa os dados de captura disponíveis na prévia da rota e na coleção; aguarde a atualização dos dados ao trocar de mapa.',
        'Desative para buscar duplicatas, IVs ou naturezas de uma espécie já conhecida. Fixar Espécie impede a troca de rota, mas não desliga este filtro automaticamente.'
    ]],
    ['cfg-potion', 'HP próprio para poção', 'Define quando tentar curar o combatente.', [
        'Informe de 5 a 60%. Com 35, o motor considera a poção quando a vida chega a 35% do máximo. A cura depende de estoque e da janela em que itens são permitidos.',
        'Revise junto do limiar de fuga: deixar a cura para uma porcentagem muito baixa pode fazer a fuga ou a derrota acontecer antes. Monstros desmaiados precisam de revive ou outra recuperação.'
    ]],
    ['cfg-potion-mode', 'Modo de poção', 'Escolhe uma poção pelo déficit ou por tipo fixo.', [
        'Inteligente calcula quanto HP falta e procura uma poção adequada disponível. Os tipos fixos selecionam Potion (+20), Super (+60), Hyper (+120) ou Max (recuperação total).',
        'Por exemplo, uma Potion pode bastar para um déficit de 15 HP. Escolher um tipo fixo exige ter esse item; não é uma ordem de compra. Quantidades e resultado efetivo vêm do jogo.'
    ]],
    ['cfg-revive-battle', 'Revive em batalha', 'Usa revive quando o líder desmaia e o jogo permite.', [
        'Ative para tentar recuperar o líder com Revive ou Max Revive durante um duelo. A permissão de revive do servidor é obrigatória; o motor não envia o item fora dessa janela.',
        'Revive recupera parte do HP e Max Revive recupera totalmente segundo o catálogo do motor. O item é consumido. Sem estoque ou permissão, a opção não evita o fim da batalha.'
    ]],
    ['cfg-revive-overworld', 'Revive fora do combate', 'Recupera integrantes desmaiados da equipe entre encontros.', [
        'Ative para usar itens de revive na equipe fora de batalha. Isso permite retomar a patrulha quando há integrantes desmaiados, respeitando o estoque.',
        'Esta opção é independente de Revive em Batalha. O motor aguarda recuperação antes de patrulhar com a equipe sem condições de lutar.'
    ]],
    ['cfg-auto-heal-center', 'Cura no Centro Pokémon', 'Solicita cura conforme equipe, rank e saldo disponível.', [
        'Permite recuperação pelo serviço de cura do jogo quando o motor avalia a necessidade. A regra verificada é gratuita até rank 20; acima disso, o custo é 2 pratas por nível de cada integrante ferido atendido.',
        'Quando o saldo não cobre todos, o motor tenta uma cura parcial compatível com o saldo e evita repetir imediatamente uma solicitação recusada. A opção pode gastar prata; acompanhe Economia. Não implica uma compra de poções.'
    ]],
    ['cfg-auto-roam', 'Patrulha automática', 'Move o personagem em busca de encontros.', [
        'Ative para deixar o motor conduzir o personagem pelo mapa. A patrulha para durante batalhas, carregamento de mapa e viagens de entrega. No laboratório ela fica bloqueada.',
        'Com a opção desativada, você pode mover o personagem manualmente; combate e outras automações continuam sujeitos ao estado geral do bot. Pausar Bot interrompe o motor como um todo.'
    ]],
    ['cfg-roam-delay', 'Intervalo entre passos', 'Controla o ritmo de solicitação de movimento.', [
        'Use de 220 a 1000 milissegundos, em passos de 10 ou 50. O padrão de 300 ms corresponde a cerca de três decisões de movimento por segundo quando a patrulha está livre.',
        'Um valor menor que 220 ms é bloqueado porque o motor oficial do cliente impõe um limite rígido de 200 ms por passo (Cn = 200 ms). Se houver instabilidade ou descompasso, aumente o intervalo e observe a posição no Radar.'
    ]],
    ['cfg-auto-route-switch', 'Troca automática de rota', 'Avança de rota quando os alvos estão registrados.', [
        'Ative para avançar sequencialmente entre rotas ao concluir as espécies da seleção, ou as espécies da rota quando não há seleção. A decisão depende da prévia atualizada do mapa.',
        'A espécie fixada bloqueia a troca enquanto habitar a rota atual. Viagens para entregas têm um fluxo separado e podem interromper temporariamente a caça.'
    ]],
    ['cfg-pinned-species', 'Fixar espécie para farming', 'Mantém a rota quando ela contém a espécie indicada.', [
        'Digite o identificador da espécie, por exemplo pikachu. Se ela estiver entre os spawns da rota, a troca automática de rota é bloqueada para permitir tentativas repetidas.',
        'Isso não seleciona a espécie na lista de captura. Marque-a no Radar se quiser restringir os alvos e desative Apenas Não Registrados para capturar duplicatas. Apague o campo para liberar a troca de rota.'
    ]],
    ['cfg-strategy', 'Presets de configuração', 'Preenche opções de captura para Equilibrado, Coleção ou Monetização.', [
        'Equilibrado: captura até 50% de HP, esferas balanceadas, combate dos não selecionados e sem filtros exclusivos de shiny/inéditos. Coleção: captura até 50%, apenas inéditos, fuga dos demais e esferas econômicas. Monetização: captura até 30%, combate dos demais e esferas econômicas.',
        'Escolha o preset, confira os campos e clique em Salvar Ajustes. Você pode personalizar os valores antes de salvar. Mudar de preset sempre substitui os filtros de captura que ele controla, evitando herdar Apenas Shinies ou Apenas Não Registrados do modo anterior.',
        'Os presets preservam alvos da área, opções de cura, descarte, entregas, boosts e o estado pausado. Monetização é o nome da estratégia de combate/captura; não garante lucro nem executa uma venda por si só.'
    ]],
    ['cfg-discard-iv-pct', 'Descarte automático por IV', 'Libera capturas com IV percentual abaixo do limiar.', [
        'O percentual usa a soma dos seis IVs dividida por 186. Com 50%, capturas elegíveis abaixo desse valor podem ser liberadas após o recebimento da ficha completa. Use 0% para impedir descarte por esse limiar; esse é o padrão de um perfil novo.',
        'A liberação remove a criatura da coleção. O motor protege integrantes da equipe, líderes, shinies, criaturas travadas e formas/eventos especiais; IVs incompletos não autorizam liberação. Revise este campo antes de ativar o bot, sobretudo durante farming.'
    ]],
    ['cfg-pause-no-balls', 'Pausa por falta de esferas', 'Interrompe a automação ao esgotar as esferas.', [
        'Esta pausa é acionada pela patrulha quando as esferas acabam e Não Selecionados está em Fugir Imediato. Confira o estoque em Mochila, reabasteça no jogo e retome manualmente quando estiver pronto.',
        'Com Lutar por XP, a caça pode continuar sem esferas. Desativar esta opção também permite continuar, mas não torna possível capturar sem esfera. A prioridade de esferas continua controlando quais itens são escolhidos.'
    ]],
    ['cfg-auto-idle', 'Automático nativo do jogo', 'Controla a integração com o idle fornecido pelo jogo.', [
        'Enquanto o motor do bot está ativo, ele interrompe o automático nativo para impedir duas automações enviando ações simultaneamente. Portanto, marcar esta opção não faz os dois motores trabalharem juntos.',
        'Pausar pelo painel cancela as ações do bot; use os controles oficiais do jogo para operar o automático nativo manualmente. Os filtros detalhados do bot não são uma cópia completa das regras do modo nativo.'
    ]],
    ['cfg-auto-dailies', 'Resgatar recompensas', 'Resgata diárias, bônus e marcos prontos.', [
        'Ative para consultar e resgatar recompensas elegíveis de diárias, calendário, Pokédex, passe e notícias conforme os estados recebidos do jogo.',
        'O motor verifica progresso e disponibilidade antes de pedir o resgate, e evita repetir pedidos idênticos. A opção não conclui automaticamente tarefas ainda incompletas e não compra passes.'
    ]],
    ['cfg-auto-lock', 'Proteção automática de valiosos', 'Trava shinies e capturas avaliadas como valiosas.', [
        'Ative para solicitar a trava de criaturas valiosas após a avaliação, como shinies e grau S. Aguarde a ficha completa para os critérios que dependem de IV e natureza.',
        'A trava ajuda a proteger a coleção em operações futuras. As verificações de proteção do motor também excluem equipe e criaturas especiais de descarte e entregas automáticas.'
    ]],
    ['cfg-auto-npc-quests', 'Entregas a NPCs', 'Entrega excedentes elegíveis segundo as regras de cada NPC.', [
        'Ative para permitir entregas ao Professor e missões de NPCs quando os dados e condições correspondentes estiverem disponíveis. Entregas consomem criaturas da Box; o motor preserva equipe, valiosos e uma cópia conforme os critérios de elegibilidade.',
        'O Professor exige lote e cargas suficientes. Para o Colecionador, o motor verifica uma prévia dos IDs antes da confirmação. Sem condições válidas, não há entrega. Desative se quiser manter todas as duplicatas.'
    ]],
    ['cfg-auto-travel-deliveries', 'Viagem para entregas', 'Vai ao laboratório e retorna à rota de origem.', [
        'Ative para visitar o laboratório ao reunir excedentes elegíveis. O motor lembra a rota de origem, suspende a caça, solicita o estado do Professor e aguarda confirmação das entregas antes de retornar.',
        'Sem lote ou cargas, ele retorna sem inventar uma entrega. Reconexões e timeouts têm recuperação com tentativas limitadas; o motor não caça dentro do laboratório. Excedentes inalterados não disparam a mesma viagem repetidamente.'
    ]],
    ['cfg-auto-travel-surplus', 'Limiar de excedentes para viagem', 'Define quantas duplicatas elegíveis justificam visitar o laboratório.', [
        'Escolha de 1 a 20. O padrão é 5 excedentes. A contagem exclui criaturas protegidas e considera o estoque disponível para entrega; não equivale ao total bruto de criaturas da coleção.',
        'Esse limiar inicia a avaliação de viagem, mas não altera o tamanho do lote exigido pelo Professor. Um valor baixo pode causar visitas sem lote suficiente; acompanhe o Console.'
    ]],
    ['cfg-auto-boosts', 'Ativação automática de boosts', 'Permite consumir reforços disponíveis.', [
        'Ative para autorizar o motor a usar boosts como shiny e XP conforme estoque e estado do jogo. O efeito e a duração são definidos pelo jogo.',
        'Como são consumíveis, deixe desativado se pretende reservar os itens para outro momento. A presença de um contador na Mochila não significa que aquele boost já esteja ativo.'
    ]],
    ['cfg-close-to-tray', 'Minimizar para bandeja ao fechar', 'Oculta a janela na bandeja do sistema ao clicar no botão de fechar [X].', [
        'Quando ativado, fechar a janela pelo botão [X] não encerra a aplicação nem a automação, apenas oculta a janela na bandeja do sistema (próximo ao relógio do Windows).',
        'Para reabrir o aplicativo, clique no ícone da Pokébola na bandeja ou selecione Restaurar no menu de contexto.',
        'Para encerrar completamente o aplicativo quando esta opção estiver ativa, use a opção "Sair Completamente" no menu de contexto do ícone da bandeja.'
    ]],
    ['save', 'Salvar e personalizar ajustes', 'Grava as opções e as envia ao motor.', [
        'Os campos de Config são uma edição em andamento. Clique em Salvar Ajustes para persistir no computador e aplicar ao jogo. Ao recarregar, o painel usa a última configuração salva.',
        'Se houver falha de gravação, o Console informa o erro e o novo conjunto não é aplicado. Mudanças no Radar e no botão Iniciar/Pausar têm salvamento próprio e imediato.'
    ]],
    ['logs', 'Console de Operações', 'Explica decisões e falhas recentes do motor.', [
        'Leia as mensagens com horário para identificar pausas, capturas, cura, viagens e erros. O painel guarda até 120 entradas visíveis; não é um histórico permanente de toda a conta.',
        'Limpar remove apenas as mensagens visíveis, sem parar o bot nem apagar sua configuração. Para investigar um problema, registre a mensagem, a rota e o que estava ativado no momento.'
    ]]
];

function initializeHelp() {
    const dialog = document.getElementById('help-dialog');
    const title = document.getElementById('help-title');
    const body = document.getElementById('help-body');
    const topics = new Map(HELP_TOPICS.map(topic => [topic[0], topic]));
    let returnFocus;
    function show(topicId, full) {
        const topic = topics.get(topicId) || HELP_TOPICS[0];
        if (!dialog.open) returnFocus = document.activeElement;
        title.textContent = full ? 'Tutorial do IdleDex Bot' : topic[1];
        body.replaceChildren();
        if (full) {
            const nav = document.createElement('nav');
            nav.className = 'help-index';
            nav.setAttribute('aria-label', 'Seções do tutorial');
            for (const item of HELP_TOPICS) {
                const link = document.createElement('a');
                link.href = '#tutorial-' + item[0];
                link.textContent = item[1];
                link.addEventListener('click', event => {
                    event.preventDefault();
                    document.getElementById('tutorial-' + item[0]).scrollIntoView();
                });
                nav.append(link);
            }
            body.append(nav);
            for (const item of HELP_TOPICS) {
                const section = document.createElement('section');
                section.id = 'tutorial-' + item[0];
                const heading = document.createElement('h3');
                heading.textContent = item[1];
                section.append(heading);
                for (const text of item[3]) {
                    const paragraph = document.createElement('p');
                    paragraph.textContent = text;
                    section.append(paragraph);
                }
                body.append(section);
            }
        } else {
            const summary = document.createElement('p');
            summary.textContent = topic[2];
            const link = document.createElement('button');
            link.className = 'tb-btn primary';
            link.textContent = 'Ver tutorial: ' + topic[1];
            link.addEventListener('click', () => show(topic[0], true));
            body.append(summary, link);
        }
        if (!dialog.open) dialog.showModal();
        body.scrollTop = 0;
        if (full && topicId) document.getElementById('tutorial-' + topic[0]).scrollIntoView();
    }
    function addHelp(element, topic) {
        if (!element || !topics.has(topic)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'help-trigger';
        button.dataset.helpTopic = topic;
        button.textContent = '?';
        button.setAttribute('aria-label', 'Ajuda: ' + topics.get(topic)[1]);
        button.addEventListener('click', () => show(topic, false));
        if (element.classList.contains('card-title')) element.style.display = 'inline';
        element.insertAdjacentElement('afterend', button);
    }
    for (const row of document.querySelectorAll('.form-item')) {
        const input = row.querySelector('[id^="cfg-"]');
        const label = row.querySelector('label');
        if (input && label) {
            label.htmlFor = input.id;
            addHelp(label, input.id);
        }
    }
    for (const element of document.querySelectorAll('[data-help]')) addHelp(element, element.dataset.help);
    for (const panel of ['combat', 'stats', 'inventory']) {
        for (const heading of document.querySelectorAll('#panel-' + panel + ' .card-title')) addHelp(heading, panel);
    }
    for (const button of document.querySelectorAll('#panel-radar button[onclick^="selectAllAreaSpecies"], #btn-select-all-species, #btn-deselect-all-species')) addHelp(button, 'radar');
    addHelp(document.querySelector('#btn-clear-logs, button[onclick="clearLogs()"]'), 'logs');
    document.getElementById('btn-tutorial').addEventListener('click', () => show(null, true));
    document.getElementById('help-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => returnFocus?.focus());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}
window.addEventListener('DOMContentLoaded', initializeHelp);
