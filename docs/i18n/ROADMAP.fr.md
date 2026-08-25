# Feuille de route

[English](../ROADMAP.md) · [简体中文](ROADMAP.zh-CN.md) · [日本語](ROADMAP.ja.md) · [한국어](ROADMAP.ko.md) · [Español](ROADMAP.es.md) · **Français** · [Deutsch](ROADMAP.de.md) · [Português](ROADMAP.pt.md)

## Livré : usage concurrent sûr de l'état propre à TeXChronicle

Chaque session Claude Code qui se connecte au serveur MCP `texchronicle` d'un projet lance son **propre processus séparé** (MCP en stdio = un processus enfant par client) — donc deux sessions travaillant sur le même article ne partagent aucun état en mémoire. Rien n'empêchait les deux de se disputer les mêmes fichiers sur disque.

- **Verrou inter-processus** (`src/lock.ts`) — un fichier de verrou exclusif à `.latex-preview/.lock`, acquis par création atomique (`O_EXCL`), avec récupération en cas de verrou obsolète (un PID propriétaire mort, ou un verrou vieux de plus de 30s, est nettoyé automatiquement, pour qu'un agent planté ne puisse pas bloquer les autres indéfiniment).
- **Ce qui est protégé** : `add_comment` / `resolve_comment` / `reply_to_comment` / rejeter-et-supprimer (tous les mutateurs de `commentsStore.ts`) et la création/restauration de checkpoints (`createCheckpoint`, `restoreCheckpoint`, `restoreFile`) — chacun exécute maintenant son cycle complet lire-modifier-écrire comme une seule section critique inter-processus, au lieu de lire → modifier → écrire sans exclusion.
- **Écritures atomiques** — `comments.json` est écrit dans un fichier temporaire puis renommé par-dessus la cible, si bien qu'une lecture concurrente (qui reste non verrouillée — les lectures n'ont jamais eu besoin de bloquer) ne voit jamais un fichier à moitié écrit.
- Vérifié : deux processus OS réellement séparés martelant `add_comment` en même temps ne perdent aucune écriture ; un verrou laissé par un processus mort se libère en moins de 100ms au lieu d'attendre le timeout.

**Ce que ça ne couvre *pas*** : deux agents éditant le *même* fichier `.tex` au même moment via l'outil d'édition de fichiers normal. Cette écriture va directement sur disque, entièrement en dehors de notre serveur MCP — aucun verrou qu'on ajoute ne peut agir dessus. Si vous voulez expérimenter avec deux agents dès aujourd'hui, gardez-les sur des fichiers qui ne se chevauchent pas (un sur `intro.tex`, l'autre sur `related-work.tex`) jusqu'à ce que le jalon ci-dessous soit livré.

## Prochain jalon : vrai multi-agent (édition parallèle)

Des agents reviewer, author et defender travaillant le même article *en même temps*, éditant réellement la prose en parallèle — pas seulement chacun son tour via un verrou partagé.

- **Direction** : isolation par agent via des worktrees/branches git. Chaque agent travaille dans son propre worktree, compile indépendamment ; une étape de coordination (relecture humaine, ou un agent intégrateur) fusionne les branches dans le projet.
- **Besoins** : gestion du cycle de vie des worktrees (création par exécution d'agent, nettoyage après fusion/abandon), une UX pour les conflits de fusion (les conflits au niveau du paragraphe sont un problème de contenu, pas seulement de git — la façon de les présenter mérite réflexion), probablement un aperçu PDF par branche ou une étape "fusionner puis recompiler", et de nouveaux outils/commandes MCP pour lancer et suivre des exécutions d'agents parallèles.
- **Pas commencé.** Le verrou ci-dessus est un vrai filet de sécurité, que ce jalon voie le jour ou non — c'est lui qui rend sûr, dès aujourd'hui, le fait d'avoir "laissé une deuxième session Claude Code ouverte sur ce projet", plutôt qu'un piège silencieux à perte de données.
