# TeXChronicle — Guia do usuário

[English](../USER-GUIDE.md) · [简体中文](USER-GUIDE.zh-CN.md) · [日本語](USER-GUIDE.ja.md) · [한국어](USER-GUIDE.ko.md) · [Español](USER-GUIDE.es.md) · [Français](USER-GUIDE.fr.md) · [Deutsch](USER-GUIDE.de.md) · **Português**

![O espaço de trabalho do TeXChronicle](../images/workspace.png)

## Uso no dia a dia

1. Adicione o servidor ao `.mcp.json` do seu projeto (veja o README) e reinicie o Claude Code.
   Ou instale o plugin para os comandos de barra (abaixo).
2. Peça ao Claude *"render a preview"* (ou rode `/texchronicle`). O **espaço de trabalho** abre:
   **árvore de arquivos + editor de código** à esquerda, o **PDF ao vivo** no centro e **Comments**
   à direita (alterna com o botão 💬 **Comments** na barra superior).
3. Daí em diante o PDF fica ao vivo. Os salvamentos do seu próprio editor e as edições do Claude
   recompilam automaticamente; no editor embutido você aperta **Ctrl+S** / **Recompile** para
   reconstruir (ele salva seu trabalho a cada 30s sem recompilar).

## Comandos de barra (plugin)

Instale uma vez — `/plugin marketplace add Aliutin/TeXChronicle` e depois
`/plugin install texchronicle` — e conduza tudo digitando o mínimo:

- **`/texchronicle`** — compila e abre o espaço de trabalho.
- **`/ai-review [skill]`** — revisa o artigo com uma skill (padrão `academic-paper-revision`;
  qualquer nome serve) e publica comentários para você aceitar.
- **`/address-comments`** — resolve seus comentários aceitos (em laço: `/loop 60s /address-comments`).
- ⚡ **`/ultra-agents [skill] [depth]`** — totalmente autônomo: revisa, aceita automaticamente,
  corrige e repete, até `depth` rodadas (padrão 2), parando antes se uma rodada não achar nada novo.
  Sem aprovação entre rodadas — esse é o ponto, e o risco. Veja
  [`AGENT-LOOP.pt.md`](AGENT-LOOP.pt.md#ultra-agents-).

### Um comando por ferramenta

Cada ferramenta MCP também tem um comando com o **mesmo nome** — qualquer passo está a um comando de
distância. A regra para ensinar: *a ferramenta é `X` → digite `/X`*.

| Digite isto | Executa a ferramenta | O que faz |
| --- | --- | --- |
| `/render_preview` | `render_preview` | Compila o artigo e abre/atualiza a pré-visualização ao vivo. |
| `/check_comments` | `check_comments` | Lista os comentários que você aceitou como instruções (sem editar ainda). |
| `/resolve_comment [id] [nota]` | `resolve_comment` | Marca um comentário como feito após a edição; fica **verde** para sua revisão. |
| `/add_comment ["citação"] [nota]` | `add_comment` | Ancora um comentário num trecho para você aceitar/rejeitar. |
| `/reply_to_comment [id] [texto]` | `reply_to_comment` | Adiciona uma resposta no tópico de um comentário. |
| `/show_diff [checkpoint]` | `show_diff` | Diff visual lado a lado como imagem (mudanças atuais ou um checkpoint). |
| `/list_checkpoints [limit]` | `list_checkpoints` | Checkpoints recentes com seu sha — para passar um ao `/show_diff`. |

Você nunca precisa digitá-los: linguagem natural também funciona (*"renderize uma pré-visualização"*,
*"resolva meus comentários"*). Os comandos são só um atalho rápido e fácil de ensinar.

## O laço de comentários (você revisa no PDF, o Claude edita a fonte)

1. **Selecione texto no PDF renderizado** → aparece um compositor → escreva o que quer mudar
   ("aperte este parágrafo", "esta equação parece errada") → **Add comment**. O trecho ganha um
   destaque ancorado; o cartão aparece no painel direito como *accepted*.
2. No Claude Code, diga *"address my comments"*. O Claude chama `check_comments` (cada comentário
   chega com sua página, o trecho citado exato e sua instrução), edita a fonte e chama
   `resolve_comment` com uma nota de uma linha.
3. O PDF recompila, o cartão vira *resolved ✓* com a nota do Claude, e a aba History guarda o diff do
   checkpoint do que mudou.

Você nunca precisa tocar em LaTeX — você aponta para o documento; o Claude trabalha na fonte.

## O fluxo de revisão (revisor → você dá o aval → autor resolve)

Você também pode deixar um agente *levantar* os comentários e continuar no laço:

1. **Passada do revisor.** Rode `/ai-review academic-paper-revision` (ou aponte para qualquer skill de
   revisão). O agente lê o artigo e chama `add_comment` para cada problema — aparecem como cartões
   **Suggested** (destaques roxos tracejados no PDF), marcados como **reviewer** ou **defender**.
2. **Você dá o aval.** No painel de Comentários, **Accept** nos que concorda (viram *accepted*,
   acionáveis), **Reject** no resto, ou adicione os seus. Prefere não intervir? Marque
   **Auto-accept reviewer suggestions (copilot)** e toda sugestão é aceita automaticamente.
3. **O autor resolve.** Rode `/address-comments` (ou em laço). O autor edita cada comentário aceito na
   sua localização de origem e o marca como resolvido com uma nota.

Comentários têm **tópico de respostas** (você e os agentes podem discutir antes de resolver). Quando o
Claude resolve um, o destaque fica **verde** (a edição está feita, aguardando *sua* revisão) e o
cartão vai para a lista *Resolved*. A revisão é um a um: **Close** num comentário resolvido depois de
conferir a edição e o destaque verde some — esse é o passo de confirmação humana, então as cores vão
sendo limpas conforme você avança, em vez de se acumular. **clear all** fecha em bloco.

### Por que um destaque pode ficar levemente deslocado

Os destaques são desenhados a partir da *camada de texto* invisível do pdf.js (a mesma geometria usada
para seleção), que é uma aproximação por linha de onde os glifos são pintados no canvas — então uma
caixa pode ficar um fio de cabelo fora, mais visível com zoom. Esse pequeno deslocamento é inerente e
cosmético. Para evitar o desvio maior que acontecia depois que o Claude editava um trecho e o PDF
refluía, o TeXChronicle **reancora cada destaque no texto atual** a cada recompilação (casando as frases
inicial e final da citação do comentário) em vez de fixá-lo em coordenadas antigas — assim ele
acompanha o texto mesmo quando as palavras do meio mudaram. Se um trecho for apagado ou reescrito
além do reconhecível, o destaque volta para sua última posição conhecida.

## Modo Visual (WYSIWYG)

Na barra do editor, alterne **Code / Visual**. O modo Visual renderiza o documento no lugar —
`\section`/`\textbf`/`\emph`, matemática `$…$` e `\begin{equation}` (via KaTeX), listas, chips de
`\cite`, links — enquanto escurece o preâmbulo. Clique em qualquer elemento para revelar seu LaTeX
bruto e editá-lo. É uma camada de decoração sobre o mesmo arquivo, então nunca altera sua fonte.
**⏎ Wrap** quebra linhas longas (para LaTeX escrito sem quebras de linha).

## A árvore de arquivos

O painel **FILES** é uma árvore completa: expanda pastas, clique num arquivo para trocar, e use
**+ File / + Folder** ou o renomear/excluir de cada linha. Arraste o divisor abaixo dela para
redimensionar.

## O editor de código

A aba **Source** do painel esquerdo lista os arquivos de texto do projeto num editor LaTeX CodeMirror.
**Ctrl+S** (ou Save) grava no disco — o watcher recompila e o PDF atualiza, exatamente como o laço do
editor do Typst. Prefere seu próprio editor? Salvar de qualquer lugar dispara o mesmo laço.

### Ver um diff dentro da conversa

Peça ao Claude *"show me the diff"* (ou *"show the diff of the last checkpoint"*) e ele usa a
ferramenta `show_diff` para devolver um **diff lado a lado como imagem, ali mesmo no chat**. Isso
existe porque o Claude Code não tem visualizador de diff próprio — se o Claude simplesmente rodar
`git diff`, ele captura o texto e resume. O `show_diff` te dá a divisão visual de verdade. (Para o
mesmo diff *ao lado do PDF renderizado*, use o painel History no navegador; para uma divisão no
terminal, `git diff` com [delta](https://github.com/dandavison/delta) configurado.)

## Levando seu artigo para o Overleaf

Há três formas, dependendo do seu setup. A ferramenta não consegue empurrar para o Overleaf *por você*
sem suas credenciais, então todas mantêm você no controle.

### 1. Subir um zip limpo (funciona para todos)

Clique em **⬆ Export .zip**. Você recebe um zip contendo apenas as entradas de compilação — `.tex`,
`.bib`, `.cls`/`.sty`/`.bst` e figuras — deixando de fora artefatos de build (`.aux`, `.log`, o PDF
compilado), `.git/` e `node_modules/`. No Overleaf: **New Project → Upload Project**, solte o zip.

Esse é o caminho confiável e universal — sem vincular contas, sem precisar de repositório público.

### 2. "Open in Overleaf" em um clique (repositórios GitHub públicos)

Se seu projeto é um repositório git com um `origin` do GitHub **público**, a barra mostra
**Open in Overleaf ↗**. Clicar pede ao Overleaf para importar diretamente o arquivo do branch atual do
seu repositório — um projeto novo, um clique. Só funciona se o repositório for público, porque são os
servidores do Overleaf que buscam o arquivo pela internet.

### 3. Sincronizar com um projeto Overleaf existente (Overleaf Premium — Git bridge)

O Overleaf Premium expõe cada projeto como um remoto git. Configure uma vez, você mesmo (seu token é
uma credencial que a ferramenta nunca manipula):

```bash
git remote add overleaf https://git.overleaf.com/<your-project-id>
# use seu token git do Overleaf quando o git pedir a senha
git push overleaf <branch>
```

Depois disso, publicar uma atualização é só `git push overleaf` — você pode pedir ao Claude para rodar.

## Cobertura de pacotes

O motor WASM traz um **subconjunto** do TeX Live (basic + recommended + extra). A maioria dos pacotes
comuns está incluída. Algumas ausências frequentes são tratadas automaticamente:
- a família `algorithm`/`algorithmicx` e `multirow` — os `.sty` reais vêm embutidos (na íntegra,
  LPPL) e são injetados;
- `bbm` — um pequeno **substituto de pré-visualização** aproxima `\mathbbm` (letras via `\mathbb`, o
  indicador `\mathbbm{1}` com um 1 de traço duplo improvisado), para o artigo continuar renderizando.

Qualquer outra coisa fora do subconjunto e baseada em fontes vai falhar com
`File '<pkg>.sty' not found`. Se acontecer, coloque o `.sty` do pacote (e as fontes) no seu projeto,
ou ajuste o preâmbulo. De todo jeito, sua compilação final no Overleaf usa os pacotes reais — a
pré-visualização local é uma aproximação.

## Notas

- O PDF compilado é uma aproximação do que o Overleaf produz (um TeX Live atual via WASM), não uma
  correspondência bit a bit garantida. É preciso para a grande maioria dos artigos; sempre faça uma
  compilação final no seu destino (Overleaf ou seu sistema de submissão).
- O histórico de mudanças fica numa ref oculta do git (`refs/latex-preview/checkpoints`) e nunca toca
  seus branches, seu `git log` ou sua árvore de trabalho. Se a pasta não for um repositório git,
  o TeXChronicle guarda essa ref num repositório próprio em `.latex-preview/history.git` dentro do
  projeto — o histórico se move, se copia e é apagado junto com a pasta, e `git` rodado ali
  continua dizendo que não há repositório.
