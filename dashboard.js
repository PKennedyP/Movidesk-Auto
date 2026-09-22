// Dashboard: lista à esquerda, editor à direita. Toda a persistência passa
// por window.Presets (presets.js) -- esta tela não fala com chrome.storage
// direto, para não divergir do popup.
(() => {
  "use strict";

  // Listas fixas do Movidesk, decisão antiga do usuário: não capturamos as
  // opções da página, ficam escritas aqui. Se o Movidesk mudar as opções, é
  // este objeto que se edita (antes de existir o dashboard elas viviam nos
  // <select> do popup.html). Os nomes são EXATOS porque o content.js casa a
  // opção por TEXTO normalizado, não por id.
  const OPCOES = {
    // Árvore de serviço do Movidesk, capturada em 2026-09-22. Os nomes são
    // EXATOS de propósito: o content.js casa a opção pelo texto normalizado,
    // não por id. Se o Movidesk mudar a árvore, é este objeto que se edita.
    // Omni e SKY - Conferência Detalhada ficaram de fora porque não foram
    // expandidos na captura -- ausência deliberada, não descuido.
    sistemas: {
      "Assist": ["Administrativo", "Assistência Técnica", "B2B", "CLI", "Estoque", "GED", "Integrações", "Jurídico", "RMA", "SAC", "WKF"],
      "Autua": ["Fiscal", "Secretaria", "Transportador"],
      "Beakt": ["Clínica", "Integrações", "Matriz"],
      "Cadastro de Declaração de Grande Gerador": ["Administrativo", "Gerador", "Transportador"],
      "CEU Coleta Especial Urbana": ["APP Coletor", "Concessionária", "Gestor", "Monitoramento"],
      "Coletas CPL": ["APP Concessionária", "APP Fiscal", "Concessionária", "Fiscalização", "Gestor"],
      "Coletas Grandes Geradores": ["APP Fiscalização", "APP Transportadores", "Fiscalização", "Gerador", "Integrações", "Secretaria", "Transportador"],
      "Coletas RCC": ["APP Fiscalização", "APP Munícipe", "APP Transportador", "Destino Final", "Fiscalização", "Grande Gerador", "Integrações", "Secretaria", "Transportador"],
      "DataSys": ["Administrativo", "Conciliador", "Contábil / Fiscal", "Document Center", "DRE TIM", "Financeiro", "Implantação / Treinamento", "Integrações", "Loja", "Metas e Comissões", "Módulo TIM", "Mural", "Power BI", "Sistema de Caixa", "Smart PDV", "TIM > Contestação de Comissão", "TIM > Previsão de Comissão"],
      "FLIC - Fiscalização Coleta Publica": ["App Fiscal", "Boletim Fiscalização", "Cadastros e Configurações", "Documentos e Indicadores", "Fluxo Anomalias"],
      "FLIP Fiscalização Limpeza Publica": ["ACIC", "APP Contratada", "APP Fiscalização", "BFS", "Cadastros e Configurações", "CNC", "Concessionária", "Defesa e Recurso", "Indicadores", "Integrações", "Ouvidoria", "SAC 156"],
      "Gaia": ["Fiscal", "Requerente", "Secretaria"],
      "GESP": ["Administrativo", "APP Recipientes", "Contratada"],
      "PORTAL TIM": ["Cadastro de Usuário", "Importação de grade", "Mapeamento"],
      "Reversa": ["Admin", "Credenciada", "Distribuidor", "Operador Logistico"],
      "Scripts CSJ": ["Clientes", "Colaboradores", "Recursos", "Scripts"],
      "Sistema de Cadastros": ["Aprovação", "Certificados", "Consultas", "Integrações", "Requisição Cadastro"],
      "Sistema TRS": ["Home"],
      "Unipark": ["Conveniado", "Credenciado", "Usuario"],
    },
  categoria: [
    "Análise de Negócio",
    "Apresentando Lentidão",
    "Ativação Dashboards",
    "Cadastros e Configurações",
    "Cancelamento Parcial",
    "Cancelamento Total",
    "Comercial",
    "Correção de Lançamentos",
    "Credenciamento",
    "Dúvida Operacional",
    "Emissão de CTR",
    "Evolutivas",
    "Falha na venda",
    "Financeiro",
    "Implantação de Sistema",
    "Importações / Exportações",
    "Mensagem de alerta",
    "Monitoramento",
    "NFe / NFCe",
    "Ordem de Serviço",
    "Relatórios e Indicadores",
    "Roteamento",
    "Sac / Ouvidoria",
    "Sistema fora do ar",
    "Solicitação de Melhoria",
    "TEF",
    "TEF Fora do ar",
    "Tela de Erro",
  ],
  urgencia: [
    "Cadastro / Confg.",
    "Cronograma",
    "Erro Sistema / Falha na Func.",
    "Esclarecimento Dúvidas",
    "Estornos",
    "Extra Produção",
    "Importações / Exportações",
    "Indicadores / Relatórios",
    "Interrupção Operacional",
    "Sist. Fora do ar",
  ],
  };

  // U+203A, não ">". "TIM > Contestação de Comissão" e "TIM > Previsão de
  // Comissão" são nomes reais de serviço com ">" no meio: um separador
  // ingênuo se confundiria com eles. Verificado que nenhum dos 124 nomes
  // (19 sistemas + 105 serviços) contém U+203A.
  const SEP = " › ";

  // PARES alimenta o <datalist>; MAPA_SERVICO resolve o que o usuário digitou.
  // A resolução é por CONSULTA, nunca por split: se um nome novo um dia
  // contiver o separador, a consulta falha e o campo acusa, em vez de
  // devolver um par errado em silêncio.
  const PARES = [];
  const MAPA_SERVICO = {};
  for (const sistema of Object.keys(OPCOES.sistemas)) {
    for (const servico of OPCOES.sistemas[sistema]) {
      const rotulo = sistema + SEP + servico;
      PARES.push(rotulo);
      MAPA_SERVICO[rotulo] = { sistema: sistema, servico: servico };
    }
  }

  const $ = (id) => document.getElementById(id);
  const elLista = $("lista");
  const elEditor = $("editor");
  const elContador = $("contador");
  const elBusca = $("busca");
  const elToast = $("toast");
  const elErro = $("erro");

  let presets = [];       // sempre a lista ordenada vinda do Presets.listar()
  let selecionadoId = null; // null = nada selecionado; "" = novo preset
  let pendente = null;    // { preset, timer } da exclusão aguardando desfazer

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const RE_ESPACOS = new RegExp("\\s+", "g");

  let timerErro = null;
  function mostrarErro(msg) {
    $("erro-texto").textContent = msg;
    elErro.classList.add("visivel");
    clearTimeout(timerErro); // senão o timer de um erro anterior esconde este
    timerErro = setTimeout(() => elErro.classList.remove("visivel"), 6000);
  }

  // ---------- lista ----------

  function visiveis() {
    return Presets.filtrar(presets, elBusca.value);
  }

  function desenharLista() {
    const itens = visiveis();
    elLista.innerHTML =
      itens
        .map((p) => {
          const chip = p.comando
            ? `<span class="chip">${esc(p.comando)}</span>`
            : `<span class="chip chip-vazio">sem comando</span>`;
          const resumo = p.texto
            ? esc(p.texto.replace(RE_ESPACOS, " "))
            : "<i>só campos do ticket</i>";
          return `<li class="item" role="option" data-id="${esc(p.id)}" aria-selected="${p.id === selecionadoId}">
            <span class="item-nome">${esc(p.nome)}<span class="item-texto">${resumo}</span></span>${chip}</li>`;
        })
        .join("") ||
      `<li class="vazio">Nenhum preset encontrado.<br />Ajuste a busca ou crie um novo.</li>`;
    elContador.textContent = `${itens.length} de ${presets.length} preset(s)`;
  }

  // ---------- editor ----------

  const VAZIO = { id: "", nome: "", comando: "", texto: "", assunto: "", servico: "", categoria: "", urgencia: "" };

  function presetSelecionado() {
    if (selecionadoId === null) return null;
    if (selecionadoId === "") return VAZIO;
    return presets.find((p) => p.id === selecionadoId) || null;
  }

  function desenharEditor() {
    const p = presetSelecionado();
    if (!p) {
      elEditor.innerHTML = `<div class="vazio">Nenhum preset selecionado.<br />
        Escolha um na lista para editar, ou clique em <b>+ Novo preset</b>.</div>`;
      return;
    }
    const novo = !p.id;
    const preenchidos = ["assunto", "servico", "categoria", "urgencia"].filter((k) => p[k]).length;
    const txt = (id, rot, val, ph) => `<div class="campo">
      <label class="rotulo" for="${id}">${rot}</label>
      <input type="text" id="${id}" value="${esc(val)}" placeholder="${ph}" /></div>`;

    // Serviço, categoria e urgência são <select> com as listas fixas do
    // Movidesk, não texto livre: digitar o nome errado faz o preenchimento
    // falhar silenciosamente, porque o content.js casa a opção por texto.
    // Um valor que não esteja na lista (preset antigo, ou opção que o Movidesk
    // removeu) entra como primeira opção marcada, para não ser apagado sem o
    // usuário perceber.
    const sel = (id, rot, val, opcoes, vazio) => {
      const fora = val && opcoes.indexOf(val) === -1;
      const itens = (fora ? [val] : []).concat(opcoes);
      return `<div class="campo">
      <label class="rotulo" for="${id}">${rot}</label>
      <select id="${id}">
        <option value=""${val ? "" : " selected"}>${esc(vazio)}</option>
        ${itens.map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("\n        ")}
      </select>${fora ? `<div class="dica">"${esc(val)}" não está na lista atual do Movidesk.</div>` : ""}</div>`;
    };

    // Sistema e serviço num controle só. O <datalist> é nativo: o Chrome
    // filtra por substring enquanto se digita, então a lista que a pessoa
    // encara é curta apesar dos 105 itens.
    const campoServico = (p) => {
      const valor = p.sistema && p.servico ? p.sistema + SEP + p.servico : p.servico;
      const opcoes = PARES.map((v) => `<option value="${esc(v)}"></option>`).join("");
      return `<div class="campo">
      <label class="rotulo" for="servico">Serviço</label>
      <input type="text" id="servico" list="lista-servicos" value="${esc(valor)}"
             placeholder="- não alterar -" autocomplete="off" />
      <datalist id="lista-servicos">${opcoes}</datalist>
      <div class="dica">${PARES.length} serviços em ${Object.keys(OPCOES.sistemas).length} sistemas. Clique na setinha para ver todos, ou digite para filtrar.</div>
      <div class="dica" id="aviso-servico"></div></div>`;
    };

    elEditor.innerHTML = `<div class="editor-limite">
      <div class="dois">
        ${txt("nome", "Nome do preset", p.nome, "ex.: Emissão de nota")}
        ${txt("comando", "Comando (opcional)", p.comando, "ex.: eemi")}
      </div>
      <div class="campo">
        <label class="rotulo" for="texto">Texto de expansão</label>
        <textarea id="texto" placeholder="O que será colado onde o cursor estiver.">${esc(p.texto)}</textarea>
        <div class="dica" style="margin-top:5px">Digite o comando em qualquer campo do Movidesk — ação pública, chat, e-mail — para colar este texto.</div>
      </div>

      <details class="bloco"${preenchidos ? " open" : ""}>
        <summary>Campos do ticket ${preenchidos ? `(${preenchidos} preenchido${preenchidos > 1 ? "s" : ""})` : "(nenhum)"}</summary>
        <div class="bloco-corpo">
          ${txt("assunto", "Assunto", p.assunto, "deixe vazio para não alterar")}
          ${campoServico(p)}
          <div class="dois">
            ${sel("categoria", "Categoria", p.categoria, OPCOES.categoria, "- o que o Movidesk sugerir -")}
            ${sel("urgencia", "Urgência", p.urgencia, OPCOES.urgencia, "- o que o Movidesk sugerir -")}
          </div>
          <div class="dica">Categoria e urgência em branco não são erro: ao escolher o serviço, o Movidesk já preenche as duas.</div>
        </div>
      </details>

      <div class="acoes">
        <button class="btn btn-primario" data-acao="salvar">${novo ? "Criar preset" : "Salvar alterações"}</button>
        ${novo ? "" : `<button class="btn" data-acao="duplicar">Duplicar</button>`}
        <div class="espaco"></div>
        ${novo ? "" : `<button class="btn btn-perigo" data-acao="excluir">Excluir</button>`}
      </div>
      <div class="dica" id="aviso-editor" style="margin-top:10px;color:#8a2b2b"></div>
    </div>`;
    atualizarAvisoServico();
  }

  // Campo de texto livre aceita qualquer coisa, então o usuário precisa saber
  // na hora se o que ele digitou resolve. O bloqueio ao salvar é a segunda
  // defesa, não a primeira.
  function atualizarAvisoServico() {
    const campo = $("servico");
    const aviso = $("aviso-servico");
    if (!campo || !aviso) return;
    const texto = campo.value.trim();
    if (!texto) { aviso.textContent = ""; aviso.style.color = ""; return; }
    const par = MAPA_SERVICO[texto];
    if (par) {
      aviso.textContent = `Sistema: ${par.sistema}  |  Serviço: ${par.servico}`;
      aviso.style.color = "var(--verde-escuro)";
    } else {
      aviso.textContent = "ainda não corresponde a nenhum serviço da lista";
      aviso.style.color = "#8a2b2b";
    }
  }

  function lerEditor() {
    const v = (id) => $(id).value;
    // Texto que não resolve vira servico sem sistema, que o Presets.validar
    // bloqueia com "Escolha o sistema do serviço." -- de propósito: é mais
    // honesto do que descartar em silêncio o que a pessoa digitou.
    const digitado = v("servico").trim();
    const par = MAPA_SERVICO[digitado] || { sistema: "", servico: digitado };
    return {
      id: selecionadoId === "" ? "" : selecionadoId,
      nome: v("nome"), comando: v("comando"), texto: v("texto"),
      assunto: v("assunto"),
      sistema: par.sistema, servico: par.servico,
      categoria: v("categoria"), urgencia: v("urgencia"),
    };
  }

  // ---------- ações ----------

  async function recarregar() {
    const doStorage = await Presets.listar();
    // O preset com exclusão pendente ainda está no storage -- só sai de lá
    // quando o timer de desfazer expira (ou no beforeunload). Se não filtrar
    // aqui, um Salvar/Duplicar clicado durante a janela de desfazer traz o
    // preset "excluído" de volta para a lista enquanto o toast ainda oferece
    // desfazer, e ele some de novo (fantasma) quando o timer disparar.
    presets = pendente ? doStorage.filter((p) => p.id !== pendente.preset.id) : doStorage;
    desenharLista();
    desenharEditor();
  }

  async function salvar() {
    const bruto = lerEditor();
    const validade = Presets.validar(bruto);
    if (!validade.ok) { $("aviso-editor").textContent = validade.motivo; return; }

    // O preset com exclusão pendente foi filtrado de `presets` por
    // recarregar(), mas ele volta se o usuário clicar em Desfazer. Se não
    // entrar na checagem, dá para criar um comando duplicado dentro da janela
    // de 6s e terminar com dois presets disputando o mesmo gatilho.
    const paraChecar = pendente ? presets.concat([pendente.preset]) : presets;
    const conflito = Presets.conflitoDeComando(bruto, paraChecar);
    if (conflito) {
      $("aviso-editor").textContent =
        `O comando "${bruto.comando.trim()}" já é usado pelo preset "${conflito.nome}". ` +
        `Troque um dos dois — dois presets com o mesmo comando deixam a expansão ambígua.`;
      return;
    }

    try {
      const salvo = await Presets.salvar(bruto);
      selecionadoId = salvo.id;
      await recarregar();
    } catch (e) {
      mostrarErro("Não deu para salvar: " + e.message);
    }
  }

  async function duplicar() {
    const p = presetSelecionado();
    if (!p || !p.id) return;
    // Duplica o que está na TELA, não o que está no storage: senão o texto
    // que o usuário acabou de digitar é descartado sem aviso pelo
    // recarregar() que vem depois.
    const atual = lerEditor();
    try {
      const copia = await Presets.salvar({ ...atual, id: "", nome: atual.nome + " (cópia)", comando: "" });
      selecionadoId = copia.id;
      await recarregar();
    } catch (e) {
      mostrarErro("Não deu para duplicar: " + e.message);
    }
  }

  // Excluir só some da lista em memória. O storage.remove roda quando a
  // janela de desfazer expira (ou no beforeunload, se a aba fechar antes),
  // então desfazer não precisa restaurar nada -- só cancelar o timer.
  function excluir() {
    const p = presetSelecionado();
    if (!p || !p.id) return;
    if (pendente) confirmarExclusao();

    presets = presets.filter((o) => o.id !== p.id);
    selecionadoId = null;
    pendente = { preset: p, timer: setTimeout(confirmarExclusao, 6000) };

    $("toast-texto").textContent = `"${p.nome}" excluído.`;
    elToast.classList.add("visivel");
    desenharLista();
    desenharEditor();
  }

  function confirmarExclusao() {
    if (!pendente) return;
    clearTimeout(pendente.timer);
    const id = pendente.preset.id;
    pendente = null;
    elToast.classList.remove("visivel");
    Presets.excluir(id).catch((e) => {
      mostrarErro("Não deu para excluir: " + e.message);
      // A exclusão falhou, então o preset continua no storage -- mas já
      // tinha sumido da lista em memória desde o clique em Excluir. Recarrega
      // para a tela voltar a refletir o que está realmente salvo.
      recarregar().catch((e2) => mostrarErro("Não deu para atualizar a lista: " + e2.message));
    });
  }

  async function desfazer() {
    if (!pendente) return;
    clearTimeout(pendente.timer);
    selecionadoId = pendente.preset.id;
    pendente = null;
    elToast.classList.remove("visivel");
    try {
      await recarregar();
    } catch (e) {
      mostrarErro("Não deu para restaurar a lista: " + e.message);
    }
  }

  // ---------- configurações ----------

  function ligarToggle(id, chave, padrao) {
    const el = $(id);
    chrome.storage.sync.get({ [chave]: padrao }, (v) => { el.checked = v[chave]; });
    el.addEventListener("change", () => {
      const valor = el.checked;
      chrome.storage.sync.set({ [chave]: valor }, () => {
        if (chrome.runtime.lastError) {
          el.checked = !valor;
          mostrarErro("Não deu para salvar a configuração: " + chrome.runtime.lastError.message);
        }
      });
    });
  }

  // ---------- eventos ----------

  elLista.addEventListener("click", (e) => {
    const li = e.target.closest(".item");
    if (!li) return;
    selecionadoId = li.dataset.id;
    desenharLista();
    desenharEditor();
  });

  elEditor.addEventListener("click", (e) => {
    const acao = e.target.dataset && e.target.dataset.acao;
    if (acao === "salvar") salvar();
    else if (acao === "duplicar") duplicar();
    else if (acao === "excluir") excluir();
  });

  elEditor.addEventListener("input", (e) => {
    if (e.target && e.target.id === "servico") atualizarAvisoServico();
  });

  elBusca.addEventListener("input", desenharLista);
  $("novo").addEventListener("click", () => {
    selecionadoId = "";
    desenharLista();
    desenharEditor();
  });
  $("btn-config").addEventListener("click", () => $("config").classList.toggle("aberta"));
  $("toast-desfazer").addEventListener("click", desfazer);
  window.addEventListener("beforeunload", confirmarExclusao);

  // ---------- início ----------

  (async () => {
    try {
      await Presets.migrar();
    } catch (e) {
      mostrarErro("A migração dos presets falhou: " + e.message + ". Seus presets antigos não foram apagados.");
    }
    ligarToggle("toggle-enabled", "enabled", true);
    ligarToggle("toggle-delimitador", "expansaoDelimitadorObrigatorio", false);
    const parametros = new URLSearchParams(location.search);
    if (parametros.get("novo") === "1") selecionadoId = "";
    else if (parametros.get("id")) selecionadoId = parametros.get("id");
    try {
      await recarregar();
    } catch (e) {
      mostrarErro("Não deu para carregar os presets: " + e.message);
    }
  })();
})();
