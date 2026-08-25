# Die Agent-Schleife — Kommentare als Auslöser

[English](../AGENT-LOOP.md) · [简体中文](AGENT-LOOP.zh-CN.md) · [日本語](AGENT-LOOP.ja.md) · [한국어](AGENT-LOOP.ko.md) · [Español](AGENT-LOOP.es.md) · [Français](AGENT-LOOP.fr.md) · **Deutsch** · [Português](AGENT-LOOP.pt.md)

Der Arbeitsbereich verwandelt einen **Kommentar im PDF** in eine **Aufgabe für Claude**. Du zeigst auf das Dokument; Claude arbeitet an der Quelle. Diese Seite zeigt, wie man das als Schleife laufen lässt, sodass Claude fortlaufend die Kommentare abarbeitet, die du hinterlässt — der erste Schritt zu einem Paper, das sich selbst weiterschreibt, während du den Verlauf beobachtest.

## Der Ein-Durchlauf-Ablauf (manuell)

1. Markiere im Arbeitsbereich Text im gerenderten PDF und hinterlasse einen Kommentar
   (z. B. *„straffe diesen Absatz“*, *„diese Behauptung braucht eine Quelle“*).
2. Sag in Claude Code **„address my comments“**.
3. Claude ruft `check_comments` auf und erhält jeden akzeptierten Kommentar als **lokalisierte Aufgabe**:

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

4. Für jeden Punkt öffnet Claude die Quelle an dieser `Datei:Zeile`, nimmt die Änderung vor und ruft
   `resolve_comment(id, note)` auf. Das Speichern löst automatisch eine Neukompilierung und einen
   Git-Checkpoint aus, sodass das PDF aktualisiert wird und die Änderung in **History** als Diff
   sichtbar ist.
5. Jede Karte wechselt mit Claudes Notiz auf **gelöst ✓**. Nichts, was du wiederholen müsstest.

## Als Schleife laufen lassen (ohne Zutun)

Nutze Claude Codes `/loop`, um den Kommentar-Posteingang zu überwachen. In deinem Projekt:

```
/loop 60s Address my PDF comments: call check_comments; for each accepted item, edit the
source at its location per the instruction and call resolve_comment with a one-line note.
If there are no accepted comments, do nothing this pass.
```

- Etwa alle 60s sucht Claude nach neuen Kommentaren und arbeitet sie ab. Kommentar hinterlassen,
  weggehen, zurückkommen zu einer gelösten Karte und einem Checkpoint-Diff.
- Wenn `check_comments` „No accepted comments“ zurückgibt, ist das ein sauberer No-op — Leerdurchläufe
  sind also billig.
- Stoppe die Schleife jederzeit; alles, was sie getan hat, steht in deiner Git-Historie.

## Warum man das beobachten kann, statt es zu bemuttern

- **Nachvollziehbar** — jeder Durchlauf hinterlässt einen Checkpoint, den du in History öffnen kannst,
  und eine Lösungsnotiz auf der Karte: du siehst immer, *was* sich geändert hat und *warum*.
- **Umkehrbar** — Checkpoints liegen auf einer versteckten Git-Ref; dein eigenes `git log` und dein
  Arbeitsbaum werden nie angefasst. Jede Änderung lässt sich ganz normal zurücknehmen.
- **Eingegrenzt** — Claude bearbeitet nur, worauf ein Kommentar zeigt; leerer Posteingang = keine Änderungen.

## Der Ablauf Reviewer → menschliche Freigabe → Resolver

Der Kommentar-Posteingang hat drei Zustände, die einen ganzen Review-Zyklus verketten:

`suggested` → (Mensch akzeptiert) → `accepted` → (Autor-Schleife) → `resolved`

1. **Reviewer postet Kommentare.** Richte Claude auf deine Review-Skill aus und lass es das Paper
   annotieren — für jedes Problem ruft es `add_comment(quote, comment)` auf, was als **Vorschlag**
   landet (violett gestrichelte Hervorhebung im PDF, eine Karte im Abschnitt *Suggested*):

   ```
   Review my paper using my installed academic-review skill.
   For each issue, call add_comment
   with the exact quoted passage and your comment. Don't edit the source yet.
   ```

2. **Mensch gibt den Review frei.** Im Abschnitt *Suggested* akzeptierst du per **Accept**, was du
   teilst (wird zu umsetzbarem `accepted`), lehnst den Rest per **Reject** ab, oder bearbeitest/ergänzt
   eigene. `check_comments` ignoriert `suggested`-Einträge bewusst — der Autor handelt nie nach einem
   Vorschlag, den du nicht akzeptiert hast.

   - Lieber ohne Zutun? Aktiviere oben im Kommentar-Panel **Auto-accept reviewer suggestions
     (copilot)**, dann wird jeder Vorschlag sofort beim Eintreffen akzeptiert. (Vollständig autonome
     Agents können mit `add_comment(..., accepted: true)` auch direkt umsetzbare Kommentare posten.)

3. **Autor-Schleife löst auf.** Starte die obige Schleife — sie holt die `accepted`-Kommentare,
   bearbeitet an jeder lokalisierten `Datei:Zeile`, kompiliert neu und löst jeden mit einer Notiz.

4. **Alles wird festgehalten.** Jedes Akzeptieren, Bearbeiten und Auflösen hinterlässt einen
   Checkpoint plus Notiz, sodass die ganze Reviewer→Autor-Runde in **History** nachvollziehbar ist.

## Ultra-agents ⚡

> [!CAUTION]
> Das ist TeXChronicle' mächtigster Befehl und zugleich der am wenigsten beaufsichtigte — bewusst ohne
> Freigabe von dir zwischen den Runden. Lies diesen Abschnitt ganz, bevor du ihn mit hohem `depth`
> ausführst.

`/ultra-agents [skill] [depth]` entfernt die menschliche Freigabe aus Schritt 2 vollständig — der
Reviewer postet jeden Kommentar mit `add_comment(..., accepted: true)`, er ist also im Moment des
Aufwerfens umsetzbar, und der Autor löst ihn direkt danach auf. Dann wiederholt sich das: das
*gerade bearbeitete* Paper erneut prüfen, erneut korrigieren, bis zu `depth` Runden (Standard **2**),
mit sofortigem Stopp, sobald eine Runde nichts Neues aufwirft — ein konvergiertes Paper verbrennt den
Rest der Zählung nicht.

Das ist der schnellste Weg, einen Entwurf voranzubringen, und der am wenigsten überwachte — es gibt
keinen Kontrollpunkt pro Runde für *dich*, nur für das Werkzeug. Verlangst du einen depth über 5,
hält es an und lässt dich erst bestätigen, denn das ist eine Menge unbeaufsichtigtes Bearbeiten, um
es leichtfertig zuzusagen. Welchen depth du auch wählst, gestartet wird so:

```
/ultra-agents academic-paper-revision 3
```

Wenn es fertig ist (durch Erreichen des depth oder frühe Konvergenz), ruft es `list_checkpoints` auf
und gibt dir eine **nach Runden gruppierte Zusammenfassung** — was aufgeworfen wurde, was sich
geändert hat, und den Checkpoint-Sha jeder Runde, sodass `/show_diff <sha>` direkt dorthin springt,
statt dass du History durchsuchen musst. Das Sicherheitsnetz ist dasselbe wie überall hier: jede
Runde bleibt ein gewöhnlicher Checkpoint, prüfbar und rückgängig machbar (ganze Runde oder pro Datei)
über den History-Tab. Damit ist der *Schaden* behebbar, nicht die *Zeit* — nichts achtet auf eine aus
dem Ruder gelaufene Runde außer dir beim Lesen der Zusammenfassung. Nutze es also für Entwürfe, die
du danach auch wirklich durchsehen willst, nicht für die Fassung, die ungeprüft rausgeht.

Das ist weiterhin ein Reviewer + ein Autor mit einem Menschen dazwischen. Mehrere Claude-Code-
Sitzungen können bereits gleichzeitig am selben Projekt arbeiten, ohne Kommentare oder Checkpoints zu
beschädigen (jede Änderung läuft unter einer prozessübergreifenden Sperre — siehe
[`ROADMAP.de.md`](ROADMAP.de.md)), aber sie wechseln sich weiterhin ab, statt wirklich parallel zu
bearbeiten. Echtes gleichzeitiges Multi-Agent (Reviewer / Autor / Defender auf eigenen Git-Branches,
mit koordinierten Zügen) ist der nächste Meilenstein — siehe [`ROADMAP.de.md`](ROADMAP.de.md).
