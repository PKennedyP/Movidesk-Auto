# Auto Movidesk

Extensão de Chrome (Manifest V3) que automatiza o fechamento de tickets no
Movidesk da CSJ e expande texto por comando digitado, no estilo do Text Blaze.

Funciona apenas em `https://csjgroup.movidesk.com/*`.

## O que faz

1. **Enquete de IA e status.** Ao abrir um ticket, marca "Não" nas perguntas
   "Apoio com IA?" e "IA foi Efetiva?" e resolve o status. Só age em pergunta
   ainda sem resposta — nunca sobrescreve uma resposta já marcada, sua ou de um
   ticket já salvo.
2. **Expansão de texto.** Digite o comando de um preset (ex.: `eemi`) em
   qualquer campo do Movidesk — ação pública, chat, e-mail — e o texto do
   preset é colado onde o cursor estiver.
3. **Preenchimento de campos.** Um preset pode carregar assunto, serviço,
   categoria e urgência. O comando preenche tudo junto com o texto; o botão
   "Preencher ticket" no popup preenche só os campos.

## Instalar

1. Baixe ou clone este repositório numa pasta fixa. **Não apague a pasta
   depois** — o Chrome carrega a extensão direto dela.
2. Acesse `chrome://extensions` e ative o "Modo do desenvolvedor".
3. Clique em "Carregar sem compactação" e selecione a pasta do repositório
   (a que tem o `manifest.json`).
4. Abra um ticket no Movidesk: os dois "Não" ganham um brilho verde rápido ao
   serem marcados.

Depois de editar qualquer arquivo, clique em **Atualizar** (↻) no card da
extensão em `chrome://extensions`.

## Usar

**Popup** (clique no ícone) — consultar e usar. Busque por nome, comando ou
trecho do texto, veja o texto completo no painel da direita, e clique em
"Preencher ticket" para jogar os campos do preset no ticket aberto. É somente
leitura de propósito: para editar, ele leva você ao dashboard.

**Dashboard** (`Dashboard ›` no popup, abre em aba própria) — criar, editar,
duplicar e excluir presets. Excluir abre uma janela de 6 segundos com
"Desfazer". As configurações ficam no botão **Configurações**:

- **Extensão ativa** — desliga a marcação automática. Efeito imediato, sem
  recarregar a página. Desligar não desmarca o que já foi marcado.
- **Exigir delimitador** — o comando só dispara após espaço ou pontuação, o
  que evita expansão acidental no meio de uma palavra.
- **Backup dos presets** — **Exportar** baixa um `.json` com todos os presets;
  **Importar** lê esse arquivo de volta. A importação mostra um resumo antes de
  gravar e **nunca apaga**: preset que existe só no navegador e não está no
  arquivo permanece. Comando repetido entra sem o comando, e o resumo diz de
  quem ele era.

## Arquitetura

Scripts clássicos, sem bundler e sem dependências. Nada de `import`/`export`:
os arquivos conversam por um global.

| Arquivo | Responsabilidade |
|---|---|
| `content.js` | Tudo que toca o DOM do Movidesk: enquete, status, e o preenchimento de serviço / categoria / urgência / assunto. |
| `expansor.js` | Motor de expansão de texto. Genérico — não sabe nada de Movidesk. |
| `presets.js` | Camada de dados dos presets: migração, CRUD, validação, ordenação, busca. Sem DOM. |
| `presets.test.js` | Autoteste de `presets.js`. Roda com `node presets.test.js`, sem framework. |
| `popup.html` / `popup.js` | O popup: busca, lista, preview, preencher. |
| `dashboard.html` / `dashboard.js` | O dashboard: lista e editor de presets, configurações. |
| `ui.css` | Folha compartilhada pelas duas telas. |

Os presets ficam no `chrome.storage.sync`, uma chave `preset:<id>` por preset.

### Antes de mexer no `content.js`

Duas coisas no `content.js` parecem arbitrárias e não são:

- **`TIMING_APOS_SERVICO_MS` e `TIMING_ENTRE_SELECT2_MS`, ambos 600ms.** Foram
  medidos ao vivo: ao selecionar uma categoria, o Movidesk deixa o campo de
  urgência com `select2-container-disabled` por cerca de 388ms. Valores
  menores fazem a urgência falhar de forma intermitente — o sintoma é
  "funciona na segunda tentativa".
- **`acharVisivel` usa só `offsetParent !== null`.** O Movidesk mantém várias
  abas de ticket no mesmo DOM, todas com os mesmos seletores. Sem esse filtro
  a extensão clica na cópia de uma aba oculta.
- **`acharLiPai` identifica o nó-pai pela seta de expandir, não pela classe
  `.notSelectable`.** Seis dos 19 sistemas (Autua, Cadastro de Declaração de
  Grande Gerador, Gaia, Scripts CSJ, Sistema TRS, Unipark) não têm essa
  classe. Medido em 2026-09-22; com a classe no filtro, os presets desses
  sistemas falhavam com "não encontrado na árvore".

A busca do serviço é escopada ao nó-pai de propósito, e o pai vem do campo
`sistema` do preset. Onze nomes de serviço existem em mais de um sistema —
"Integrações" aparece em seis deles, "Administrativo" em três — então uma busca
global pelo nome do serviço clicaria no errado. É por isso que o preset guarda
o par sistema + serviço, e não só o serviço.

## Ajustes comuns

- **Árvore de serviço, categoria e urgência:** objeto `OPCOES` no topo do
  `dashboard.js`. `OPCOES.sistemas` é a árvore `sistema → serviços` (19
  sistemas, 105 serviços); `categoria` e `urgencia` são listas planas e valem
  para todos os sistemas. São listas fixas, por decisão de projeto — não
  capturamos as opções da página. Os nomes precisam ser **exatos**, porque o
  `content.js` casa a opção pelo texto normalizado, não por id. Os sistemas
  Omni e SKY - Conferência Detalhada ainda não foram capturados.
- **Perguntas da enquete:** lista `PERGUNTAS` no topo do `content.js`, em
  minúsculas e sem acentos.
- **Outro subdomínio:** `matches` no `manifest.json`.

## Testes

```bash
node presets.test.js
```

53 casos, sem dependência nenhuma — monta um `chrome.storage.sync` falso em
memória. As telas não têm teste automatizado; mudança de UI se verifica no
Chrome.
