# TeXChronicle — Guide utilisateur

[English](../USER-GUIDE.md) · [简体中文](USER-GUIDE.zh-CN.md) · [日本語](USER-GUIDE.ja.md) · [한국어](USER-GUIDE.ko.md) · [Español](USER-GUIDE.es.md) · **Français** · [Deutsch](USER-GUIDE.de.md) · [Português](USER-GUIDE.pt.md)

![L'espace de travail TeXChronicle](../images/workspace.png)

## Usage quotidien

1. Ajoutez le serveur au `.mcp.json` de votre projet (voir le README), redémarrez Claude Code.
   Ou installez le plugin pour les commandes de barre (ci-dessous).
2. Demandez à Claude *« render a preview »* (ou lancez `/texchronicle`). L'**espace de travail**
   s'ouvre : **arborescence de fichiers + éditeur de source** à gauche, le **PDF en direct** au
   centre, et **Comments** à droite (bouton 💬 **Comments** dans la barre du haut).
3. Ensuite le PDF reste en direct. Les enregistrements de votre propre éditeur et les modifications
   de Claude recompilent automatiquement ; dans l'éditeur intégré vous appuyez sur **Ctrl+S** /
   **Recompile** pour reconstruire (il enregistre votre travail toutes les 30s sans recompiler).

## Commandes de barre (plugin)

Installez une fois — `/plugin marketplace add Aliutin/TeXChronicle` puis
`/plugin install texchronicle` — et pilotez-le en tapant le minimum :

- **`/texchronicle`** — compile et ouvre l'espace de travail.
- **`/ai-review [skill]`** — relit l'article avec une skill (par défaut `academic-paper-revision` ;
  n'importe quel nom marche) et publie des commentaires à accepter.
- **`/address-comments`** — résout vos commentaires acceptés (en boucle : `/loop 60s /address-comments`).
- ⚡ **`/ultra-agents [skill] [depth]`** — entièrement autonome : relire, accepter automatiquement,
  corriger, recommencer, jusqu'à `depth` tours (2 par défaut), en s'arrêtant plus tôt dès qu'un tour
  ne trouve rien de nouveau. Aucune approbation entre les tours — c'est le principe, et le risque.
  Voir [`AGENT-LOOP.fr.md`](AGENT-LOOP.fr.md#ultra-agents-).

### Une commande par outil

Chaque outil MCP a aussi une commande du **même nom** — n'importe quelle étape est à une commande
près. La règle à enseigner : *l'outil est `X` → tapez `/X`*.

| Tapez ceci | Exécute l'outil | Ce que ça fait |
| --- | --- | --- |
| `/render_preview` | `render_preview` | Compile l'article et ouvre/rafraîchit l'aperçu en direct. |
| `/check_comments` | `check_comments` | Liste les commentaires acceptés comme instructions (sans encore éditer). |
| `/resolve_comment [id] [note]` | `resolve_comment` | Marque un commentaire fait après l'édition ; il passe au **vert** pour votre relecture. |
| `/add_comment ["citation"] [note]` | `add_comment` | Ancre un commentaire sur un passage à accepter/refuser. |
| `/reply_to_comment [id] [texte]` | `reply_to_comment` | Ajoute une réponse au fil d'un commentaire. |
| `/show_diff [checkpoint]` | `show_diff` | Diff visuel côte à côte en image (modifications actuelles ou un checkpoint). |
| `/list_checkpoints [limit]` | `list_checkpoints` | Checkpoints récents avec leur sha — pour en passer un à `/show_diff`. |

Rien ne vous oblige à les taper : le langage naturel marche aussi (*« affiche un aperçu »*,
*« traite mes commentaires »*). Ce ne sont qu'un raccourci rapide et facile à enseigner.

## La boucle de commentaires (vous relisez sur le PDF, Claude édite la source)

1. **Sélectionnez du texte sur le PDF rendu** → un compositeur apparaît → écrivez ce que vous voulez
   changer (« resserre ce paragraphe », « cette équation semble fausse ») → **Add comment**. Le
   passage reçoit un surlignage ancré ; la carte apparaît dans le panneau de droite comme *accepted*.
2. Dans Claude Code, dites *« address my comments »*. Claude appelle `check_comments` (chaque
   commentaire arrive avec sa page, le passage cité exact et votre instruction), édite la source, et
   appelle `resolve_comment` avec une note d'une ligne.
3. Le PDF recompile, la carte bascule en *resolved ✓* avec la note de Claude, et l'onglet History
   conserve le diff du checkpoint de ce qui a changé.

Vous n'avez jamais à toucher au LaTeX — vous pointez le document ; Claude travaille sur la source.

## Le flux de relecture (relecteur → vous validez → l'auteur résout)

Vous pouvez aussi laisser un agent *soulever* les commentaires, tout en restant dans la boucle :

1. **Passe du relecteur.** Lancez `/ai-review academic-paper-revision` (ou pointez-le vers n'importe
   quelle skill de relecture). L'agent lit l'article et appelle `add_comment` pour chaque problème —
   ils apparaissent comme des cartes **Suggested** (surlignages violets pointillés sur le PDF),
   étiquetées **reviewer** ou **defender**.
2. **Vous validez.** Dans le panneau Commentaires, **Accept** ceux que vous partagez (ils deviennent
   des *accepted* actionnables), **Reject** le reste, ou ajoutez les vôtres. Vous préférez ne pas
   intervenir ? Cochez **Auto-accept reviewer suggestions (copilot)** et chaque suggestion est
   acceptée automatiquement.
3. **L'auteur résout.** Lancez `/address-comments` (ou mettez-le en boucle). L'auteur édite chaque
   commentaire accepté à son emplacement source et le marque résolu avec une note.

Les commentaires ont un **fil de réponses** (vous et les agents pouvez discuter avant de résoudre).
Quand Claude en résout un, son surlignage passe au **vert** (l'édition est faite, en attente de
*votre* relecture) et la carte rejoint la liste *Resolved*. La relecture se fait un par un :
**Close** sur un commentaire résolu une fois l'édition vérifiée, et son surlignage vert disparaît —
c'est l'étape de confirmation humaine, donc les couleurs se nettoient au fur et à mesure au lieu de
s'accumuler. **clear all** les ferme en bloc.

### Pourquoi un surlignage peut être légèrement décalé

Les surlignages sont dessinés depuis la *couche de texte* invisible de pdf.js (la même géométrie que
pour la sélection), qui est une approximation par ligne de l'endroit où les glyphes sont peints sur
le canvas — une boîte peut donc être décalée d'un cheveu, plus visible en zoomant. Ce petit décalage
est inhérent et cosmétique. Pour éviter la dérive plus importante qui survenait après que Claude ait
édité un passage et que le PDF se soit recomposé, TeXChronicle **ré-ancre chaque surlignage sur le texte
courant** à chaque recompilation (en faisant correspondre les phrases de début et de fin de la
citation du commentaire) au lieu de le figer sur d'anciennes coordonnées — il suit donc le texte même
quand les mots du milieu ont changé. Si un passage est supprimé ou réécrit au point d'être
méconnaissable, le surlignage revient à sa dernière position connue.

## Mode Visual (WYSIWYG)

Dans la barre de l'éditeur, basculez **Code / Visual**. Le mode Visual rend le document sur place —
`\section`/`\textbf`/`\emph`, les maths `$…$` et `\begin{equation}` (via KaTeX), les listes, les
puces `\cite`, les liens — tout en atténuant le préambule. Cliquez sur n'importe quel élément pour
révéler son LaTeX brut et l'éditer. C'est une couche de décoration au-dessus du même fichier : elle
ne modifie jamais votre source. **⏎ Wrap** enveloppe les longues lignes (pour du LaTeX écrit sans
retours à la ligne).

## L'arborescence de fichiers

Le panneau **FILES** est une arborescence complète : dépliez les dossiers, cliquez sur un fichier pour
y basculer, et utilisez **+ File / + Folder** ou le renommer/supprimer d'une ligne. Faites glisser le
séparateur en dessous pour redimensionner.

## L'éditeur de source

L'onglet **Source** du panneau gauche liste les fichiers texte du projet dans un éditeur LaTeX
CodeMirror. **Ctrl+S** (ou Save) écrit sur le disque — le watcher recompile et le PDF se rafraîchit,
exactement comme la boucle d'éditeur de Typst. Vous préférez votre propre éditeur ? Un enregistrement
depuis n'importe où déclenche la même boucle.

### Voir un diff dans la conversation

Demandez à Claude *« show me the diff »* (ou *« show the diff of the last checkpoint »*) et il
utilisera l'outil `show_diff` pour renvoyer un **diff côte à côte en image, directement dans le
chat**. Cela existe parce que Claude Code n'a pas de visionneuse de diff — si Claude se contente de
lancer `git diff`, il capture le texte et le résume. `show_diff` vous donne le vrai découpage visuel.
(Pour le même diff *à côté du PDF rendu*, utilisez le panneau History du navigateur ; pour un
découpage en terminal, `git diff` avec [delta](https://github.com/dandavison/delta) configuré.)

## Amener votre article dans Overleaf

Il y a trois façons, selon votre configuration. L'outil ne peut pas pousser vers Overleaf *à votre
place* sans vos identifiants, donc toutes vous laissent aux commandes.

### 1. Téléverser un zip propre (fonctionne pour tout le monde)

Cliquez sur **⬆ Export .zip**. Vous obtenez un zip contenant uniquement les entrées de compilation —
`.tex`, `.bib`, `.cls`/`.sty`/`.bst` et les figures — sans les artefacts de compilation (`.aux`,
`.log`, le PDF compilé), `.git/` ni `node_modules/`. Dans Overleaf : **New Project → Upload
Project**, déposez le zip.

C'est le chemin fiable et universel — pas de liaison de compte, pas besoin de dépôt public.

### 2. « Open in Overleaf » en un clic (dépôts GitHub publics)

Si votre projet est un dépôt git avec un `origin` GitHub **public**, la barre affiche
**Open in Overleaf ↗**. Cliquer demande à Overleaf d'importer directement l'archive de la branche
courante de votre dépôt — un nouveau projet, un clic. Ça ne marche que si le dépôt est public, parce
que ce sont les serveurs d'Overleaf qui récupèrent l'archive sur internet.

### 3. Synchroniser avec un projet Overleaf existant (Overleaf Premium — Git bridge)

Overleaf Premium expose chaque projet comme un remote git. Configurez-le une fois, vous-même (votre
jeton est un identifiant que l'outil ne manipule jamais) :

```bash
git remote add overleaf https://git.overleaf.com/<your-project-id>
# utilisez votre jeton git Overleaf quand git demande le mot de passe
git push overleaf <branch>
```

Ensuite, publier une mise à jour n'est plus qu'un `git push overleaf` — vous pouvez demander à Claude
de l'exécuter.

## Couverture des paquets

Le moteur WASM embarque un **sous-ensemble** de TeX Live (basic + recommended + extra). La plupart des
paquets courants sont inclus. Quelques omissions fréquentes sont gérées automatiquement :
- la famille `algorithm`/`algorithmicx` et `multirow` — les vrais `.sty` sont embarqués (à
  l'identique, LPPL) et injectés ;
- `bbm` — un petit **substitut d'aperçu** approxime `\mathbbm` (les lettres via `\mathbb`, l'
  indicateur `\mathbbm{1}` avec un 1 à double trait fait maison), pour que l'article se rende quand même.

Tout le reste hors du sous-ensemble et basé sur des fontes échouera avec
`File '<pkg>.sty' not found`. Si ça vous arrive, déposez le `.sty` du paquet (et ses fontes) dans
votre projet, ou ajustez le préambule. Dans tous les cas, votre compilation finale sur Overleaf
utilise les vrais paquets — l'aperçu local est une approximation.

## Notes

- Le PDF compilé est une approximation de ce que produit Overleaf (un TeX Live actuel via WASM), pas
  une correspondance bit à bit garantie. C'est exact pour la grande majorité des articles ; faites
  toujours une compilation finale sur votre cible (Overleaf ou votre système de soumission).
- L'historique des modifications est stocké sur une ref git cachée
  (`refs/latex-preview/checkpoints`) et ne touche jamais vos branches, votre `git log` ni votre arbre
  de travail. Si le dossier n'est pas un dépôt git, TeXChronicle garde cette ref dans un dépôt à lui,
  dans `.latex-preview/history.git` au sein du projet — l'historique suit donc le dossier quand il
  est déplacé, copié ou supprimé, et `git` lancé là continue de dire qu'il n'y a pas de dépôt.
