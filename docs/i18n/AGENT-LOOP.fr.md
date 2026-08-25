# La boucle d'agent — les commentaires comme déclencheurs

[English](../AGENT-LOOP.md) · [简体中文](AGENT-LOOP.zh-CN.md) · [日本語](AGENT-LOOP.ja.md) · [한국어](AGENT-LOOP.ko.md) · [Español](AGENT-LOOP.es.md) · **Français** · [Deutsch](AGENT-LOOP.de.md) · [Português](AGENT-LOOP.pt.md)

L'espace de travail transforme un **commentaire sur le PDF** en une **tâche pour Claude**. Vous pointez le document ; Claude travaille sur la source. Cette page montre comment exécuter cela en boucle, pour que Claude traite les commentaires au fur et à mesure que vous les laissez — le premier pas vers un article qui avance tout seul pendant que vous regardez l'historique.

## Le flux en une passe (manuel)

1. Dans l'espace de travail, sélectionnez du texte sur le PDF rendu et laissez un commentaire
   (p. ex. *« resserre ce paragraphe »*, *« cette affirmation a besoin d'une citation »*).
2. Dans Claude Code, dites **« address my comments »**.
3. Claude appelle `check_comments` et obtient chaque commentaire accepté comme **tâche localisée** :

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

4. Pour chaque élément, Claude ouvre la source à ce `fichier:ligne`, fait la modification et appelle
   `resolve_comment(id, note)`. L'enregistrement déclenche automatiquement une recompilation et un
   checkpoint git : le PDF se rafraîchit et le changement est consultable en diff dans **History**.
5. Chaque carte bascule en **résolu ✓** avec la note de Claude. Rien à redire de votre part.

## L'exécuter en boucle (sans intervention)

Utilisez le `/loop` de Claude Code pour surveiller la boîte de commentaires. Dans votre projet :

```
/loop 60s Address my PDF comments: call check_comments; for each accepted item, edit the
source at its location per the instruction and call resolve_comment with a one-line note.
If there are no accepted comments, do nothing this pass.
```

- Toutes les ~60s, Claude cherche les nouveaux commentaires et les traite. Laissez un commentaire,
  partez, revenez à une carte résolue et un diff de checkpoint.
- Quand `check_comments` renvoie « No accepted comments », c'est un no-op propre : les passes à vide
  sont bon marché.
- Arrêtez la boucle quand vous voulez ; tout ce qu'elle a fait est dans votre historique git.

## Pourquoi on peut surveiller sans materner

- **Traçable** — chaque passe laisse un checkpoint ouvrable dans History et une note de résolution
  sur la carte : vous voyez toujours *ce qui* a changé et *pourquoi*.
- **Réversible** — les checkpoints vivent sur une ref git cachée ; votre `git log` et votre arbre de
  travail ne sont jamais touchés. Annulez n'importe quel changement de la manière habituelle.
- **Circonscrit** — Claude ne modifie que là où pointe un commentaire ; boîte vide = zéro modification.

## Le flux relecteur → validation humaine → résolveur

La boîte de commentaires a trois états, qui enchaînent tout un cycle de relecture :

`suggested` → (l'humain accepte) → `accepted` → (boucle auteur) → `resolved`

1. **Le relecteur poste des commentaires.** Pointez Claude vers votre skill de relecture et laissez-le
   annoter l'article — pour chaque problème il appelle `add_comment(quote, comment)`, qui atterrit
   comme une **suggestion** (surlignage violet pointillé sur le PDF, une carte dans la section
   *Suggested*) :

   ```
   Review my paper using my installed academic-review skill.
   For each issue, call add_comment
   with the exact quoted passage and your comment. Don't edit the source yet.
   ```

2. **L'humain valide la relecture.** Dans la section *Suggested*, vous **Acceptez** ceux que vous
   partagez (ils deviennent des `accepted` actionnables), **Rejetez** le reste, ou éditez/ajoutez les
   vôtres. `check_comments` ignore délibérément les `suggested` — l'auteur n'agit jamais sur une
   suggestion que vous n'avez pas acceptée.

   - Vous préférez ne pas intervenir ? Activez **Auto-accept reviewer suggestions (copilot)** en haut
     du panneau Commentaires : chaque suggestion est acceptée dès son arrivée. (Les agents totalement
     autonomes peuvent aussi poster des commentaires directement actionnables avec
     `add_comment(..., accepted: true)`.)

3. **La boucle auteur résout.** Lancez la boucle ci-dessus — elle récupère les commentaires
   `accepted`, édite à chaque `fichier:ligne` localisé, recompile et résout chacun avec une note.

4. **Tout est enregistré.** Chaque acceptation, édition et résolution laisse un checkpoint et une
   note : toute la ronde relecteur→auteur est traçable dans **History**.

## Ultra-agents ⚡

> [!CAUTION]
> C'est la commande la plus puissante de TeXChronicle, et la moins supervisée — aucune approbation de
> votre part entre les tours, par conception. Lisez toute cette section avant de l'exécuter avec un
> `depth` élevé.

`/ultra-agents [skill] [depth]` supprime entièrement la validation humaine de l'étape 2 — le
relecteur poste chaque commentaire avec `add_comment(..., accepted: true)`, donc il est actionnable
dès qu'il est soulevé, et l'auteur le résout dans la foulée. Puis ça recommence : relire l'article
*qui vient d'être modifié*, corriger à nouveau, jusqu'à `depth` tours (par défaut **2**), en
s'arrêtant dès qu'un tour ne soulève rien de nouveau — un article qui a convergé ne consomme pas le
reste du compteur.

C'est la façon la plus rapide de faire avancer un brouillon, et la moins supervisée — pas de point de
contrôle par tour pour *vous*, seulement pour l'outil. Demandez un depth supérieur à 5 et il s'arrête
pour vous faire confirmer d'abord, parce que c'est beaucoup d'édition sans surveillance pour s'y
engager à la légère. Quel que soit le depth choisi, ça se lance ainsi :

```
/ultra-agents academic-paper-revision 3
```

Quand c'est fini (depth atteint ou convergence anticipée), il appelle `list_checkpoints` et vous donne
un **résumé groupé par tour** — ce qui a été soulevé, ce qui a changé, et le sha du checkpoint de
chaque tour, pour que `/show_diff <sha>` vous emmène directement à l'un d'eux au lieu de fouiller
History. Le filet de sécurité est le même que partout ailleurs ici : chaque tour reste un checkpoint
ordinaire, relisible et réversible (tour entier ou par fichier) depuis l'onglet History. Cela rend
les *dégâts* récupérables, pas le *temps* — rien ne surveille un tour qui a dérapé à part vous en
lisant le résumé. Utilisez-le donc sur des brouillons que vous êtes prêt à relire ensuite, pas sur la
version qui part telle quelle.

Cela reste un relecteur + un auteur avec un humain au milieu. Plusieurs sessions Claude Code peuvent
déjà travailler le même projet en même temps sans corrompre les commentaires ni les checkpoints
(chaque mutation s'exécute sous un verrou inter-processus — voir [`ROADMAP.fr.md`](ROADMAP.fr.md)),
mais elles se relaient plutôt que d'éditer vraiment en parallèle. Le vrai multi-agent concurrent
(relecteur / auteur / défenseur sur leurs propres branches git, avec des tours coordonnés) est le
prochain jalon — voir [`ROADMAP.fr.md`](ROADMAP.fr.md).
