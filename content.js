(() => {
  "use strict";

  // Guarda de instância única: com "all_frames" o script rodaria em cada frame;
  // e mesmo sem ele, evita que uma reinjeção empilhe hooks/observers. Marca a
  // janela atual como servida.
  if (window.__movideskAutoNaoAtivo) return;
  window.__movideskAutoNaoAtivo = true;

  // ============================ CONFIGURAÇÃO ============================
  // Títulos das perguntas-alvo (escreva em minúsculas e SEM acentos).
  const PERGUNTAS = ["apoio com ia", "ia foi efetiva"];

  // Texto da opção que deve ser pré-selecionada nos radios (min., sem acento).
  const OPCAO_ALVO = "nao";

  // --- Status do ticket ---
  const STATUS_ALVO = "resolvido";
  const STATUS_ATUAL_PERMITIDO = ["novo"];
  const CAMINHOS_STATUS = ["/ticket/chatvisualize/", "/ticket/chatattendance/"];

  // --- Timings (ms). Extraídos de valores empíricos observados no Movidesk. ---
  // TIMING_POLL_SELECT2/TIMING_MAX_TENTATIVAS_SELECT2 valem tanto para o status
  // quanto para categoria/urgência: os três são o mesmo mecanismo (#select2-drop).
  const TIMING_POLL_SELECT2 = 100;
  const TIMING_MAX_TENTATIVAS_SELECT2 = 20;  // ~2s
  const TIMING_POLL_SERVICO = 150;
  const TIMING_MAX_TENTATIVAS_SERVICO = 30;  // ~4.5s (árvore jqxTree é mais lenta que select2)
  const TIMING_DESTAQUE_MS = 1600;
  const TIMING_APOS_SERVICO_MS = 600; // respiro p/ Movidesk auto-preencher categoria/urgência
  // 600ms: medido ao vivo que a categoria fica ~388ms com "select2-container-disabled"
  // após selecionar (Movidesk provavelmente processa algo antes de liberar urgência).
  // 250ms era menor que essa janela real — por isso a urgência falhava intermitente.
  const TIMING_ENTRE_SELECT2_MS = 600;
  // ======================================================================

  let enabled = true;
  let debounceTimer = null;
  let statusJaFeito = false;   // status já resolvido no ticket atual
  let statusEmAndamento = false; // #4: há um setInterval de status ativo?
  let aplicando = false;       // #3: trava de reentrância do observer
  let timerServicoAtivo = null; // setInterval de preencherServico, p/ cleanup em beforeunload

  // #1: referências dos reforços agendados, para cancelar a bateria anterior
  // antes de abrir outra (senão os timers acumulam a cada troca de ticket).
  let reforcoTimers = [];

  // Normaliza texto: minúsculas, sem acentos, espaços colapsados.
  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // Só uma aba de ticket fica visível; todas compartilham o mesmo "name".
  // offsetParent === null indica elemento oculto (display:none em ancestral).
  function ehVisivel(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    const r = el.getClientRects();
    return r && r.length > 0;
  }

  // Visibilidade ESTRITA para os campos de fechamento: usa apenas
  // offsetParent (critério que comprovadamente distingue a aba visível das
  // ocultas neste Movidesk). Sem o fallback getClientRects, que pode dar
  // falso-positivo em cópias ocultas e fazer clicar na aba errada.
  function acharVisivel(seletor) {
    const els = document.querySelectorAll(seletor);
    return Array.from(els).find((e) => e.offsetParent !== null) || null;
  }

  // ----------------------- ENQUETE "NÃO" (radios) -----------------------

  // Menor elemento VISÍVEL cujo texto contém a pergunta (= título na aba ativa).
  function menorElementoContendo(chave) {
    const buscarEm = (sel) => {
      let melhor = null;
      let melhorTam = Infinity;
      for (const el of document.body.querySelectorAll(sel)) {
        if (!ehVisivel(el)) continue;
        const t = norm(el.textContent);
        if (t.includes(chave) && t.length < melhorTam) {
          melhor = el;
          melhorTam = t.length;
        }
      }
      return melhor;
    };
    return (
      buscarEm("label,span,div,td,th,legend,h1,h2,h3,h4,h5,h6,p,a") ||
      buscarEm("*")
    );
  }

  // O radio "Não" que pertence à PRÓPRIA pergunta (ancorado no bloco dela).
  function radioNaoDaPergunta(chave) {
    const titulo = menorElementoContendo(chave);
    if (!titulo) return null;

    const ehNao = (input) => {
      const l = input.closest("label");
      return l && norm(l.textContent) === OPCAO_ALVO;
    };

    let escopo = titulo;
    for (let i = 0; i < 6 && escopo; i++) {
      const nao = Array.from(
        escopo.querySelectorAll('label input[type="radio"]')
      ).find((input) => ehNao(input) && ehVisivel(input));
      if (nao) return nao;
      escopo = escopo.parentElement;
    }
    return null;
  }

  // Retorna { marcados, pendentes }:
  //  - pendentes: perguntas-alvo ainda sem resposta na aba visível (ou ainda
  //    não renderizadas). Usado por #6 para saber quando parar os reforços.
  function aplicarRadios() {
    let marcados = 0;
    let pendentes = 0;

    for (const chave of PERGUNTAS) {
      const radio = radioNaoDaPergunta(chave);

      if (!radio) {
        // Título/radio ainda não renderizou na aba visível: segue pendente.
        pendentes++;
        continue;
      }
      if (radio.checked) continue; // já é o "Não": resolvida

      const name = radio.getAttribute("name");
      if (name) {
        const grupo = document.querySelectorAll(
          `input[type="radio"][name="${CSS.escape(name)}"]`
        );
        // Respondida na aba visível (por você ou por nós): resolvida.
        if (Array.from(grupo).some((r) => r.checked && ehVisivel(r))) continue;
      }

      if (radio.disabled) {
        pendentes++; // existe mas não dá para marcar agora
        continue;
      }

      radio.click();
      destacar(radio.closest("label") || radio);
      marcados++;
    }

    return { marcados, pendentes };
  }

  // ----------------------- STATUS DO TICKET (Select2) -----------------------

  function urlPermiteStatus() {
    if (!CAMINHOS_STATUS.length) return true;
    const caminho = norm(location.pathname);
    return CAMINHOS_STATUS.some((c) => caminho.includes(c));
  }

  function containerStatus() {
    const cands = document.querySelectorAll(
      ".ticket-status-container .select2-choice, .ticket-select-status .select2-choice"
    );
    return Array.from(cands).find(ehVisivel) || null;
  }

  function statusAtual() {
    const cands = document.querySelectorAll(
      ".ticket-status-container .select2-chosen, .ticket-select-status .select2-chosen"
    );
    const chosen = Array.from(cands).find(ehVisivel);
    return chosen ? norm(chosen.textContent) : null;
  }

  function opcaoNaLista(alvo) {
    const itens = document.querySelectorAll(
      "#select2-drop .select2-results > li.select2-result-selectable"
    );
    for (const li of itens) {
      if (li.classList.contains("select2-disabled")) continue;
      const label = li.querySelector(".select2-result-label");
      if (label && norm(label.textContent) === alvo) return { li, label };
    }
    return null;
  }

  // Dispara múltiplos eventos de uma vez (padrão comum em inputs manipulados via script).
  function dispararEventos(el, tipos) {
    for (const tipo of tipos) el.dispatchEvent(new Event(tipo, { bubbles: true }));
  }

  // Poll genérico usado tanto pelo status quanto pelas categorias/urgência do
  // select2: a lista de opções (#select2-drop) demora a renderizar após o
  // clique no choice, então espera aparecer em vez de usar delay fixo.
  //
  // `verificarSelecionado` confirma que o clique REALMENTE colou (mesmo padrão
  // usado no auto-"Não"/status: age, depois confere o estado real antes de
  // declarar sucesso). Sem isso, um clique que o Movidesk ignorar silenciosamente
  // seria reportado como sucesso mesmo sem ter mudado nada.
  //
  // REVERTIDO (v2.4.1 tentou re-clicar/reabrir a cada rodada sem confirmação;
  // quebrou categoria/urgência — provável conflito com o fechamento natural do
  // select2 logo após um clique bem-sucedido). Investigar causa raiz antes de
  // tentar de novo.
  function aguardarEClicarOpcao(alvoNorm, opts, verificarSelecionado, aoEncontrar, aoFalhar) {
    const maxTentativas = (opts && opts.maxTentativas) || TIMING_MAX_TENTATIVAS_SELECT2;
    const delayMs = (opts && opts.delayMs) || TIMING_POLL_SELECT2;
    let tentativas = 0;
    let cliquei = false;
    const timer = setInterval(() => {
      tentativas++;

      if (cliquei) {
        if (verificarSelecionado()) {
          clearInterval(timer);
          aoEncontrar();
          return;
        }
      } else {
        const alvo = opcaoNaLista(alvoNorm);
        if (alvo) {
          // select2 só reage a "mouseup" sintético na label da opção.
          alvo.label.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          cliquei = true; // confirma na(s) próxima(s) rodada(s), não assume sucesso aqui
        }
      }

      if (tentativas >= maxTentativas) {
        clearInterval(timer);
        if (aoFalhar) aoFalhar();
      }
    }, delayMs);
    return timer;
  }

  function aplicarStatus() {
    if (statusJaFeito) return false;
    if (statusEmAndamento) return false; // #4: evita intervals concorrentes
    if (!urlPermiteStatus()) return false;

    const atual = statusAtual();
    if (!atual) return false;

    if (atual === STATUS_ALVO) {
      statusJaFeito = true;
      return false;
    }
    if (!STATUS_ATUAL_PERMITIDO.includes(atual)) {
      statusJaFeito = true;
      return false;
    }

    const choice = containerStatus();
    if (!choice) return false;

    // #4: marca a intenção ANTES de qualquer await/click, fechando a janela
    // de corrida em que dois reforços abririam dois intervals.
    statusEmAndamento = true;
    choice.click();

    aguardarEClicarOpcao(
      STATUS_ALVO,
      {}, // mesmo timing padrão de select2 (status usa o mesmo mecanismo)
      () => statusAtual() === STATUS_ALVO, // confirma que realmente mudou
      () => {
        statusEmAndamento = false;
        statusJaFeito = true;
        const chosen = containerStatus();
        if (chosen) destacar(chosen);
        console.info('[Auto – Movidesk] Status alterado para "Resolvido".');
      },
      () => { statusEmAndamento = false; } // libera para nova tentativa depois
    );

    return true;
  }

  // ----------------------- UTIL / ORQUESTRAÇÃO -----------------------

  function destacar(el) {
    const anterior = el.style.boxShadow;
    el.style.transition = "box-shadow .3s ease";
    el.style.boxShadow = "0 0 0 3px rgba(31, 143, 106, .45)";
    setTimeout(() => {
      el.style.boxShadow = anterior;
    }, TIMING_DESTAQUE_MS);
  }

  // Retorna true quando não há mais nada pendente (radios + status resolvidos).
  function aplicar() {
    if (!enabled || !document.body) return true;

    // #3: desconecta o observer enquanto agimos; nossas próprias mudanças
    // (click, destaque, status) não devem re-disparar aplicar().
    aplicando = true;
    let tudoResolvido = false;
    try {
      const { marcados, pendentes } = aplicarRadios();
      if (marcados > 0) {
        console.info(`[Auto Não – Enquete IA] ${marcados} pergunta(s) pré-selecionada(s) como "Não".`);
      }
      const statusResolvido =
        statusJaFeito || !urlPermiteStatus() ? true : (aplicarStatus(), statusJaFeito);

      // "Resolvido" só conta para telas onde o status se aplica.
      tudoResolvido = pendentes === 0 && (!urlPermiteStatus() || statusJaFeito);
    } finally {
      // Reconecta na próxima volta do loop (depois das mutações que causámos).
      setTimeout(() => { aplicando = false; }, 0);
    }
    return tudoResolvido;
  }

  // #1 + #6: cancela a bateria anterior e agenda uma nova; cada reforço se
  // auto-cancela do array quando dispara, e a bateria para cedo se tudo já
  // estiver resolvido (evita revarrer o DOM por 20s à toa).
  function limparReforcos() {
    for (const t of reforcoTimers) clearTimeout(t);
    reforcoTimers = [];
  }

  function agendarReaplicacoes() {
    limparReforcos();
    for (let ms = 500; ms <= 20000; ms += 1000) {
      const id = setTimeout(() => {
        reforcoTimers = reforcoTimers.filter((x) => x !== id);
        if (aplicar()) limparReforcos(); // #6: resolvido -> cancela o resto
      }, ms);
      reforcoTimers.push(id);
    }
  }

  function iniciar() {
    chrome.storage.sync.get({ enabled: true }, (cfg) => {
      enabled = cfg.enabled;
      aplicar();
      agendarReaplicacoes();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.enabled) {
        enabled = changes.enabled.newValue;
        if (enabled) {
          aplicar();
          agendarReaplicacoes();
        } else {
          limparReforcos(); // desligou: não deixa reforços rodando
        }
      }
    });

    let urlAtual = location.href;
    function aoTrocarUrl() {
      if (location.href === urlAtual) return;
      urlAtual = location.href;
      statusJaFeito = false;
      statusEmAndamento = false; // novo ticket: zera estado do status
      aplicar();
      agendarReaplicacoes();
    }

    // Detecta navegação de SPA no mecanismo real (pushState/replaceState/popstate).
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function () {
      const r = _push.apply(this, arguments);
      setTimeout(aoTrocarUrl, 0);
      return r;
    };
    history.replaceState = function () {
      const r = _replace.apply(this, arguments);
      setTimeout(aoTrocarUrl, 0);
      return r;
    };
    window.addEventListener("popstate", () => setTimeout(aoTrocarUrl, 0));

    const observer = new MutationObserver(() => {
      if (aplicando) return; // #3: ignora mutações que nós mesmos causámos
      if (location.href !== urlAtual) {
        aoTrocarUrl();
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(aplicar, 400);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // iniciar() roda ANTES do bloco de fechamento: assim a lógica automática
  // (auto-"Não" + status) é registrada primeiro e nunca é afetada por um
  // eventual erro na telinha de fechamento abaixo.
  iniciar();

  // ====================================================================
  //            PREENCHIMENTO DE FECHAMENTO (telinha do popup)
  // ====================================================================
  // Isolado num try para que qualquer falha aqui não derrube o iniciar() acima.
  try {
    // ASSUNTO: "LOJA - EMPRESA" + digitado -> "DIGITADO - EMPRESA".
    var preencherAssunto = function (assuntoDigitado) {
      if (!assuntoDigitado) return { ok: true, campo: "assunto", pulado: true };
      const input = acharVisivel('input.subject, input[name="Subject"]');
      if (!input) return { ok: false, campo: "assunto", motivo: "campo visível não encontrado" };
      const atual = input.value || "";
      const idx = atual.indexOf(" - ");
      const empresa = idx >= 0 ? atual.slice(idx + 3).trim() : atual.trim();
      const novo = empresa ? `${assuntoDigitado.trim()} - ${empresa}` : assuntoDigitado.trim();
      if (novo === atual) return { ok: true, campo: "assunto", jaEstava: true };
      input.value = novo;
      dispararEventos(input, ["input", "change"]);
      return { ok: true, campo: "assunto", valor: novo };
    };

    // SELECT2 (categoria/urgência) por texto — MESMA mecânica do status.
    // Assíncrono.
    var selecionarSelect2 = function (classe, textoAlvo, cb) {
      if (!textoAlvo) { cb({ ok: true, pulado: true }); return; }

      const container = acharVisivel(`.select2-container.${classe}`);
      if (!container) { cb({ ok: false, motivo: "dropdown visível não encontrado" }); return; }
      const choice = container.querySelector(".select2-choice");
      if (!choice) { cb({ ok: false, motivo: "choice não encontrado" }); return; }

      const chosenAtual = () => {
        const chosen = container.querySelector(".select2-chosen");
        return chosen ? norm(chosen.textContent) : null;
      };

      // Já está no valor desejado: nem abre a lista. Dropdown que não abre é
      // dropdown que não falha. A comparação é "já é igual ao alvo", não "já
      // está preenchido" -- valor diferente continua sendo trocado.
      if (chosenAtual() === norm(textoAlvo)) { cb({ ok: true, jaEstava: true }); return; }

      choice.click(); // abre a lista (igual ao status)

      aguardarEClicarOpcao(
        norm(textoAlvo),
        {},
        () => chosenAtual() === norm(textoAlvo), // confirma que realmente selecionou
        () => cb({ ok: true }),
        () => cb({ ok: false, motivo: `opção "${textoAlvo}" não apareceu na lista ou não confirmou seleção` })
      );
    };

    // SERVIÇO (árvore jqxTree). Fluxo: abre a árvore -> acha o LI do nó-pai
    // (DataSys) -> expande -> procura o filho SÓ dentro do <ul> dele.
    //
    // Nome do nó: pega o textContent do wrapper direto (item > wrapper), sem
    // assumir nenhum nível extra de aninhamento — confirmado contra o DOM real
    // via teste manual no console (ver histórico de depuração).
    var nomeDoNoServico = function (item) {
      const wrapper = item.querySelector(":scope > div");
      return wrapper ? wrapper.textContent.trim() : "";
    };

    // Acha o LI de um nó-pai (ex.: DataSys) entre os nós-pai visíveis no
    // nível atual da árvore. Retorna o <li>, não o .jqx-tree-item, porque
    // precisamos dos seus irmãos diretos (a seta e o <ul> de filhos).
    var acharLiPai = function (nomePai) {
      const lis = document.querySelectorAll("li.jqx-tree-item-li");
      for (const li of lis) {
        if (li.offsetParent === null) continue; // pula abas ocultas
        const item = li.querySelector(":scope > .jqx-tree-item");
        if (!item) continue;
        // Um nó-pai é identificado pela SETA de expandir, não pela classe
        // .notSelectable. Medição nos 21 sistemas em 2026-09-22: seis dos 19
        // em escopo (Autua, Cadastro de Declaração de Grande Gerador, Gaia,
        // Scripts CSJ, Sistema TRS, Unipark) NÃO têm essa classe, e com ela
        // no filtro nenhum deles era encontrado -- 32% dos sistemas falhando
        // em silêncio. É seguro porque nenhum nome de sistema existe também
        // como nome de serviço (21 pais x 79 filhos distintos, interseção vazia).
        if (!li.querySelector(":scope > .jqx-tree-item-arrow-collapse")) continue;
        if (norm(nomeDoNoServico(item)) === norm(nomePai)) return li;
      }
      return null;
    };

    // Procura o filho pelo nome, ESCOPADO ao <ul> do próprio pai — evita
    // colisão com filhos de mesmo nome em OUTROS pais (ex.: "Administrativo"
    // existe tanto em DataSys quanto em Assist; buscar na árvore toda pegaria
    // o primeiro que aparecesse no DOM, não necessariamente o certo).
    var acharFilhoDoPai = function (liPai, txt) {
      const ul = liPai.querySelector(":scope > ul.jqx-tree-dropdown");
      if (!ul) return null;
      const itens = ul.querySelectorAll(":scope > li.jqx-tree-item-li > .jqx-tree-item");
      for (const item of itens) {
        if (item.offsetParent === null) continue;
        if (norm(nomeDoNoServico(item)) === norm(txt)) return item;
      }
      return null;
    };

    var preencherServico = function (sistema, txt, cb) {
      if (!txt) { cb({ ok: true, campo: "servico", pulado: true }); return; }
      // Sem o pai não há onde procurar: 11 nomes de serviço existem em mais de
      // um sistema. Acontece com preset legado numa máquina onde a migração
      // ainda não rodou.
      if (!sistema) {
        cb({ ok: false, campo: "servico", motivo: `serviço "${txt}" está sem sistema — reabra o preset e escolha o sistema` });
        return;
      }

      const campo = acharVisivel(".md-select-treeview-dropdown-field");
      if (!campo) { cb({ ok: false, campo: "servico", motivo: "campo visível não encontrado" }); return; }

      const nomeAtual = campo.querySelector(".name");
      if (nomeAtual && norm(nomeAtual.textContent) === norm(txt)) {
        cb({ ok: true, campo: "servico", jaEstava: true });
        return;
      }

      campo.click(); // abre a árvore

      // `resultado` só é setado uma vez por tick, e cb() roda FORA do try —
      // assim uma exceção lançada pelo próprio cb() nunca cai no catch daqui
      // e dispara uma segunda chamada de cb() com um resultado de erro.
      //
      // Verificação pós-clique: mesmo padrão do auto-"Não"/status — clicar
      // não é o mesmo que confirmar. Só declara sucesso quando `.name` do
      // campo realmente mudou para o texto certo; se o clique não colou,
      // a PRÓXIMA rodada acha o item de novo e clica de novo (retry natural).
      let tentativas = 0;
      const timer = setInterval(() => {
        tentativas++;
        let resultado = null;
        try {
          const nomeAgora = campo.querySelector(".name");
          if (nomeAgora && norm(nomeAgora.textContent) === norm(txt)) {
            resultado = { ok: true, campo: "servico" };
          } else {
            const liPai = acharLiPai(sistema);
            if (!liPai) {
              if (tentativas >= TIMING_MAX_TENTATIVAS_SERVICO) {
                resultado = { ok: false, campo: "servico", motivo: `sistema "${sistema}" não encontrado na árvore` };
              }
            } else {
              const seta = liPai.querySelector(":scope > .jqx-tree-item-arrow-collapse");
              if (seta && seta.classList.contains("jqx-icon-arrow-right") && seta.offsetParent !== null) {
                seta.click();
              }

              const item = acharFilhoDoPai(liPai, txt);
              if (item) {
                item.click(); // confirmação acontece na próxima rodada (checagem do .name acima)
              }
              if (tentativas >= TIMING_MAX_TENTATIVAS_SERVICO) {
                // Três motivos distintos de propósito: saber em qual etapa
                // parou transforma um relato do usuário em diagnóstico direto.
                resultado = {
                  ok: false,
                  campo: "servico",
                  motivo: item
                    ? `clique em "${txt}" não confirmado (seleção não refletiu no campo)`
                    : `sistema "${sistema}" encontrado, mas o serviço "${txt}" não apareceu entre os filhos dele`,
                };
              }
            }
          }
        } catch (e) {
          console.error("[Auto – Movidesk] Exceção ao preencher serviço:", e);
          resultado = { ok: false, campo: "servico", motivo: "exceção: " + (e.message || String(e)) };
        }

        if (resultado) {
          clearInterval(timer);
          cb(resultado);
        }
      }, TIMING_POLL_SERVICO);

      timerServicoAtivo = timer;
    };

    var clicarNovaAcao = function () {
      const btns = document.querySelectorAll("button.btn-add-action");
      const btn = Array.from(btns).find(ehVisivel) || btns[0];
      if (!btn) return { ok: false, campo: "novaAcao", motivo: "botão não encontrado" };
      btn.click();
      return { ok: true, campo: "novaAcao" };
    };

    // Wrapper: respeita campo vazio e delega à selecionarSelect2 assíncrona.
    var tentarSelect2Campo = function (classe, txt, nomeCampo, cb) {
      if (!txt) { cb({ ok: true, campo: nomeCampo, pulado: true }); return; }
      selecionarSelect2(classe, txt, (r) => cb({ ok: r.ok, campo: nomeCampo, motivo: r.motivo }));
    };

    // Preenche Serviço -> Categoria -> Urgência -> Assunto. ÚNICO caminho de
    // preenchimento: tanto o botão "Preencher ticket" quanto o comando de
    // expansão entram por aqui, então os dois não podem divergir (já
    // divergiram uma vez, e o fluxo do comando perdeu os respiros abaixo).
    //
    // Serviço vem primeiro porque, ao selecioná-lo, o Movidesk auto-preenche
    // categoria e urgência — só depois sobrescrevemos essas duas, e só se
    // você tiver escolhido valores na telinha.
    //
    // A ação pública NÃO é preenchida aqui: quem escreve esse texto é a
    // própria expansão do comando, onde o cursor estiver.
    var preencherCampos = function (dados, aoTerminar) {
      aplicando = true;
      const relatorio = [];

      preencherServico(dados.sistema, dados.servico, (rServico) => {
        relatorio.push(rServico);

        setTimeout(() => {
          tentarSelect2Campo("category", dados.categoria, "categoria", (rc) => {
            relatorio.push(rc);
            setTimeout(() => {
              tentarSelect2Campo("urgency", dados.urgencia, "urgencia", (ru) => {
                relatorio.push(ru);
                relatorio.push(preencherAssunto(dados.assunto));
                setTimeout(() => { aplicando = false; }, 0);
                aoTerminar(relatorio);
              });
            }, TIMING_ENTRE_SELECT2_MS);
          });
        }, TIMING_APOS_SERVICO_MS);
      });
    };

    // ===================== EXPANSÃO DE TEXTO (comandos) =====================
    // Monta a lista de comandos a partir dos presets e entrega pro expansor.js
    // (arquivo separado, sem conhecimento nenhum de Movidesk/serviço/categoria).
    var montarComandos = function (lista) {
      return lista
        .filter((p) => p && p.comando)
        .map((p) => ({
          comando: p.comando,
          texto: p.texto || "",
          aoExpandir: () => {
            preencherCampos(p, () => {});
          },
        }));
    };

    // Lê os presets no formato novo (uma chave "preset:<id>" por preset).
    // Fallback para o formato antigo (chave única "presets", campo "resumo")
    // enquanto alguma máquina ainda não abriu a telinha e migrou.
    var lerPresets = function (tudo) {
      const novos = Object.keys(tudo)
        .filter((k) => k.startsWith("preset:"))
        .map((k) => tudo[k]);
      if (novos.length) return novos;
      return Object.entries(tudo.presets || {})
        .filter(([, p]) => p) // a guarda existia antes desta entrega e sumiu:
                              // um null aqui derruba o registro de TODOS os comandos
        .map(([nome, p]) => ({
          nome,
          comando: p.comando,
          texto: p.resumo,
          assunto: p.assunto,
          // Preset em formato antigo é necessariamente DataSys: PAI_SERVICO era
          // constante. Mesmo motivo da migração v3 no presets.js.
          sistema: "DataSys",
          servico: p.servico,
          categoria: p.categoria,
          urgencia: p.urgencia,
        }));
    };

    var atualizarExpansor = function () {
      chrome.storage.sync.get(null, (tudo) => {
        const presets = lerPresets(tudo);
        const exigirDelimitador = !!tudo.expansaoDelimitadorObrigatorio;
        const lista = montarComandos(presets);

        console.info(
          `[Expansor] ${presets.length} preset(s) salvo(s): [${presets.map((p) => p.nome).join(", ")}] | ` +
            `${lista.length} com comando: [${lista.map((c) => c.comando).join(", ")}] | ` +
            `delimitador obrigatório: ${exigirDelimitador}`
        );

        if (typeof window.__expansorRegistrarComandos === "function") {
          window.__expansorRegistrarComandos(lista);
        } else {
          console.warn("[Expansor] expansor.js não carregou — window.__expansorRegistrarComandos indisponível.");
        }
        if (typeof window.__expansorConfigurar === "function") {
          window.__expansorConfigurar({ exigirDelimitador });
        }
      });
    };

    atualizarExpansor();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const relevante = Object.keys(changes).some(
        (k) => k.startsWith("preset:") || k === "presets" || k === "expansaoDelimitadorObrigatorio"
      );
      if (relevante) atualizarExpansor();
    });

    // Cleanup: limpa o polling de preencherServico se o usuário sair da
    // página no meio do preenchimento (evita callback em DOM já descartado).
    window.addEventListener("beforeunload", () => {
      if (timerServicoAtivo) clearInterval(timerServicoAtivo);
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.tipo === "preencher-fechamento") {
        try {
          preencherCampos(msg.dados || {}, (relatorio) => sendResponse({ ok: true, relatorio }));
        } catch (e) {
          sendResponse({ ok: false, erro: String(e) });
        }
        return true;
      }
      if (msg && msg.tipo === "ping") { sendResponse({ ok: true }); return true; }
    });
  } catch (e) {
    console.error("[Auto – Movidesk] Falha ao inicializar a telinha de fechamento:", e);
  }
})();
