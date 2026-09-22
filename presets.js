// Camada de dados dos presets. Sem DOM, sem chrome.tabs: só storage.
// Compartilhada por popup.js, dashboard.js e (na leitura) content.js, para
// que as duas telas não divirjam — foi assim que o comando de expansão
// perdeu os timings do botão numa entrega anterior.
(() => {
  "use strict";

  const raiz = typeof window !== "undefined" ? window : globalThis;
  if (raiz.Presets) return;

  const PREFIXO = "preset:";
  const VERSAO = 3;
  // Todo preset criado antes da v3 é necessariamente DataSys: `PAI_SERVICO`
  // era constante no content.js, não havia outra opção possível.
  const SISTEMA_LEGADO = "DataSys";
  const CAMPOS_TICKET = ["assunto", "servico", "categoria", "urgencia"];

  // chrome.storage já devolve Promise no Chrome moderno, mas manter o
  // callback explícito é o que permite checar lastError: um set que estoura
  // a quota falha EM SILÊNCIO, e foi exatamente esse bug que motivou a
  // migração para uma chave por preset.
  const envolver = (metodo) => (arg) =>
    new Promise((resolver, rejeitar) => {
      chrome.storage.sync[metodo](arg, (valor) => {
        const erro = chrome.runtime.lastError;
        if (erro) rejeitar(new Error(erro.message));
        else resolver(valor);
      });
    });
  const ler = envolver("get");
  const gravar = envolver("set");
  const apagar = envolver("remove");

  const semAcento = (s) =>
    (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  // Todo campo vira string: o resto do código nunca precisa checar undefined.
  function completar(p) {
    const t = (v) => (v == null ? "" : String(v)).trim();
    return {
      id: t(p && p.id),
      nome: t(p && p.nome),
      comando: t(p && p.comando),
      texto: p && p.texto != null ? String(p.texto) : "", // texto preserva espaços/linhas
      assunto: t(p && p.assunto),
      sistema: t(p && p.sistema),
      servico: t(p && p.servico),
      categoria: t(p && p.categoria),
      urgencia: t(p && p.urgencia),
    };
  }

  function validar(p) {
    const c = completar(p);
    if (!c.nome) return { ok: false, motivo: "Dê um nome ao preset." };
    // Serviço sem sistema é ambíguo: 11 nomes de serviço existem em mais de um
    // sistema ("Integrações" em 6 deles), então o par é que identifica.
    if (c.servico && !c.sistema) {
      return { ok: false, motivo: "Escolha um serviço da lista — o sistema vem junto com ele." };
    }
    if (!c.texto.trim() && !CAMPOS_TICKET.some((k) => c[k])) {
      return {
        ok: false,
        motivo: "Preencha o texto de expansão ou ao menos um campo do ticket.",
      };
    }
    return { ok: true };
  }

  // Dois presets com o mesmo comando são ambíguos: o expansor casa o
  // primeiro que encontrar. Quem chama decide se bloqueia ou avisa.
  function conflitoDeComando(p, lista) {
    const c = completar(p);
    if (!c.comando) return null;
    return lista.find((o) => o.id !== c.id && o.comando === c.comando) || null;
  }

  function ordenar(lista) {
    return [...lista].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }

  function filtrar(lista, consulta) {
    const q = semAcento(consulta).trim();
    if (!q) return lista;
    return lista.filter(
      (p) =>
        semAcento(p.nome).includes(q) ||
        semAcento(p.comando).includes(q) ||
        semAcento(p.texto).includes(q)
    );
  }

  async function listar() {
    const tudo = await ler(null);
    return ordenar(
      Object.keys(tudo)
        .filter((k) => k.startsWith(PREFIXO))
        .map((k) => completar(tudo[k]))
    );
  }

  async function salvar(p) {
    const v = validar(p);
    if (!v.ok) throw new Error(v.motivo);
    const c = completar(p);
    if (!c.id) c.id = crypto.randomUUID();
    await gravar({ [PREFIXO + c.id]: c });
    return c;
  }

  async function excluir(id) {
    await apagar(PREFIXO + id);
  }

  // Formato 1 (uma chave `presets` com tudo dentro, teto de 8KB) -> formato 2
  // (uma chave por preset). O id migrado é derivado do nome antigo, não
  // aleatório: assim rodar a migração de novo depois de uma falha no meio
  // SOBRESCREVE o que já entrou em vez de duplicar.
  async function migrar() {
    const tudo = await ler(null);
    const presets = tudo.presets || null;
    const presetsVersao = tudo.presetsVersao || 0;
    // Um preset:* pode chegar pelo sync JÁ no formato v2, vindo de uma máquina
    // num build anterior, depois desta aqui ter marcado a versão 3. Sair só
    // por versão deixaria esse preset sem sistema para sempre.
    const precisaV3 = Object.keys(tudo).some((k) => {
      if (!k.startsWith(PREFIXO)) return false;
      const p = completar(tudo[k]);
      return p && p.servico && !p.sistema;
    });
    // A guarda de versão sozinha não basta: o chrome.storage.sync entrega os
    // dados de forma assíncrona depois do login, então numa máquina nova a
    // migração pode rodar com o store vazio, marcar a versão, e só DEPOIS o
    // sync entregar a chave `presets` da outra máquina. Se sairmos só por
    // versão, esses presets ficam invisíveis para sempre (listar() só olha
    // `preset:*`). Enquanto houver formato antigo no storage, migra de novo —
    // é seguro porque o id é derivado do nome (mesma chave nas duas passadas,
    // então nada duplica) e porque o `continue` abaixo pula o que já migrou
    // (então nada sobrescreve uma edição posterior do usuário).
    if (presetsVersao >= VERSAO && !presets && !precisaV3) return;

    for (const [nome, d] of Object.entries(presets || {})) {
      const convertido = completar({
        // encodeURIComponent porque completar() dá trim() no id: sem isso,
        // "Nota " e "Nota" (espaço sobrando do prompt() antigo) derivariam a
        // MESMA chave e um dos dois presets seria sobrescrito em silêncio.
        id: "v1-" + encodeURIComponent(nome),
        nome,
        comando: d && d.comando,
        texto: d && d.resumo, // o campo sempre foi o texto de expansão
        assunto: d && d.assunto,
        servico: d && d.servico,
        categoria: d && d.categoria,
        urgencia: d && d.urgencia,
      });
      // Não reescreve preset que já migrou: a guarda de versão deixa a
      // migração rodar de novo enquanto a chave antiga existir, e sem isto
      // cada passada sobrescreveria com o conteúdo velho do formato 1 uma
      // edição que o usuário já fez no formato 2.
      if (tudo[PREFIXO + convertido.id]) continue;
      // Um set por preset: se um estourar 8KB, os outros ainda entram e o
      // erro diz qual falhou, em vez de perder a migração inteira.
      await gravar({ [PREFIXO + convertido.id]: convertido });
    }

    // Passo v2 -> v3: relê o storage porque o laço acima pode ter acabado de
    // gravar presets novos, que também precisam do sistema. Roda sempre que
    // chegamos aqui (a guarda no topo já garantiu que há trabalho a fazer),
    // e é idempotente: pula quem já tem sistema.
    const apos = await ler(null);
    for (const chave of Object.keys(apos)) {
      if (!chave.startsWith(PREFIXO)) continue;
      const p = completar(apos[chave]);
      if (!p.servico || p.sistema) continue;
      await gravar({ [chave]: Object.assign({}, p, { sistema: SISTEMA_LEGADO }) });
    }

    await gravar({ presetsVersao: VERSAO });
    await apagar(["presets", "rascunhoFechamento"]);
  }

  raiz.Presets = {
    PREFIXO,
    completar,
    validar,
    conflitoDeComando,
    ordenar,
    filtrar,
    listar,
    salvar,
    excluir,
    migrar,
  };
})();
