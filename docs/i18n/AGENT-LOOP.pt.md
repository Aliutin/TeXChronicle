# O laço do agente — comentários como gatilhos

[English](../AGENT-LOOP.md) · [简体中文](AGENT-LOOP.zh-CN.md) · [日本語](AGENT-LOOP.ja.md) · [한국어](AGENT-LOOP.ko.md) · [Español](AGENT-LOOP.es.md) · [Français](AGENT-LOOP.fr.md) · [Deutsch](AGENT-LOOP.de.md) · **Português**

O espaço de trabalho transforma um **comentário no PDF** em uma **tarefa para o Claude**. Você aponta para o documento; o Claude trabalha na fonte. Esta página mostra como rodar isso em laço, para que o Claude continue atendendo aos comentários conforme você os deixa — o primeiro passo rumo a um artigo que avança sozinho enquanto você observa o histórico.

## O fluxo de uma passada (manual)

1. No espaço de trabalho, selecione texto no PDF renderizado e deixe um comentário
   (ex.: *"aperte este parágrafo"*, *"esta afirmação precisa de citação"*).
2. No Claude Code, diga **"address my comments"**.
3. O Claude chama `check_comments` e recebe cada comentário aceito como uma **tarefa localizada**:

   ```
   2 accepted comments — edit each at its source location per the instruction,
   then call resolve_comment with its id and a one-line note:

   [id: a1b2c3] p.1 — "the largest of twelve predefined contrasts is 7.2 percentage points"
     ↳ source: main.tex:37
     → State the exact p-value here.

   [id: d4e5f6] p.2 — "Judges deployed across languages should be audited"
     ↳ source: main.tex:44
     → Soften this to a recommendation, not a mandate.
   ```

4. Para cada item, o Claude abre a fonte naquele `arquivo:linha`, faz a edição e chama
   `resolve_comment(id, note)`. Salvar dispara automaticamente uma recompilação e um checkpoint do
   git, então o PDF é atualizado e a mudança fica visível como diff em **History**.
5. Cada cartão passa para **resolvido ✓** com a nota do Claude. Nada que você precise repetir.

## Rodando em laço (sem intervenção)

Use o `/loop` do Claude Code para vigiar a caixa de comentários. No seu projeto:

```
/loop 60s Address my PDF comments: call check_comments; for each accepted item, edit the
source at its location per the instruction and call resolve_comment with a one-line note.
If there are no accepted comments, do nothing this pass.
```

- A cada ~60s o Claude procura comentários novos e os resolve. Deixe um comentário, saia, e volte
  para um cartão resolvido e um diff de checkpoint.
- `check_comments` retornar "No accepted comments" é um no-op limpo, então passadas ociosas são baratas.
- Pare o laço quando quiser; tudo o que ele fez está no seu histórico do git.

## Por que dá para acompanhar sem ficar babá

- **Rastreável** — cada passada deixa um checkpoint que você pode abrir em History e uma nota de
  resolução no cartão, então você sempre vê *o que* mudou e *por quê*.
- **Reversível** — checkpoints ficam em uma ref oculta do git; seu próprio `git log` e sua árvore de
  trabalho nunca são tocados. Reverta qualquer mudança do jeito normal.
- **Delimitado** — o Claude só edita onde um comentário aponta; caixa vazia significa zero edições.

## O fluxo revisor → aval humano → resolvedor

A caixa de comentários tem três estados, que encadeiam um ciclo de revisão inteiro:

`suggested` → (humano aceita) → `accepted` → (laço autor) → `resolved`

1. **Revisor publica comentários.** Aponte o Claude para sua skill de revisão e deixe-o marcar o
   artigo — para cada problema ele chama `add_comment(quote, comment)`, que aterrissa como uma
   **sugestão** (destaque roxo tracejado no PDF, um cartão na seção *Suggested*):

   ```
   Review my paper using my installed academic-review skill.
   For each issue, call add_comment
   with the exact quoted passage and your comment. Don't edit the source yet.
   ```

2. **Humano dá o aval.** Na seção *Suggested* você dá **Accept** nos que concorda (viram `accepted`,
   acionáveis), **Reject** no resto, ou edita/adiciona os seus. `check_comments` ignora de propósito
   os itens `suggested` — o autor nunca age sobre uma sugestão que você não aceitou.

   - Prefere não intervir? Ative **Auto-accept reviewer suggestions (copilot)** no topo do painel de
     Comentários e cada sugestão é aceita assim que chega. (Agentes totalmente autônomos também podem
     publicar comentários diretamente acionáveis com `add_comment(..., accepted: true)`.)

3. **Laço autor resolve.** Rode o laço acima — ele pega os comentários `accepted`, edita em cada
   `arquivo:linha` localizado, recompila e resolve cada um com uma nota.

4. **Tudo fica registrado.** Cada aceite, edição e resolução deixa um checkpoint mais uma nota, então
   toda a rodada revisor→autor é rastreável em **History**.

## Ultra-agents ⚡

> [!CAUTION]
> Este é o comando mais poderoso do TeXChronicle e o menos supervisionado — sem aprovação sua entre as
> rodadas, por design. Leia esta seção inteira antes de executá-lo com um `depth` alto.

`/ultra-agents [skill] [depth]` remove por completo o aval humano do passo 2 — o revisor publica cada
comentário com `add_comment(..., accepted: true)`, então ele é acionável no instante em que é
levantado, e o autor o resolve logo em seguida. Depois repete: revisar de novo o artigo *recém-editado*,
corrigir de novo, até `depth` rodadas (padrão **2**), parando no momento em que uma rodada não
levantar nada novo — um artigo que já convergiu não queima o resto da contagem.

É a forma mais rápida de fazer um rascunho avançar, e a menos supervisionada — não há ponto de
verificação por rodada para *você*, só para a ferramenta. Peça um depth acima de 5 e ele para para
você confirmar antes, porque é muita edição sem supervisão para se comprometer levianamente. Qualquer
que seja o depth escolhido, roda assim:

```
/ultra-agents academic-paper-revision 3
```

Quando termina (por atingir o depth ou por convergir antes), chama `list_checkpoints` e te dá um
**resumo agrupado por rodada** — o que foi levantado, o que mudou, e o sha do checkpoint de cada
rodada, para que `/show_diff <sha>` leve direto a qualquer uma em vez de você garimpar o History. A
rede de segurança é a mesma de todo o resto aqui: cada rodada continua sendo um checkpoint comum,
revisável e reversível (rodada inteira ou por arquivo) pela aba History. Isso torna o *dano*
recuperável, não o *tempo* — nada vigia uma rodada que saiu do trilho além de você lendo o resumo.
Então use em rascunhos que você está disposto a revisar depois, não na versão que sai pela porta sem
ser tocada.

Isso ainda é um revisor + um autor com um humano no meio. Várias sessões do Claude Code já podem
trabalhar no mesmo projeto simultaneamente sem corromper comentários ou checkpoints (cada alteração
roda sob uma trava entre processos — veja [`ROADMAP.pt.md`](ROADMAP.pt.md)), mas elas ainda se
revezam em vez de realmente editar em paralelo. Multi-agente concorrente de verdade (revisor / autor /
defensor em seus próprios branches do git, com turnos coordenados) é o próximo marco — veja
[`ROADMAP.pt.md`](ROADMAP.pt.md).
