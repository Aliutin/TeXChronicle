# Hoja de ruta

[English](../ROADMAP.md) · [简体中文](ROADMAP.zh-CN.md) · [日本語](ROADMAP.ja.md) · [한국어](ROADMAP.ko.md) · **Español** · [Français](ROADMAP.fr.md) · [Deutsch](ROADMAP.de.md) · [Português](ROADMAP.pt.md)

## Ya disponible: uso concurrente seguro del propio estado de TeXChronicle

Cada sesión de Claude Code que se conecta al servidor MCP `texchronicle` de un proyecto lanza su **propio proceso independiente** (MCP por stdio = un proceso hijo por cliente) — así que dos sesiones trabajando en el mismo artículo no comparten ningún estado en memoria. Nada impedía que ambas compitieran por los mismos archivos en disco.

- **Bloqueo entre procesos** (`src/lock.ts`) — un archivo de bloqueo exclusivo en `.latex-preview/.lock`, adquirido mediante creación atómica (`O_EXCL`), con recuperación ante bloqueos obsoletos (un PID propietario muerto o un bloqueo con más de 30s se limpia automáticamente, así un agente que se cayó no puede bloquear a los demás para siempre).
- **Qué protege**: `add_comment` / `resolve_comment` / `reply_to_comment` / rechazar-y-borrar (todos los mutadores de `commentsStore.ts`) y la creación/restauración de checkpoints (`createCheckpoint`, `restoreCheckpoint`, `restoreFile`) — cada uno ejecuta ahora su ciclo completo de leer-modificar-escribir como una sola sección crítica entre procesos, en vez de leer → modificar → escribir sin exclusión.
- **Escrituras atómicas** — `comments.json` se escribe en un archivo temporal y se renombra sobre el destino, así una lectura concurrente (que sigue sin bloquearse — las lecturas nunca necesitaron bloquear) nunca observa un archivo a medio escribir.
- Verificado: dos procesos de sistema operativo genuinamente independientes machacando `add_comment` a la vez no pierden ninguna escritura; un bloqueo dejado por un proceso muerto se libera en menos de 100ms en vez de esperar el timeout.

**Lo que esto *no* cubre**: dos agentes editando el *mismo* archivo `.tex` al mismo tiempo mediante la herramienta normal de edición de archivos. Esa escritura va directa a disco, completamente fuera de nuestro servidor MCP — ningún bloqueo que añadamos puede mediar ahí. Si quieres experimentar hoy con dos agentes, mantenlos en archivos que no se solapen (uno en `intro.tex`, otro en `related-work.tex`) hasta que salga el hito de abajo.

## Próximo hito: multi-agente real (edición paralela)

Agentes reviewer, author y defender trabajando el mismo artículo *al mismo tiempo*, editando prosa de verdad en paralelo — no solo turnándose a través de un bloqueo compartido.

- **Dirección**: aislamiento por agente mediante git worktrees/ramas. Cada agente trabaja en su propio worktree, compila de forma independiente; un paso de coordinación (revisión humana, o un agente integrador) fusiona las ramas de vuelta al proyecto.
- **Necesita**: gestión del ciclo de vida de los worktrees (crear por cada ejecución de agente, limpiar tras fusionar/abandonar), una UX para conflictos de fusión (los conflictos a nivel de párrafo son un problema de contenido, no solo de git — hay que pensar bien cómo mostrarlos), probablemente una vista previa de PDF por rama o un paso de "fusionar y luego recompilar", y nuevas herramientas/comandos MCP para lanzar y seguir ejecuciones paralelas de agentes.
- **Sin empezar.** El bloqueo de arriba es una red de seguridad real independientemente de si esto llega a salir — es lo que hace que "alguien dejó abierta una segunda sesión de Claude Code en este proyecto" sea seguro hoy en vez de una trampa silenciosa de pérdida de datos.
