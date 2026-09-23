// Autoteste de presets.js. Roda fora do Chrome com um storage falso.
// Não é framework: é o menor arquivo que quebra se a camada de dados quebrar.
const assert = require("assert");
const path = require("path");

// ---------- chrome.storage.sync falso ----------
let dados = {};
let erroNoSet = null; // quando string, o próximo set() falha com essa mensagem

function clonar(v) { return JSON.parse(JSON.stringify(v)); }

globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    sync: {
      get(chaves, cb) {
        chrome.runtime.lastError = null;
        if (chaves === null || chaves === undefined) return cb(clonar(dados));
        const saida = {};
        for (const [k, padrao] of Object.entries(chaves)) {
          saida[k] = k in dados ? clonar(dados[k]) : padrao;
        }
        cb(saida);
      },
      set(obj, cb) {
        if (erroNoSet) {
          chrome.runtime.lastError = { message: erroNoSet };
          erroNoSet = null;
          return cb();
        }
        chrome.runtime.lastError = null;
        Object.assign(dados, clonar(obj));
        cb();
      },
      remove(chaves, cb) {
        chrome.runtime.lastError = null;
        for (const k of [].concat(chaves)) delete dados[k];
        cb();
      },
    },
  },
};

require(path.join(__dirname, "presets.js"));
const P = globalThis.Presets;

function reset(d = {}) { dados = clonar(d); erroNoSet = null; }
const testes = [];
const teste = (nome, fn) => testes.push([nome, fn]);

// ---------- validação ----------
teste("nome vazio é inválido", () => {
  assert.strictEqual(P.validar({ nome: "", texto: "oi" }).ok, false);
  assert.strictEqual(P.validar({ nome: "   ", texto: "oi" }).ok, false);
});

teste("nome sozinho é inválido: preset precisa de pelo menos um campo", () => {
  const r = P.validar({ nome: "Vazio" });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /texto de expansão|campo do ticket/i);
});

teste("nome + texto é válido", () => {
  assert.strictEqual(P.validar({ nome: "Bom dia", texto: "Bom dia!" }).ok, true);
});

teste("nome + só um campo de ticket é válido (sem texto)", () => {
  assert.strictEqual(P.validar({ nome: "Só serviço", sistema: "DataSys", servico: "Administrativo" }).ok, true);
  assert.strictEqual(P.validar({ nome: "Só urgência", urgencia: "Dúvidas" }).ok, true);
});

teste("servico sem sistema é inválido", () => {
  const r = P.validar({ nome: "Sem sistema", servico: "Integrações" });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /sistema/i);
});

teste("sistema sozinho não satisfaz o pelo menos um", () => {
  const r = P.validar({ nome: "Só sistema", sistema: "Assist" });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /texto de expansão|campo do ticket/i);
});

teste("sistema + servico é válido", () => {
  assert.strictEqual(P.validar({ nome: "Ok", sistema: "Assist", servico: "SAC" }).ok, true);
});

teste("completar devolve sistema como string vazia quando ausente", () => {
  assert.strictEqual(P.completar({ nome: "X" }).sistema, "");
  assert.strictEqual(P.completar({ nome: "X", sistema: " Assist " }).sistema, "Assist");
});

teste("salvar e listar preservam o sistema", async () => {
  reset();
  await P.salvar({ nome: "Com sistema", sistema: "Gaia", servico: "Fiscal" });
  const lista = await P.listar();
  assert.strictEqual(lista[0].sistema, "Gaia");
  assert.strictEqual(lista[0].servico, "Fiscal");
});

// ---------- migração v2 -> v3 ----------
teste("migração v3 marca como DataSys o preset que tem servico e não tem sistema", async () => {
  reset({ presetsVersao: 2, "preset:a": { id: "a", nome: "A", servico: "Administrativo", texto: "x" } });
  await P.migrar();
  assert.strictEqual(dados.presetsVersao, 3);
  const lista = await P.listar();
  assert.strictEqual(lista[0].sistema, "DataSys");
  assert.strictEqual(lista[0].servico, "Administrativo");
});

teste("migração v3 não toca preset sem servico", async () => {
  reset({ presetsVersao: 2, "preset:b": { id: "b", nome: "Assinatura", texto: "Att" } });
  await P.migrar();
  const lista = await P.listar();
  assert.strictEqual(lista[0].sistema, "", "preset só-texto não pode ganhar sistema");
});

teste("migração v3 não sobrescreve sistema já escolhido", async () => {
  reset({ presetsVersao: 2, "preset:c": { id: "c", nome: "C", sistema: "Unipark", servico: "Conveniado", texto: "x" } });
  await P.migrar();
  const lista = await P.listar();
  assert.strictEqual(lista[0].sistema, "Unipark");
});

teste("formato antigo migra direto para v3, com sistema preenchido", async () => {
  reset({
    presets: {
      "Emissão de nota": { resumo: "erro na emissão", comando: "eemi", servico: "Administrativo" },
      "Bom dia": { resumo: "Bom dia!", comando: "bbom" },
    },
  });
  await P.migrar();
  assert.strictEqual(dados.presetsVersao, 3);
  assert.strictEqual("presets" in dados, false);
  const lista = await P.listar();
  const emissao = lista.find((p) => p.nome === "Emissão de nota");
  const bomDia = lista.find((p) => p.nome === "Bom dia");
  assert.strictEqual(emissao.sistema, "DataSys");
  assert.strictEqual(emissao.texto, "erro na emissão");
  assert.strictEqual(bomDia.sistema, "", "preset só-texto não ganha sistema nem vindo do formato 1");
});

teste("comando é opcional", () => {
  assert.strictEqual(P.validar({ nome: "Assinatura", comando: "", texto: "Att" }).ok, true);
});

// ---------- conflito de comando ----------
teste("conflito de comando acha outro preset com o mesmo comando", () => {
  const lista = [
    { id: "a", nome: "A", comando: "eemi" },
    { id: "b", nome: "B", comando: "bbom" },
  ];
  const c = P.conflitoDeComando({ id: "c", comando: "eemi" }, lista);
  assert.strictEqual(c && c.nome, "A");
});

teste("conflito ignora o próprio preset e comando vazio", () => {
  const lista = [{ id: "a", nome: "A", comando: "eemi" }];
  assert.strictEqual(P.conflitoDeComando({ id: "a", comando: "eemi" }, lista), null);
  assert.strictEqual(P.conflitoDeComando({ id: "z", comando: "" }, lista), null);
});

// ---------- ordenação e busca ----------
teste("ordena alfabeticamente respeitando acento", () => {
  const nomes = P.ordenar([
    { nome: "Emissão" }, { nome: "AnyDesk" }, { nome: "Ácido" }, { nome: "Bom dia" },
  ]).map((p) => p.nome);
  assert.deepStrictEqual(nomes, ["Ácido", "AnyDesk", "Bom dia", "Emissão"]);
});

teste("busca ignora caixa e acento, e olha nome, comando e texto", () => {
  const lista = [
    { nome: "Emissão de nota", comando: "eemi", texto: "erro na emissão" },
    { nome: "Bom dia", comando: "bbom", texto: "Bom dia!" },
  ];
  assert.strictEqual(P.filtrar(lista, "EMISSAO").length, 1);
  assert.strictEqual(P.filtrar(lista, "bbom").length, 1);
  assert.strictEqual(P.filtrar(lista, "erro").length, 1);
  assert.strictEqual(P.filtrar(lista, "").length, 2);
  assert.strictEqual(P.filtrar(lista, "zzz").length, 0);
});

// ---------- salvar / listar / excluir ----------
teste("salvar gera id e listar devolve ordenado", async () => {
  reset();
  await P.salvar({ nome: "Zebra", texto: "z" });
  const a = await P.salvar({ nome: "Alfa", texto: "a" });
  assert.ok(a.id, "salvar deve gerar um id");
  const lista = await P.listar();
  assert.deepStrictEqual(lista.map((p) => p.nome), ["Alfa", "Zebra"]);
});

teste("salvar com id existente mantém o id (renomear não orfana)", async () => {
  reset();
  const p = await P.salvar({ nome: "Antigo", texto: "x" });
  const r = await P.salvar({ ...p, nome: "Novo nome" });
  assert.strictEqual(r.id, p.id);
  const lista = await P.listar();
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].nome, "Novo nome");
});

teste("salvar preset inválido rejeita", async () => {
  reset();
  await assert.rejects(() => P.salvar({ nome: "", texto: "x" }));
});

teste("salvar propaga erro de quota do storage", async () => {
  reset();
  erroNoSet = "QUOTA_BYTES_PER_ITEM quota exceeded";
  await assert.rejects(() => P.salvar({ nome: "Grande", texto: "x" }), /quota/i);
});

teste("excluir remove só o preset pedido", async () => {
  reset();
  const a = await P.salvar({ nome: "A", texto: "a" });
  await P.salvar({ nome: "B", texto: "b" });
  await P.excluir(a.id);
  const lista = await P.listar();
  assert.deepStrictEqual(lista.map((p) => p.nome), ["B"]);
});

// ---------- migração ----------
const ANTIGO = {
  enabled: true,
  rascunhoFechamento: { assunto: "sujeira", resumo: "sujeira" },
  presets: {
    "Emissão de nota": {
      assunto: "Emissão de nota fiscal", resumo: "erro na emissão de nota fiscal.",
      servico: "Administrativo", categoria: "Dúvidas", urgencia: "Dúvidas", comando: "eemi",
    },
    "Bom dia": { assunto: "", resumo: "Bom dia!", servico: "", categoria: "", urgencia: "", comando: "bbom" },
  },
};

teste("migrar converte resumo->texto, marca versão e limpa o formato antigo", async () => {
  reset(ANTIGO);
  await P.migrar();
  assert.strictEqual(dados.presetsVersao, 3);
  assert.strictEqual("presets" in dados, false, "chave presets deve sair");
  assert.strictEqual("rascunhoFechamento" in dados, false, "rascunho deve sair");
  assert.strictEqual(dados.enabled, true, "não pode mexer em outras chaves");

  const lista = await P.listar();
  assert.deepStrictEqual(lista.map((p) => p.nome), ["Bom dia", "Emissão de nota"]);
  const emissao = lista.find((p) => p.nome === "Emissão de nota");
  assert.strictEqual(emissao.texto, "erro na emissão de nota fiscal.");
  assert.strictEqual(emissao.comando, "eemi");
  assert.strictEqual(emissao.servico, "Administrativo");
  assert.ok(emissao.id, "cada preset migrado precisa de id");
});

teste("migrar duas vezes não duplica", async () => {
  reset(ANTIGO);
  await P.migrar();
  await P.migrar();
  assert.strictEqual((await P.listar()).length, 2);
});

teste("migrar é idempotente mesmo se a primeira tentativa falhar no meio", async () => {
  reset(ANTIGO);
  erroNoSet = "falha simulada";
  await assert.rejects(() => P.migrar());
  assert.strictEqual("presets" in dados, true, "não pode remover presets se falhou");
  await P.migrar(); // segunda tentativa, agora sem erro
  assert.strictEqual((await P.listar()).length, 2, "não pode duplicar o que já tinha entrado");
  assert.strictEqual(dados.presetsVersao, 3);
});

teste("re-migrar com os presets antigos ainda presentes não duplica (id determinístico)", async () => {
  reset(ANTIGO);
  await P.migrar();
  // Simula uma migração que gravou os presets mas morreu antes de marcar a
  // versão e limpar a chave antiga. O id derivado do nome é o que faz a
  // segunda passada SOBRESCREVER em vez de duplicar.
  dados.presetsVersao = 0;
  dados.presets = clonar(ANTIGO.presets);
  await P.migrar();
  assert.strictEqual((await P.listar()).length, 2, "re-migrar não pode duplicar");
});

teste("re-migrar nao sobrescreve preset que o usuario ja editou", async () => {
  reset(ANTIGO);
  await P.migrar();

  // Usuario edita o texto de um preset ja migrado.
  const lista = await P.listar();
  const alvo = lista.find((p) => p.nome === "Bom dia");
  await P.salvar({ ...alvo, texto: "TEXTO EDITADO PELO USUARIO" });

  // O sync reentrega a chave antiga (ou o remove anterior falhou).
  dados.presets = clonar(ANTIGO.presets);
  await P.migrar();

  const depois = await P.listar();
  assert.strictEqual(depois.length, 2, "nao pode duplicar");
  assert.strictEqual(
    depois.find((p) => p.nome === "Bom dia").texto,
    "TEXTO EDITADO PELO USUARIO",
    "a edicao do usuario nao pode ser sobrescrita pela re-migracao"
  );
});

teste("migrar em instalação limpa não cria nada", async () => {
  reset({ enabled: true });
  await P.migrar();
  assert.strictEqual(dados.presetsVersao, 3);
  assert.strictEqual((await P.listar()).length, 0);
});

teste("sync atrasado: presets que chegam DEPOIS da versao marcada ainda migram", async () => {
  // Maquina nova: migrar roda com o store vazio e marca a versao.
  reset({ enabled: true });
  await P.migrar();
  assert.strictEqual(dados.presetsVersao, 3);
  assert.strictEqual((await P.listar()).length, 0);

  // O chrome.storage.sync entrega a chave antiga so agora.
  dados.presets = clonar(ANTIGO.presets);
  await P.migrar();

  const lista = await P.listar();
  assert.deepStrictEqual(lista.map((p) => p.nome), ["Bom dia", "Emissão de nota"]);
  assert.strictEqual("presets" in dados, false, "a chave antiga deve ser limpa na segunda passada");
});

teste("preset v2 que chega pelo sync DEPOIS da versao 3 ainda ganha sistema", async () => {
  // Máquina nova: migra com o storage vazio e marca a versão 3.
  reset({ enabled: true });
  await P.migrar();
  assert.strictEqual(dados.presetsVersao, 3);

  // O sync entrega agora um preset de outra máquina, no formato v2:
  // tem servico e não tem sistema.
  dados["preset:z"] = { id: "z", nome: "Z", servico: "Administrativo", texto: "x" };
  await P.migrar();

  const lista = await P.listar();
  assert.strictEqual(lista[0].sistema, "DataSys", "a guarda de versão não pode impedir a cura");
});

teste("migrar nao colide ids de nomes que diferem so por espaco no fim", async () => {
  reset({
    presets: {
      "Nota": { resumo: "primeiro", comando: "n1" },
      "Nota ": { resumo: "segundo", comando: "n2" },
    },
  });
  await P.migrar();
  const lista = await P.listar();
  assert.strictEqual(lista.length, 2, "os dois presets tem que sobreviver");
  assert.deepStrictEqual(lista.map((p) => p.texto).sort(), ["primeiro", "segundo"]);
});

// ---------- backup: exportação ----------
teste("montarExportacao devolve o envelope com formato, versao e presets", () => {
  const env = P.montarExportacao([{ id: "a", nome: "A", texto: "x" }]);
  assert.strictEqual(env.formato, "auto-movidesk-presets");
  assert.strictEqual(env.versao, 1);
  assert.strictEqual(env.presets.length, 1);
  assert.ok(env.exportadoEm, "exportadoEm precisa estar preenchido");
  assert.ok(!Number.isNaN(Date.parse(env.exportadoEm)), "exportadoEm precisa ser data ISO");
});

teste("montarExportacao normaliza os presets pelo completar", () => {
  const env = P.montarExportacao([{ id: " a ", nome: " A ", texto: "x" }]);
  assert.strictEqual(env.presets[0].id, "a");
  assert.strictEqual(env.presets[0].nome, "A");
  assert.strictEqual(env.presets[0].sistema, "", "campo ausente vira string vazia");
});

// ---------- backup: recusa de arquivo ----------
teste("planejarImportacao recusa JSON invalido", () => {
  const r = P.planejarImportacao("{isso nao e json", []);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /json|arquivo/i);
});

teste("planejarImportacao recusa formato desconhecido", () => {
  const r = P.planejarImportacao(JSON.stringify({ formato: "outra-coisa", versao: 1, presets: [] }), []);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /formato/i);
});

teste("planejarImportacao recusa versao desconhecida", () => {
  const r = P.planejarImportacao(JSON.stringify({ formato: "auto-movidesk-presets", versao: 99, presets: [] }), []);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /vers/i);
});

teste("planejarImportacao recusa presets que nao e array", () => {
  const r = P.planejarImportacao(JSON.stringify({ formato: "auto-movidesk-presets", versao: 1, presets: {} }), []);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /presets/i);
});

// ---------- backup: mesclagem ----------
function envelope(presets) {
  return JSON.stringify({
    formato: "auto-movidesk-presets",
    versao: 1,
    exportadoEm: "2026-09-23T14:32:00.000Z",
    presets,
  });
}

teste("planejarImportacao conta novos, substituem e identicos", () => {
  const atuais = [
    P.completar({ id: "igual", nome: "Igual", texto: "mesmo" }),
    P.completar({ id: "muda", nome: "Muda", texto: "antigo" }),
  ];
  const r = P.planejarImportacao(envelope([
    { id: "igual", nome: "Igual", texto: "mesmo" },
    { id: "muda", nome: "Muda", texto: "novo" },
    { id: "extra", nome: "Extra", texto: "n" },
  ]), atuais);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plano.identicos, 1);
  assert.strictEqual(r.plano.substituem, 1);
  assert.strictEqual(r.plano.novos, 1);
  assert.strictEqual(r.plano.exportadoEm, "2026-09-23T14:32:00.000Z");
  assert.strictEqual(r.presets.length, 2, "identico nao entra na lista a gravar");
});

teste("preset ausente do arquivo sobrevive", () => {
  const atuais = [P.completar({ id: "so-no-navegador", nome: "Meu", texto: "x" })];
  const r = P.planejarImportacao(envelope([{ id: "outro", nome: "Outro", texto: "y" }]), atuais);
  assert.strictEqual(r.ok, true);
  const ids = r.presets.map((p) => p.id);
  assert.strictEqual(ids.indexOf("so-no-navegador"), -1,
    "nao pode aparecer na lista a gravar, e tambem nao pode ser apagado: a importacao so grava");
  assert.strictEqual(r.plano.novos, 1);
});

teste("exportar e reimportar e no-op", () => {
  const atuais = [
    P.completar({ id: "a", nome: "A", comando: "aa", texto: "x", sistema: "Assist", servico: "SAC" }),
    P.completar({ id: "b", nome: "B", texto: "y" }),
  ];
  const env = P.montarExportacao(atuais);
  const r = P.planejarImportacao(JSON.stringify(env), atuais);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plano.identicos, 2);
  assert.strictEqual(r.plano.novos, 0);
  assert.strictEqual(r.plano.substituem, 0);
  assert.strictEqual(r.presets.length, 0, "nada a gravar");
});

// ---------- backup: conflitos e inválidos ----------
teste("comando repetido com preset existente entra sem comando", () => {
  const atuais = [P.completar({ id: "dono", nome: "Emissão de nota", comando: "eemi", texto: "x" })];
  const r = P.planejarImportacao(envelope([{ id: "novo", nome: "SAC", comando: "eemi", texto: "y" }]), atuais);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.presets[0].comando, "", "o comando tem que ser limpo");
  assert.strictEqual(r.presets[0].nome, "SAC", "o preset entra inteiro");
  assert.strictEqual(r.plano.semComando.length, 1);
  assert.strictEqual(r.plano.semComando[0].comando, "eemi");
  assert.strictEqual(r.plano.semComando[0].donoDoComando, "Emissão de nota");
});

teste("comando repetido dentro do arquivo: o segundo perde", () => {
  const r = P.planejarImportacao(envelope([
    { id: "um", nome: "Um", comando: "zz", texto: "a" },
    { id: "dois", nome: "Dois", comando: "zz", texto: "b" },
  ]), []);
  assert.strictEqual(r.ok, true);
  const um = r.presets.find((p) => p.id === "um");
  const dois = r.presets.find((p) => p.id === "dois");
  assert.strictEqual(um.comando, "zz", "o primeiro mantem");
  assert.strictEqual(dois.comando, "", "o segundo perde");
  assert.strictEqual(r.plano.semComando.length, 1);
  assert.strictEqual(r.plano.semComando[0].donoDoComando, "Um");
});

teste("comando liberado por quem o tinha pode ser assumido por outro preset", () => {
  const atuais = [P.completar({ id: "um", nome: "Um", comando: "aa", texto: "x" })];
  const r = P.planejarImportacao(envelope([
    { id: "um", nome: "Um", comando: "cc", texto: "x" },   // solta o "aa"
    { id: "tres", nome: "Tres", comando: "aa", texto: "z" }, // assume o "aa"
  ]), atuais);
  assert.strictEqual(r.ok, true);
  const tres = r.presets.find((p) => p.id === "tres");
  assert.strictEqual(tres.comando, "aa", "o comando foi liberado, nao pode dar conflito");
  assert.strictEqual(r.plano.semComando.length, 0);
});

teste("preset incompleto e ignorado e contado", () => {
  const r = P.planejarImportacao(envelope([
    { id: "bom", nome: "Bom", texto: "x" },
    { id: "ruim", nome: "", texto: "y" },
    { id: "vazio", nome: "Vazio" },
  ]), []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.presets.length, 1, "so o valido entra");
  assert.strictEqual(r.plano.ignorados.length, 2);
  assert.ok(r.plano.ignorados[0].motivo, "cada ignorado precisa de motivo");
});

teste("id repetido no arquivo: vence o ultimo, e o caso e registrado", () => {
  const r = P.planejarImportacao(envelope([
    { id: "x", nome: "Primeiro", texto: "a" },
    { id: "x", nome: "Segundo", texto: "b" },
  ]), []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.presets.length, 1);
  assert.strictEqual(r.presets[0].nome, "Segundo");
  assert.strictEqual(r.plano.ignorados.length, 1, "a ocorrencia descartada tem que aparecer");
});

// ---------- backup: gravação ----------
teste("aplicarImportacao grava e conta, e uma falha nao derruba as outras", async () => {
  reset();
  const r = await P.aplicarImportacao([
    P.completar({ id: "a", nome: "A", texto: "x" }),
    P.completar({ id: "b", nome: "B", texto: "y" }),
  ]);
  assert.strictEqual(r.gravados, 2);
  assert.strictEqual(r.falhas.length, 0);
  assert.strictEqual((await P.listar()).length, 2);

  reset();
  erroNoSet = "quota exceeded";
  const r2 = await P.aplicarImportacao([
    P.completar({ id: "a", nome: "A", texto: "x" }),
    P.completar({ id: "b", nome: "B", texto: "y" }),
  ]);
  assert.strictEqual(r2.falhas.length, 1, "a primeira falha e registrada");
  assert.strictEqual(r2.gravados, 1, "a segunda ainda entra");
  assert.strictEqual(r2.falhas[0].nome, "A");
});

// ---------- execução ----------
(async () => {
  let falhas = 0;
  for (const [nome, fn] of testes) {
    try {
      await fn();
      console.log("  ok   " + nome);
    } catch (e) {
      falhas++;
      console.log("  FALHA " + nome + "\n         " + e.message);
    }
  }
  console.log(`\n${testes.length - falhas}/${testes.length} passaram`);
  process.exit(falhas ? 1 : 0);
})();
