# Roadmap

[English](../ROADMAP.md) · [简体中文](ROADMAP.zh-CN.md) · [日本語](ROADMAP.ja.md) · [한국어](ROADMAP.ko.md) · [Español](ROADMAP.es.md) · [Français](ROADMAP.fr.md) · **Deutsch** · [Português](ROADMAP.pt.md)

## Bereits umgesetzt: sichere gleichzeitige Nutzung von TeXChronicle' eigenem Zustand

Jede Claude-Code-Sitzung, die sich mit dem `texchronicle`-MCP-Server eines Projekts verbindet, startet ihren **eigenen, getrennten Prozess** (stdio-MCP = ein Kindprozess pro Client) — zwei Sitzungen, die am selben Paper arbeiten, teilen sich also keinerlei Zustand im Speicher. Bisher hinderte nichts die beiden daran, um dieselben Dateien auf der Festplatte zu wettlaufen.

- **Prozessübergreifende Sperre** (`src/lock.ts`) — eine exklusive Lock-Datei unter `.latex-preview/.lock`, per atomarer Erstellung (`O_EXCL`) erworben, mit Wiederherstellung bei veralteten Sperren (eine tote Besitzer-PID oder eine über 30s alte Sperre wird automatisch entfernt, damit ein abgestürzter Agent nicht dauerhaft alle anderen blockiert).
- **Was dadurch geschützt wird**: `add_comment` / `resolve_comment` / `reply_to_comment` / Ablehnen-und-Löschen (alle Schreiboperationen von `commentsStore.ts`) sowie das Erstellen/Wiederherstellen von Checkpoints (`createCheckpoint`, `restoreCheckpoint`, `restoreFile`) — jede läuft jetzt als vollständiger Lese-Ändern-Schreiben-Vorgang in **einem prozessübergreifenden kritischen Abschnitt**, statt lesen → ändern → schreiben ohne gegenseitigen Ausschluss.
- **Atomare Schreibvorgänge** — `comments.json` wird in eine temporäre Datei geschrieben und dann über das Ziel umbenannt, sodass ein gleichzeitiges Lesen (das weiterhin ohne Sperre auskommt — Lesevorgänge mussten nie blockieren) niemals eine halb geschriebene Datei zu sehen bekommt.
- Verifiziert: Zwei wirklich getrennte Betriebssystemprozesse, die gleichzeitig `add_comment` aufrufen, verlieren keinen einzigen Schreibvorgang; eine von einem abgestürzten Prozess hinterlassene Sperre wird in unter 100ms bereinigt, statt das Timeout abzuwarten.

**Was das *nicht* abdeckt**: zwei Agents, die im selben Moment über das normale Datei-Bearbeitungswerkzeug dieselbe `.tex`-Datei bearbeiten. Dieser Schreibvorgang geht direkt auf die Festplatte, komplett an unserem MCP-Server vorbei — keine von uns hinzugefügte Sperre kann da vermitteln. Wer heute schon mit zwei Agents experimentieren will, sollte sie auf nicht überlappende Dateien beschränken (einer nur auf `intro.tex`, der andere nur auf `related-work.tex`), bis der Meilenstein unten kommt.

## Nächster Meilenstein: echtes Multi-Agent (paralleles Bearbeiten)

Reviewer-, Author- und Defender-Agents arbeiten *gleichzeitig* am selben Paper und bearbeiten wirklich parallel Text — nicht nur abwechselnd über eine gemeinsame Sperre.

- **Richtung**: Isolation pro Agent über Git-Worktrees/-Branches. Jeder Agent arbeitet in seinem eigenen Worktree, kompiliert unabhängig; ein Koordinationsschritt (menschliche Durchsicht oder ein Integrator-Agent) führt die Branches wieder ins Projekt zusammen.
- **Wird benötigt**: Verwaltung des Worktree-Lebenszyklus (Erstellung pro Agent-Lauf, Aufräumen nach Merge/Abbruch), eine UX für Merge-Konflikte (Konflikte auf Absatzebene sind ein Inhalts-, nicht nur ein Git-Problem — wie man sie darstellt, braucht Nachdenken), vermutlich eine PDF-Vorschau pro Branch oder ein "erst mergen, dann neu kompilieren"-Schritt, sowie neue MCP-Tools/-Befehle, um parallele Agent-Läufe zu starten und zu verfolgen.
- **Noch nicht begonnen.** Die obige Sperre ist ein echtes Sicherheitsnetz, unabhängig davon, ob dieser Meilenstein je kommt — sie macht "jemand hat eine zweite Claude-Code-Sitzung an diesem Projekt offen gelassen" schon heute sicher, statt zur stillen Datenverlust-Falle.
