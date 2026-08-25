# El bucle del agente — los comentarios como disparadores

[English](../AGENT-LOOP.md) · [简体中文](AGENT-LOOP.zh-CN.md) · [日本語](AGENT-LOOP.ja.md) · [한국어](AGENT-LOOP.ko.md) · **Español** · [Français](AGENT-LOOP.fr.md) · [Deutsch](AGENT-LOOP.de.md) · [Português](AGENT-LOOP.pt.md)

El espacio de trabajo convierte un **comentario en el PDF** en una **tarea para Claude**. Tú señalas el documento; Claude trabaja sobre la fuente. Esta página muestra cómo ejecutar eso como un bucle, para que Claude siga atendiendo comentarios a medida que los dejas — el primer paso hacia un artículo que avanza solo mientras tú miras el historial.

## El flujo de una pasada (manual)

1. En el espacio de trabajo, selecciona texto en el PDF renderizado y deja un comentario
   (p. ej. *«aprieta este párrafo»*, *«esta afirmación necesita una cita»*).
2. En Claude Code, di **«address my comments»**.
3. Claude llama a `check_comments` y obtiene cada comentario aceptado como una **tarea localizada**:

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

4. Para cada elemento, Claude abre la fuente en ese `archivo:línea`, hace la edición y llama a
   `resolve_comment(id, note)`. Guardar dispara automáticamente una recompilación y un checkpoint
   de git, así que el PDF se refresca y el cambio se puede ver como diff en **History**.
5. Cada tarjeta pasa a **resuelta ✓** con la nota de Claude. Nada que tengas que repetir.

## Ejecutarlo como un bucle (sin manos)

Usa el `/loop` de Claude Code para vigilar la bandeja de comentarios. En tu proyecto:

```
/loop 60s Address my PDF comments: call check_comments; for each accepted item, edit the
source at its location per the instruction and call resolve_comment with a one-line note.
If there are no accepted comments, do nothing this pass.
```

- Cada ~60s Claude busca comentarios nuevos y los despacha. Deja un comentario, vete, y vuelve a
  una tarjeta resuelta y un diff de checkpoint.
- Que `check_comments` devuelva «No accepted comments» es un no-op limpio, así que las pasadas
  ociosas son baratas.
- Detén el bucle cuando quieras; todo lo que hizo está en tu historial de git.

## Por qué basta con vigilarlo, sin hacer de niñera

- **Trazable** — cada pasada deja un checkpoint que puedes abrir en History y una nota de
  resolución en la tarjeta, así que siempre ves *qué* cambió y *por qué*.
- **Reversible** — los checkpoints viven en una ref oculta de git; tu propio `git log` y tu árbol
  de trabajo no se tocan nunca. Revierte cualquier cambio de la forma habitual.
- **Acotado** — Claude solo edita donde apunta un comentario; una bandeja vacía significa cero ediciones.

## El flujo revisor → visto bueno humano → resolutor

La bandeja de comentarios tiene tres estados, que encadenan un ciclo de revisión completo:

`suggested` → (el humano acepta) → `accepted` → (bucle autor) → `resolved`

1. **El revisor publica comentarios.** Apunta a Claude a tu skill de revisión y deja que marque el
   artículo — por cada problema llama a `add_comment(quote, comment)`, que aterriza como una
   **sugerencia** (resaltado morado discontinuo en el PDF, una tarjeta en la sección *Suggested*):

   ```
   Review my paper using my installed academic-review skill.
   For each issue, call add_comment
   with the exact quoted passage and your comment. Don't edit the source yet.
   ```

2. **El humano da el visto bueno.** En la sección *Suggested* das **Accept** a los que compartes
   (se convierten en `accepted`, accionables), **Reject** al resto, o editas/añades los tuyos.
   `check_comments` ignora deliberadamente los `suggested` — el autor nunca actúa sobre una
   sugerencia que no has aceptado.

   - ¿Prefieres no intervenir? Activa **Auto-accept reviewer suggestions (copilot)** arriba del
     panel de Comentarios y cada sugerencia se acepta en cuanto llega. (Los agentes totalmente
     autónomos también pueden publicar comentarios directamente accionables con
     `add_comment(..., accepted: true)`.)

3. **El bucle autor resuelve.** Ejecuta el bucle de arriba — recoge los comentarios `accepted`,
   edita en cada `archivo:línea` localizado, recompila y resuelve cada uno con una nota.

4. **Todo queda registrado.** Cada aceptación, edición y resolución deja un checkpoint y una nota,
   así que toda la ronda revisor→autor es trazable en **History**.

## Ultra-agents ⚡

> [!CAUTION]
> Este es el comando más potente de TeXChronicle, y el menos supervisado — sin aprobación tuya entre
> rondas, por diseño. Lee esta sección entera antes de ejecutarlo con un `depth` alto.

`/ultra-agents [skill] [depth]` elimina por completo el visto bueno humano del paso 2 — el revisor
publica cada comentario con `add_comment(..., accepted: true)`, así que es accionable en el instante
en que se plantea, y el autor lo resuelve justo después. Luego repite: revisar de nuevo el artículo
*ya editado*, arreglar de nuevo, hasta `depth` rondas (por defecto **2**), parando en el momento en
que una ronda no plantee nada nuevo — un artículo que ya convergió no quema el resto de la cuenta.

Es la forma más rápida de mover un borrador, y la menos supervisada — no hay punto de control por
ronda para *ti*, solo para la herramienta. Si pides un depth mayor que 5 se detiene para que
confirmes primero, porque es mucha edición sin supervisión como para aceptarla a la ligera. Sea cual
sea el depth que elijas, se ejecuta así:

```
/ultra-agents academic-paper-revision 3
```

Cuando termina (por alcanzar el depth o por converger antes) llama a `list_checkpoints` y te da un
**resumen agrupado por ronda** — qué se planteó, qué cambió, y el sha del checkpoint de cada ronda,
para que `/show_diff <sha>` te lleve directo a cualquiera de ellas en vez de rebuscar en History.
La red de seguridad es la misma que en todo lo demás: cada ronda sigue siendo un checkpoint
ordinario, revisable y reversible (la ronda entera o por archivo) desde la pestaña History. Eso hace
recuperable el *daño*, no el *tiempo* — nada vigila una ronda que se torció salvo tú leyendo el
resumen, así que úsalo en borradores que estés dispuesto a revisar después, no en la versión que
sale por la puerta sin tocar.

Esto sigue siendo un revisor + un autor con un humano en medio. Varias sesiones de Claude Code ya
pueden trabajar el mismo proyecto a la vez sin corromper comentarios ni checkpoints (cada mutación
corre bajo un bloqueo entre procesos — ver [`ROADMAP.es.md`](ROADMAP.es.md)), pero siguen turnándose
en vez de editar realmente en paralelo. El multi-agente concurrente de verdad (revisor / autor /
defensor en sus propias ramas de git, con turnos coordinados) es el próximo hito — ver
[`ROADMAP.es.md`](ROADMAP.es.md).
