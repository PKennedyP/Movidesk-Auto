// Popup: buscar, consultar e preencher o ticket com o preset selecionado.
// Editar é no dashboard -- este popup é somente leitura de propósito: um
// popup não tem onde inserir texto (ele rouba o foco da página), mas
// preencher campos via chrome.tabs.sendMessage funciona sem foco.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const elLista = $("lista");
  const elPainel = $("painel");
  const elContador = $("contador");
  const elBusca = $("busca");
  const elErro = $("erro");

  const CAMPOS_TICKET = [
    ["assunto", "Assunto"],
    ["servico", "Serviço"],
    ["categoria", "Categoria"],
    ["urgencia", "Urgência"],
  ];

  let presets = [];
  let selecionadoId = null;

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const RE_ESPACOS = new RegExp("\\s+", "g");

  // Reaproveita uma aba de dashboard já aberta em vez de criar outra. Duas
  // abas do dashboard não se conversam (nenhuma das telas escuta
  // storage.onChanged), então a segunda a salvar sobrescreve a primeira com
  // dados velhos, sem aviso e sem histórico para recuperar.
  function abrirDashboard(novo, id) {
    const base = chrome.runtime.getURL("dashboard.html");
    const parametros = novo ? "?novo=1" : id ? "?id=" + encodeURIComponent(id) : "";
    // O "*" no fim é obrigatório: no match pattern do Chrome o path é casado
    // contra path MAIS query string, então `base` sozinho não acha uma aba
    // parada em dashboard.html?novo=1 ou ?id=… -- que são justamente as URLs
    // que esta função escreve ao reaproveitar a aba.
    chrome.tabs.query({ url: base + "*" }, (abas) => {
      const existente = (abas || [])[0];
      if (existente) {
        // Sem parâmetro, só focar: navegar a aba recarregaria a página e
        // jogaria fora um preset meio digitado no editor, sem aviso. Com
        // ?novo=1 ou ?id=, navegar é exatamente o que o usuário pediu.
        const alvo = parametros ? { url: base + parametros, active: true } : { active: true };
        chrome.tabs.update(existente.id, alvo);
        chrome.windows.update(existente.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: base + parametros });
      }
      window.close();
    });
  }

  let timerErro = null;
  function mostrarErro(msg, tipo) {
    $("erro-texto").textContent = msg;
    elErro.classList.add("visivel");
    elErro.style.background = tipo === "ok" ? "#14634a" : "#1c2b27";
    clearTimeout(timerErro); // senão o timer de um erro anterior esconde este
    timerErro = setTimeout(() => elErro.classList.remove("visivel"), 6000);
  }

  // ---------- lista ----------

  function desenharLista() {
    const itens = Presets.filtrar(presets, elBusca.value);
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
        .join("") || `<li class="vazio">Nenhum preset encontrado.</li>`;
    elContador.textContent = `${itens.length} de ${presets.length} preset(s)`;
  }

  // ---------- preview ----------

  function desenharPainel() {
    const p = presets.find((o) => o.id === selecionadoId);
    if (!p) {
      elPainel.innerHTML = `<div class="vazio">Selecione um preset à esquerda<br />
        para ver o texto e preencher o ticket.</div>`;
      return;
    }
    const comCampos = CAMPOS_TICKET.filter(([k]) => p[k]);
    elPainel.innerHTML = `
      <div class="painel-cabeca">
        <span class="painel-nome">${esc(p.nome)}</span>
        ${p.comando ? `<span class="chip">${esc(p.comando)}</span>` : `<span class="chip chip-vazio">sem comando</span>`}
      </div>
      <div class="texto-preview">${esc(p.texto) || "<i>sem texto de expansão</i>"}</div>
      ${comCampos.length
        ? `<dl class="campos-resumo">${comCampos.map(([k, r]) => `<dt>${r}</dt><dd>${esc(p[k])}</dd>`).join("")}</dl>`
        : `<div class="sem-campos">Só texto — este preset não preenche campos do ticket.</div>`}
      <div class="painel-acoes">
        <button class="btn btn-primario" data-acao="preencher"${comCampos.length ? "" : ' disabled title="Este preset não preenche campos do ticket."'}>Preencher ticket</button>
        <button class="btn" data-acao="editar">Editar no dashboard</button>
      </div>`;
  }

  // ---------- preencher ----------

  function preencher() {
    const p = presets.find((o) => o.id === selecionadoId);
    if (!p) return;
    const dados = { assunto: p.assunto, servico: p.servico, categoria: p.categoria, urgencia: p.urgencia };

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = (tabs || [])[0];
      if (!tab || !/https:\/\/csjgroup\.movidesk\.com\//.test(tab.url || "")) {
        mostrarErro("Abra um ticket do Movidesk antes de preencher.");
        return;
      }
      chrome.tabs.sendMessage(tab.id, { tipo: "preencher-fechamento", dados }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          mostrarErro("Não consegui falar com a página. Recarregue o ticket e tente de novo.");
          return;
        }
        if (!resp.ok) {
          mostrarErro("Erro ao preencher: " + (resp.erro || "desconhecido"));
          return;
        }
        const falhas = (resp.relatorio || []).filter((r) => !r.ok && !r.pulado);
        if (falhas.length) {
          mostrarErro(
            "Parcial. Falhou: " +
              falhas.map((f) => `${f.campo} (${f.motivo || "sem detalhe"})`).join("; ")
          );
        } else {
          mostrarErro("Ticket preenchido. Revise e salve.", "ok");
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
    desenharPainel();
  });

  elPainel.addEventListener("click", (e) => {
    const acao = e.target.dataset && e.target.dataset.acao;
    if (acao === "preencher") preencher();
    else if (acao === "editar") abrirDashboard(false, selecionadoId);
  });

  elBusca.addEventListener("input", desenharLista);
  $("novo").addEventListener("click", () => abrirDashboard(true));
  $("dashboard").addEventListener("click", () => abrirDashboard(false));

  const elToggle = $("toggle-enabled");
  function renderToggle(ligado) {
    elToggle.checked = ligado;
    $("estado-enabled").textContent = ligado ? "Extensão ativa" : "Extensão desativada";
  }
  chrome.storage.sync.get({ enabled: true }, ({ enabled }) => renderToggle(enabled));
  elToggle.addEventListener("change", () => {
    const ligado = elToggle.checked;
    chrome.storage.sync.set({ enabled: ligado }, () => {
      if (chrome.runtime.lastError) { renderToggle(!ligado); return; }
      renderToggle(ligado);
    });
  });

  // ---------- início ----------

  (async () => {
    // Dois try separados de propósito: se a migração falhar (limite de
    // escritas do Chrome, por exemplo), os presets que já existem ainda têm
    // que aparecer. Juntar os dois fazia a tela dizer "0 de 0" com os dados
    // intactos no storage.
    try {
      await Presets.migrar();
    } catch (e) {
      mostrarErro("A migração dos presets falhou: " + e.message + ". Seus presets antigos não foram apagados.");
    }
    try {
      presets = await Presets.listar();
    } catch (e) {
      mostrarErro("Não deu para carregar os presets: " + e.message);
    }
    desenharLista();
    desenharPainel();
    elBusca.focus();
  })();
})();
