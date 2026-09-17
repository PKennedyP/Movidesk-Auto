(() => {
  "use strict";

  if (window.__expansorTextoAtivo) return;
  window.__expansorTextoAtivo = true;

  let comandos = [];
  let exigirDelimitador = false;

  window.__expansorRegistrarComandos = function (lista) {
    comandos = Array.isArray(lista)
      ? [...lista].sort((a, b) => b.comando.length - a.comando.length)
      : [];
  };
  window.__expansorConfigurar = function (opts) {
    if (opts && typeof opts.exigirDelimitador === "boolean") {
      exigirDelimitador = opts.exigirDelimitador;
    }
  };

  const CARACTERES_DELIMITADORES = " \t\n.,;:!?";
  const MAX_OLHAR_PARA_TRAS = 40;

  function ehLetraOuNumero(ch) {
    return /[\p{L}\p{N}]/u.test(ch);
  }

  function acharComandoNoFim(texto) {
    for (const c of comandos) {
      if (!texto.endsWith(c.comando)) continue;
      const antes = texto.length - c.comando.length - 1;
      if (antes >= 0 && ehLetraOuNumero(texto[antes])) continue;
      return c;
    }
    return null;
  }

  function textoAntesDoCursorInput(el) {
    const fim = el.selectionStart;
    const inicio = Math.max(0, fim - MAX_OLHAR_PARA_TRAS);
    return { texto: el.value.slice(inicio, fim), fim };
  }

  function substituirInput(el, tamanho, textoNovo, fim) {
    el.setRangeText(textoNovo, fim - tamanho, fim, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Só considera o cursor "simples" (sem seleção de texto) dentro de um nó
  // de texto puro — cobre o caso normal de digitação contínua sem formatação
  // no meio da palavra.
  function textoAntesDoCursorEditable(el) {
    const selecao = window.getSelection();
    if (!selecao || selecao.rangeCount === 0) return null;
    const range = selecao.getRangeAt(0);
    if (!range.collapsed) return null;
    const noTexto = range.startContainer;
    if (noTexto.nodeType !== Node.TEXT_NODE) return null;
    if (!el.contains(noTexto)) return null;
    const offset = range.startOffset;
    const inicio = Math.max(0, offset - MAX_OLHAR_PARA_TRAS);
    return { texto: noTexto.textContent.slice(inicio, offset), noTexto, offset };
  }

  // execCommand('insertText', ...) em vez de manipular o Range manualmente:
  // passa pelo mesmo caminho de eventos de uma digitação real, então o
  // Froala reconhece a mudança nativamente (sem eventos sintéticos extras).
  function substituirEditable(noTexto, offset, tamanho, textoNovo) {
    const selecao = window.getSelection();
    const range = document.createRange();
    range.setStart(noTexto, offset - tamanho);
    range.setEnd(noTexto, offset);
    selecao.removeAllRanges();
    selecao.addRange(range);
    document.execCommand("insertText", false, textoNovo);
  }

  let processando = false;

  function processarEvento(e) {
    if (!e.isTrusted || processando) return;

    const el = e.target;
    const tag = el.tagName;
    const ehInput = tag === "INPUT" || tag === "TEXTAREA";
    const ehEditavel = !ehInput && el.isContentEditable === true;
    if (!ehInput && !ehEditavel) return;

    const contexto = ehInput ? textoAntesDoCursorInput(el) : textoAntesDoCursorEditable(el);
    if (!contexto) return;

    let textoParaComparar = contexto.texto;
    let tamanhoDelimitador = 0;
    if (exigirDelimitador) {
      const ultimo = contexto.texto[contexto.texto.length - 1];
      if (!ultimo || CARACTERES_DELIMITADORES.indexOf(ultimo) === -1) return;
      textoParaComparar = contexto.texto.slice(0, -1);
      tamanhoDelimitador = 1;
    }

    const comando = acharComandoNoFim(textoParaComparar);
    if (!comando) return;

    console.info(
      `[Expansor] Comando "${comando.comando}" detectado em <${tag.toLowerCase()}> — expandindo` +
        ` para ${comando.texto.length} caractere(s).`
    );

    const tamanhoTotal = comando.comando.length + tamanhoDelimitador;
    processando = true;
    try {
      if (ehInput) {
        substituirInput(el, tamanhoTotal, comando.texto, contexto.fim);
      } else {
        substituirEditable(contexto.noTexto, contexto.offset, tamanhoTotal, comando.texto);
      }
    } finally {
      processando = false;
    }

    if (typeof comando.aoExpandir === "function") {
      try {
        comando.aoExpandir();
      } catch (err) {
        console.error("[Expansor] Erro no aoExpandir:", err);
      }
    }
  }

  document.addEventListener("input", (e) => {
    try {
      processarEvento(e);
    } catch (err) {
      console.error("[Expansor] Erro ao processar digitação:", err);
    }
  });
})();
