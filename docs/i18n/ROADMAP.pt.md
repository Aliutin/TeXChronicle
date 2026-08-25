# Roteiro

[English](../ROADMAP.md) · [简体中文](ROADMAP.zh-CN.md) · [日本語](ROADMAP.ja.md) · [한국어](ROADMAP.ko.md) · [Español](ROADMAP.es.md) · [Français](ROADMAP.fr.md) · [Deutsch](ROADMAP.de.md) · **Português**

## Já disponível: uso concorrente seguro do próprio estado do TeXChronicle

Cada sessão do Claude Code que se conecta ao servidor MCP `texchronicle` de um projeto inicia seu **próprio processo separado** (MCP via stdio = um processo filho por cliente) — então duas sessões trabalhando no mesmo artigo não compartilham nenhum estado em memória. Nada impedia que as duas competissem pelos mesmos arquivos em disco.

- **Trava entre processos** (`src/lock.ts`) — um arquivo de trava exclusiva em `.latex-preview/.lock`, adquirida por criação atômica (`O_EXCL`), com recuperação de travas obsoletas (um PID dono já morto, ou uma trava com mais de 30s, é limpa automaticamente, para que um agente que travou não bloqueie os outros para sempre).
- **O que é protegido**: `add_comment` / `resolve_comment` / `reply_to_comment` / rejeitar-e-excluir (todos os mutadores de `commentsStore.ts`) e a criação/restauração de checkpoints (`createCheckpoint`, `restoreCheckpoint`, `restoreFile`) — cada um agora executa seu ciclo completo de ler-modificar-escrever como uma única seção crítica entre processos, em vez de ler → modificar → escrever sem exclusão.
- **Escritas atômicas** — `comments.json` é escrito em um arquivo temporário e depois renomeado por cima do alvo, então uma leitura concorrente (que continua sem trava — leituras nunca precisaram bloquear) nunca vê um arquivo escrito pela metade.
- Verificado: dois processos de sistema operacional genuinamente separados martelando `add_comment` ao mesmo tempo não perdem nenhuma escrita; uma trava deixada por um processo morto é liberada em menos de 100ms em vez de esperar o timeout.

**O que isso *não* cobre**: dois agentes editando o *mesmo* arquivo `.tex` ao mesmo tempo pela ferramenta normal de edição de arquivos. Essa escrita vai direto para o disco, totalmente fora do nosso servidor MCP — nenhuma trava que adicionarmos consegue mediar isso. Se você quiser experimentar com dois agentes hoje, mantenha-os em arquivos que não se sobrepõem (um só em `intro.tex`, outro só em `related-work.tex`) até o marco abaixo ser lançado.

## Próximo marco: multi-agente de verdade (edição paralela)

Agentes reviewer, author e defender trabalhando no mesmo artigo *ao mesmo tempo*, editando o texto de fato em paralelo — não só se revezando por meio de uma trava compartilhada.

- **Direção**: isolamento por agente via worktrees/branches do git. Cada agente trabalha em seu próprio worktree, compila de forma independente; uma etapa de coordenação (revisão humana, ou um agente integrador) mescla os branches de volta ao projeto.
- **O que falta**: gerenciamento do ciclo de vida dos worktrees (criar a cada execução de agente, limpar após mesclar/abandonar), uma UX para conflitos de mesclagem (conflitos em nível de parágrafo são um problema de conteúdo, não só do git — como apresentá-los precisa de reflexão), provavelmente uma pré-visualização de PDF por branch ou uma etapa de "mesclar e depois recompilar", e novas ferramentas/comandos MCP para iniciar e acompanhar execuções paralelas de agentes.
- **Ainda não começado.** A trava acima é uma rede de segurança real independentemente desse marco sair do papel — é ela que torna seguro, desde já, "alguém deixou uma segunda sessão do Claude Code aberta neste projeto", em vez de uma armadilha silenciosa de perda de dados.
