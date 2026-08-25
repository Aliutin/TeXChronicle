# TeXChronicle — Guía de usuario

[English](../USER-GUIDE.md) · [简体中文](USER-GUIDE.zh-CN.md) · [日本語](USER-GUIDE.ja.md) · [한국어](USER-GUIDE.ko.md) · **Español** · [Français](USER-GUIDE.fr.md) · [Deutsch](USER-GUIDE.de.md) · [Português](USER-GUIDE.pt.md)

![El espacio de trabajo de TeXChronicle](../images/workspace.png)

## Uso diario

1. Añade el servidor al `.mcp.json` de tu proyecto (ver el README) y reinicia Claude Code.
   O instala el plugin para los comandos de barra (abajo).
2. Pídele a Claude *«render a preview»* (o ejecuta `/texchronicle`). Se abre el **espacio de
   trabajo**: **árbol de archivos + editor de código** a la izquierda, el **PDF en vivo** en el
   centro y **Comments** a la derecha (se alterna con el botón 💬 **Comments** de la barra superior).
3. A partir de ahí el PDF se mantiene en vivo. Los guardados de tu propio editor y las ediciones de
   Claude recompilan automáticamente; en el editor integrado pulsas **Ctrl+S** / **Recompile** para
   reconstruir (guarda tu trabajo cada 30s sin recompilar).

## Comandos de barra (plugin)

Instala una vez — `/plugin marketplace add Aliutin/TeXChronicle` y luego
`/plugin install texchronicle` — y manéjalo escribiendo lo mínimo:

- **`/texchronicle`** — compila y abre el espacio de trabajo.
- **`/ai-review [skill]`** — revisa el artículo con una skill (por defecto `academic-paper-revision`;
  vale cualquier nombre) y publica comentarios para que los aceptes.
- **`/address-comments`** — resuelve tus comentarios aceptados (en bucle: `/loop 60s /address-comments`).
- ⚡ **`/ultra-agents [skill] [depth]`** — totalmente autónomo: revisa, acepta automáticamente,
  corrige y repite, hasta `depth` rondas (2 por defecto), parando antes si una ronda no encuentra
  nada nuevo. Sin aprobación entre rondas — ese es el punto, y el riesgo. Ver
  [`AGENT-LOOP.es.md`](AGENT-LOOP.es.md#ultra-agents-).

### Un comando por herramienta

Cada herramienta MCP tiene además un comando con el **mismo nombre**, así que cualquier paso está a
un comando de distancia. La regla para enseñar: *la herramienta es `X` → escribe `/X`*.

| Escribe esto | Ejecuta la herramienta | Qué hace |
| --- | --- | --- |
| `/render_preview` | `render_preview` | Compila el artículo y abre/actualiza la vista previa en vivo. |
| `/check_comments` | `check_comments` | Lista los comentarios que aceptaste como instrucciones (sin editar aún). |
| `/resolve_comment [id] [nota]` | `resolve_comment` | Marca un comentario como hecho tras la edición; se pone **verde** para tu revisión. |
| `/add_comment ["cita"] [nota]` | `add_comment` | Ancla un comentario en un pasaje para que lo aceptes/rechaces. |
| `/reply_to_comment [id] [texto]` | `reply_to_comment` | Añade una respuesta en el hilo de un comentario. |
| `/show_diff [checkpoint]` | `show_diff` | Diff visual en paralelo como imagen (cambios actuales o un checkpoint). |
| `/list_checkpoints [limit]` | `list_checkpoints` | Checkpoints recientes con su sha — para pasarle uno a `/show_diff`. |

Nunca es obligatorio escribirlos: el lenguaje natural también funciona (*«renderiza una vista
previa»*, *«atiende mis comentarios»*). Son solo un atajo rápido y fácil de enseñar.

## El bucle de comentarios (revisas en el PDF, Claude edita la fuente)

1. **Selecciona texto en el PDF renderizado** → aparece un compositor → escribe qué quieres cambiar
   («aprieta este párrafo», «esta ecuación parece mal») → **Add comment**. El pasaje recibe un
   resaltado anclado; la tarjeta aparece en el panel derecho como *accepted*.
2. En Claude Code, di *«address my comments»*. Claude llama a `check_comments` (cada comentario llega
   con su página, el pasaje citado exacto y tu instrucción), edita la fuente y llama a
   `resolve_comment` con una nota de una línea.
3. El PDF recompila, la tarjeta pasa a *resolved ✓* con la nota de Claude, y la pestaña History
   guarda el diff del checkpoint de lo que cambió.

Nunca tienes que tocar LaTeX — tú señalas el documento; Claude trabaja sobre la fuente.

## El flujo de revisión (revisor → tú das el visto bueno → el autor resuelve)

También puedes dejar que un agente *plantee* los comentarios y seguir en el bucle:

1. **Pasada del revisor.** Ejecuta `/ai-review academic-paper-revision` (o apúntalo a cualquier skill
   de revisión). El agente lee el artículo y llama a `add_comment` por cada problema — aparecen como
   tarjetas **Suggested** (resaltados morados discontinuos en el PDF), etiquetadas **reviewer** o
   **defender**.
2. **Tú validas.** En el panel de Comentarios, **Accept** en los que compartes (pasan a ser
   *accepted*, accionables), **Reject** en el resto, o añade los tuyos. ¿Prefieres no intervenir?
   Marca **Auto-accept reviewer suggestions (copilot)** y toda sugerencia se acepta automáticamente.
3. **El autor resuelve.** Ejecuta `/address-comments` (o ponlo en bucle). El autor edita cada
   comentario aceptado en su ubicación de origen y lo marca como resuelto con una nota.

Los comentarios tienen **hilo de respuestas** (tú y los agentes podéis discutir antes de resolver).
Cuando Claude resuelve uno, su resaltado se pone **verde** (la edición está hecha, esperando *tu*
revisión) y la tarjeta pasa a la lista *Resolved*. Revisar es de uno en uno: pulsa **Close** en un
comentario resuelto cuando hayas comprobado la edición y su resaltado verde desaparece — ese es el
paso de confirmación humana, así que los colores se limpian a medida que avanzas en vez de
acumularse. **clear all** los cierra en bloque.

### Por qué un resaltado puede quedar ligeramente desplazado

Los resaltados se dibujan desde la *capa de texto* invisible de pdf.js (la misma geometría que se usa
para seleccionar), que es una aproximación por línea de dónde se pintan los glifos en el canvas — así
que una caja puede quedar un pelo desviada, más visible con zoom. Ese pequeño desfase es inherente y
cosmético. Para evitar la deriva mayor que ocurría cuando Claude editaba un pasaje y el PDF se
recomponía, TeXChronicle **re-ancla cada resaltado sobre el texto actual** en cada recompilación
(emparejando las frases inicial y final de la cita del comentario) en vez de fijarlo a coordenadas
viejas — así sigue al texto aunque cambien las palabras del medio. Si un pasaje se borra o se
reescribe hasta ser irreconocible, el resaltado vuelve a su última posición conocida.

## Modo Visual (WYSIWYG)

En la barra del editor, alterna **Code / Visual**. El modo Visual renderiza el documento in situ —
`\section`/`\textbf`/`\emph`, fórmulas `$…$` y `\begin{equation}` (vía KaTeX), listas, chips de
`\cite`, enlaces — mientras atenúa el preámbulo. Haz clic en cualquier elemento para ver su LaTeX
original y editarlo. Es una capa de decoración sobre el mismo archivo, así que nunca cambia tu
fuente. **⏎ Wrap** ajusta las líneas largas (para LaTeX escrito sin saltos de línea).

## El árbol de archivos

El panel **FILES** es un árbol completo: expande carpetas, haz clic en un archivo para cambiar a él,
y usa **+ File / + Folder** o el renombrar/eliminar de cada fila. Arrastra el divisor de abajo para
redimensionar.

## El editor de código

La pestaña **Source** del panel izquierdo lista los archivos de texto del proyecto en un editor
LaTeX CodeMirror. **Ctrl+S** (o Save) escribe a disco — el watcher recompila y el PDF se refresca,
exactamente como el bucle del editor de Typst. ¿Prefieres tu propio editor? Guardar desde cualquier
sitio dispara el mismo bucle.

### Ver un diff dentro de la conversación

Pídele a Claude *«show me the diff»* (o *«show the diff of the last checkpoint»*) y usará la
herramienta `show_diff` para devolver un **diff en paralelo como imagen, ahí mismo en el chat**.
Esto existe porque Claude Code no tiene visor de diffs propio — si Claude simplemente ejecuta
`git diff`, captura el texto y lo resume. `show_diff` te da la división visual real. (Para el mismo
diff *junto al PDF renderizado*, usa el panel History del navegador; para una división en terminal,
`git diff` con [delta](https://github.com/dandavison/delta) configurado.)

## Llevar tu artículo a Overleaf

Hay tres formas, según tu configuración. La herramienta no puede empujar a Overleaf *por ti* sin tus
credenciales, así que todas te mantienen al mando.

### 1. Subir un zip limpio (funciona para todos)

Pulsa **⬆ Export .zip**. Obtienes un zip que contiene solo las entradas de compilación — `.tex`,
`.bib`, `.cls`/`.sty`/`.bst` y figuras — dejando fuera los artefactos de compilación (`.aux`, `.log`,
el PDF compilado), `.git/` y `node_modules/`. En Overleaf: **New Project → Upload Project**, suelta
el zip.

Este es el camino fiable y universal — sin vincular cuentas ni necesitar un repo público.

### 2. «Open in Overleaf» de un clic (repos públicos de GitHub)

Si tu proyecto es un repo git con un `origin` de GitHub **público**, la barra muestra
**Open in Overleaf ↗**. Al pulsarlo, Overleaf importa directamente el archivo de la rama actual de tu
repo — un proyecto nuevo, un clic. Solo funciona si el repo es público, porque son los servidores de
Overleaf los que descargan el archivo por internet.

### 3. Sincronizar con un proyecto Overleaf existente (Overleaf Premium — Git bridge)

Overleaf Premium expone cada proyecto como un remoto git. Configúralo una vez, tú mismo (tu token es
una credencial que la herramienta nunca maneja):

```bash
git remote add overleaf https://git.overleaf.com/<your-project-id>
# usa tu token git de Overleaf cuando git pida la contraseña
git push overleaf <branch>
```

A partir de ahí, publicar una actualización es solo `git push overleaf` — puedes pedirle a Claude que
lo ejecute.

## Cobertura de paquetes

El motor WASM incluye un **subconjunto** de TeX Live (basic + recommended + extra). La mayoría de los
paquetes comunes están. Algunas omisiones frecuentes se manejan automáticamente:
- la familia `algorithm`/`algorithmicx` y `multirow` — los `.sty` reales van incluidos (literales,
  LPPL) y se inyectan;
- `bbm` — un pequeño **sustituto de vista previa** aproxima `\mathbbm` (letras vía `\mathbb`, el
  indicador `\mathbbm{1}` con un 1 de doble trazo casero), para que el artículo siga renderizando.

Cualquier otra cosa fuera del subconjunto y basada en fuentes fallará con
`File '<pkg>.sty' not found`. Si te pasa, mete el `.sty` del paquete (y las fuentes) en tu proyecto,
o ajusta el preámbulo. En cualquier caso, tu compilación final en Overleaf usa los paquetes reales —
la vista previa local es una aproximación.

## Notas

- El PDF compilado es una aproximación de lo que produce Overleaf (un TeX Live actual vía WASM), no
  una coincidencia bit a bit garantizada. Es preciso para la gran mayoría de artículos; haz siempre
  una compilación final en tu destino (Overleaf o tu sistema de envío).
- El historial de cambios se guarda en una ref oculta de git (`refs/latex-preview/checkpoints`) y
  nunca toca tus ramas, tu `git log` ni tu árbol de trabajo. Si la carpeta no es un repositorio
  git, TeXChronicle guarda esa ref en un repositorio propio en `.latex-preview/history.git` dentro del
  proyecto — así el historial se mueve, se copia y se borra con la carpeta, y `git` ejecutado ahí
  sigue diciendo que no hay repositorio.
