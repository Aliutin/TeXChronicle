# TeXChronicle — Benutzerhandbuch

[English](../USER-GUIDE.md) · [简体中文](USER-GUIDE.zh-CN.md) · [日本語](USER-GUIDE.ja.md) · [한국어](USER-GUIDE.ko.md) · [Español](USER-GUIDE.es.md) · [Français](USER-GUIDE.fr.md) · **Deutsch** · [Português](USER-GUIDE.pt.md)

![Der TeXChronicle-Arbeitsbereich](../images/workspace.png)

## Täglicher Einsatz

1. Trage den Server in die `.mcp.json` deines Projekts ein (siehe README) und starte Claude Code neu.
   Oder installiere das Plugin für die Slash-Befehle (unten).
2. Bitte Claude um *„render a preview“* (oder führe `/texchronicle` aus). Der **Arbeitsbereich**
   öffnet sich: **Dateibaum + Quellcode-Editor** links, das **Live-PDF** in der Mitte und
   **Comments** rechts (umschaltbar über den 💬 **Comments**-Button in der oberen Leiste).
3. Ab da bleibt das PDF live. Speichern in deinem eigenen Editor und Claudes Änderungen kompilieren
   automatisch neu; im eingebauten Editor drückst du **Ctrl+S** / **Recompile** zum Neubauen (er
   speichert deine Arbeit alle 30s, ohne neu zu kompilieren).

## Slash-Befehle (Plugin)

Einmal installieren — `/plugin marketplace add Aliutin/TeXChronicle`, dann
`/plugin install texchronicle` — und mit minimalem Tippen steuern:

- **`/texchronicle`** — kompilieren und den Arbeitsbereich öffnen.
- **`/ai-review [skill]`** — das Paper mit einer Skill prüfen (Standard `academic-paper-revision`;
  jeder Skill-Name geht) und Kommentare zum Akzeptieren posten.
- **`/address-comments`** — deine akzeptierten Kommentare lösen (als Schleife:
  `/loop 60s /address-comments`).
- ⚡ **`/ultra-agents [skill] [depth]`** — vollautonom: prüfen, automatisch akzeptieren, korrigieren,
  wiederholen — bis zu `depth` Runden (Standard 2), mit vorzeitigem Stopp, sobald eine Runde nichts
  Neues findet. Keine Freigabe zwischen den Runden — das ist der Sinn und das Risiko. Siehe
  [`AGENT-LOOP.de.md`](AGENT-LOOP.de.md#ultra-agents-).

### Ein Befehl pro Tool

Jedes MCP-Tool hat außerdem einen Slash-Befehl mit **demselben Namen** — jeder einzelne Schritt ist
also einen Befehl entfernt. Die Regel zum Weitergeben: *das Tool heißt `X` → tippe `/X`*.

| Das tippen | Führt Tool aus | Was es tut |
| --- | --- | --- |
| `/render_preview` | `render_preview` | Kompiliert das Paper und öffnet/aktualisiert die Live-Vorschau. |
| `/check_comments` | `check_comments` | Listet deine akzeptierten Kommentare als Anweisungen (noch keine Änderung). |
| `/resolve_comment [id] [Notiz]` | `resolve_comment` | Markiert einen Kommentar nach der Änderung als erledigt; wird **grün** zur Prüfung. |
| `/add_comment ["Zitat"] [Notiz]` | `add_comment` | Verankert einen Kommentar an einer Stelle zum Annehmen/Ablehnen. |
| `/reply_to_comment [id] [Text]` | `reply_to_comment` | Fügt eine Thread-Antwort zu einem Kommentar hinzu. |
| `/show_diff [checkpoint]` | `show_diff` | Nebeneinander-Diff als Bild (aktuelle Änderungen oder ein Checkpoint). |
| `/list_checkpoints [limit]` | `list_checkpoints` | Letzte Checkpoints mit sha — um einen an `/show_diff` zu übergeben. |

Du musst sie nie tippen — normale Sprache funktioniert auch (*„zeig eine Vorschau“*, *„bearbeite
meine Kommentare“*). Die Befehle sind nur eine schnelle, gut vermittelbare Kurzform.

## Die Kommentar-Schleife (du prüfst im PDF, Claude bearbeitet die Quelle)

1. **Markiere Text im gerenderten PDF** → ein Eingabefeld erscheint → schreib, was geändert werden
   soll („straffe diesen Absatz“, „diese Gleichung sieht falsch aus“) → **Add comment**. Die Stelle
   bekommt eine verankerte Hervorhebung; die Karte erscheint rechts als *accepted*.
2. Sag in Claude Code *„address my comments“*. Claude ruft `check_comments` auf (jeder Kommentar
   kommt mit Seite, exaktem Zitat und deiner Anweisung), bearbeitet die Quelle und ruft
   `resolve_comment` mit einer einzeiligen Notiz auf.
3. Das PDF kompiliert neu, die Karte wechselt mit Claudes Notiz auf *resolved ✓*, und der
   History-Tab enthält den Checkpoint-Diff der Änderung.

Du musst nie LaTeX anfassen — du zeigst auf das Dokument, Claude arbeitet an der Quelle.

## Der Review-Ablauf (Reviewer → du gibst frei → Autor löst auf)

Du kannst auch einen Agent die Kommentare *aufwerfen* lassen und trotzdem in der Schleife bleiben:

1. **Reviewer-Durchlauf.** Führe `/ai-review academic-paper-revision` aus (oder richte es auf eine
   beliebige Review-Skill). Der Agent liest das Paper und ruft für jedes Problem `add_comment` auf —
   sie erscheinen als **Suggested**-Karten (violett gestrichelte Hervorhebungen im PDF), markiert als
   **reviewer** oder **defender**.
2. **Du gibst frei.** Im Kommentar-Panel **Accept** für die, denen du zustimmst (werden zu
   umsetzbarem *accepted*), **Reject** für den Rest, oder ergänze eigene. Lieber ohne Zutun? Setze
   den Haken bei **Auto-accept reviewer suggestions (copilot)**, dann wird jeder Vorschlag automatisch
   akzeptiert.
3. **Der Autor löst auf.** Führe `/address-comments` aus (oder als Schleife). Der Autor bearbeitet
   jeden akzeptierten Kommentar an seiner Quellstelle und markiert ihn mit einer Notiz als gelöst.

Kommentare haben einen **Antwort-Thread** (du und die Agents könnt vor dem Auflösen diskutieren).
Wenn Claude einen auflöst, wird seine Hervorhebung **grün** (die Änderung ist erledigt, wartet auf
*deine* Durchsicht) und die Karte wandert in die *Resolved*-Liste. Durchgesehen wird einzeln:
**Close** bei einem gelösten Kommentar, sobald du die Änderung geprüft hast, und die grüne
Hervorhebung verschwindet — das ist der menschlich bestätigte Schritt, sodass sich die Farben beim
Durchgehen abbauen statt anzuhäufen. **clear all** schließt sie im Block.

### Warum eine Hervorhebung leicht verschoben sitzen kann

Hervorhebungen werden aus der unsichtbaren *Textebene* von pdf.js gezeichnet (dieselbe Geometrie, die
auch fürs Markieren dient) — eine zeilenweise Näherung dafür, wo die Glyphen auf der Canvas gemalt
werden. Ein Kasten kann also ein Haar daneben liegen, beim Zoomen deutlicher sichtbar. Dieser kleine
Versatz ist systembedingt und rein kosmetisch. Um die größere Drift zu vermeiden, die früher auftrat,
nachdem Claude eine Stelle bearbeitet hatte und das PDF neu umbrach, **verankert TeXChronicle jede
Hervorhebung bei jeder Neukompilierung neu am aktuellen Text** (durch Abgleich der Anfangs- und
Endphrase des Zitats), statt sie an alten Koordinaten festzunageln — sie folgt dem Text also auch,
wenn sich die Wörter dazwischen geändert haben. Wird eine Stelle gelöscht oder bis zur
Unkenntlichkeit umgeschrieben, fällt die Hervorhebung auf ihre letzte bekannte Position zurück.

## Visual-Modus (WYSIWYG)

Schalte in der Editorleiste zwischen **Code / Visual** um. Der Visual-Modus rendert das Dokument an
Ort und Stelle — `\section`/`\textbf`/`\emph`, `$…$`- und `\begin{equation}`-Mathematik (via KaTeX),
Listen, `\cite`-Chips, Links — und blendet die Präambel gedimmt ein. Klick auf ein Element, um sein
rohes LaTeX zu sehen und zu bearbeiten. Es ist eine Dekorationsebene über derselben Datei, ändert
deine Quelle also nie. **⏎ Wrap** bricht lange Zeilen um (für LaTeX ohne Zeilenumbrüche).

## Der Dateibaum

Das **FILES**-Panel ist ein vollständiger Baum: Ordner aufklappen, eine Datei anklicken, um zu ihr zu
wechseln, und **+ File / + Folder** oder das Umbenennen/Löschen einer Zeile nutzen. Zieh den Trenner
darunter zum Verändern der Größe.

## Der Quellcode-Editor

Der **Source**-Tab im linken Panel listet die Textdateien des Projekts in einem CodeMirror-LaTeX-
Editor. **Ctrl+S** (oder Save) schreibt auf die Festplatte — der Watcher kompiliert neu und das PDF
aktualisiert sich, genau wie die Editor-Schleife von Typst. Lieber dein eigener Editor? Speichern von
überall löst dieselbe Schleife aus.

### Einen Diff im Gespräch sehen

Bitte Claude um *„show me the diff“* (oder *„show the diff of the last checkpoint“*), und es nutzt
das `show_diff`-Tool, um einen **Nebeneinander-Diff als Bild direkt im Chat** zurückzugeben. Das gibt
es, weil Claude Code keinen eigenen Diff-Viewer hat — führt Claude einfach `git diff` aus, fängt es
den Text ab und fasst ihn zusammen. `show_diff` liefert stattdessen die echte visuelle Aufteilung.
(Für denselben Diff *neben dem gerenderten PDF* nimm das History-Panel im Browser; für eine
Terminal-Aufteilung `git diff` mit konfiguriertem [delta](https://github.com/dandavison/delta).)

## Dein Paper nach Overleaf bringen

Es gibt drei Wege, je nach Setup. Das Werkzeug kann ohne deine Zugangsdaten nicht *für dich* nach
Overleaf pushen, also behältst du bei allen die Kontrolle.

### 1. Ein sauberes Zip hochladen (funktioniert für alle)

Klick **⬆ Export .zip**. Du bekommst ein Zip mit ausschließlich den Build-Eingaben — `.tex`, `.bib`,
`.cls`/`.sty`/`.bst` und Abbildungen — ohne Build-Artefakte (`.aux`, `.log`, das kompilierte PDF),
`.git/` und `node_modules/`. In Overleaf: **New Project → Upload Project**, Zip hineinziehen.

Das ist der zuverlässige, universelle Weg — keine Kontoverknüpfung, kein öffentliches Repo nötig.

### 2. „Open in Overleaf“ mit einem Klick (öffentliche GitHub-Repos)

Ist dein Projekt ein Git-Repo mit **öffentlichem** GitHub-`origin`, zeigt die Leiste
**Open in Overleaf ↗**. Ein Klick bittet Overleaf, das Archiv des aktuellen Branches direkt zu
importieren — ein neues Projekt, ein Klick. Das geht nur bei öffentlichen Repos, weil Overleafs
Server das Archiv übers Internet abrufen.

### 3. Mit einem bestehenden Overleaf-Projekt synchronisieren (Overleaf Premium — Git-Bridge)

Overleaf Premium stellt jedes Projekt als Git-Remote bereit. Richte es einmal selbst ein (dein Token
ist eine Zugangsberechtigung, die das Werkzeug nie anfasst):

```bash
git remote add overleaf https://git.overleaf.com/<your-project-id>
# nutze dein Overleaf-Git-Token, wenn git nach dem Passwort fragt
git push overleaf <branch>
```

Danach ist eine Aktualisierung nur noch `git push overleaf` — du kannst Claude bitten, das auszuführen.

## Paketabdeckung

Die WASM-Engine bringt eine **Teilmenge** von TeX Live mit (basic + recommended + extra). Die meisten
gängigen Pakete sind enthalten. Ein paar häufige Lücken werden automatisch behandelt:
- die `algorithm`/`algorithmicx`-Familie und `multirow` — die echten `.sty` sind mitgeliefert
  (wortgetreu, LPPL) und werden eingespielt;
- `bbm` — ein kleiner **Vorschau-Ersatz** nähert `\mathbbm` an (Buchstaben über `\mathbb`, der
  `\mathbbm{1}`-Indikator über eine behelfsmäßige doppelt gestrichene 1), damit das Paper trotzdem
  rendert.

Alles andere außerhalb der Teilmenge und schriftartbasierte Pakete scheitern mit
`File '<pkg>.sty' not found`. Wenn das passiert, leg die `.sty` des Pakets (und Schriften) in dein
Projekt oder passe die Präambel an. So oder so nutzt deine finale Kompilierung auf Overleaf die
echten Pakete — die lokale Vorschau ist eine Näherung.

## Hinweise

- Das kompilierte PDF ist eine Näherung dessen, was Overleaf erzeugt (ein aktuelles TeX Live via
  WASM), keine garantiert bitgleiche Übereinstimmung. Für die allermeisten Paper ist es genau; mach
  immer eine finale Kompilierung auf deinem Ziel (Overleaf oder deinem Einreichungssystem).
- Der Änderungsverlauf liegt auf einer versteckten Git-Ref (`refs/latex-preview/checkpoints`) und
  fasst deine Branches, dein `git log` und deinen Arbeitsbaum nie an. Ist der Ordner kein
  Git-Repository, hält TeXChronicle diese Ref in einem eigenen Repository unter
  `.latex-preview/history.git` im Projekt — der Verlauf wandert, kopiert und verschwindet also
  mit dem Ordner, und `git` meldet dort weiterhin kein Repository.
