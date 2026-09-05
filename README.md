# Futterassi App, v22, flache Struktur

## Neu in v22

Rezepte mit dem Feld `original` bekommen im Rezept einen Umschalter **Angepasst / Original**. Er erscheint nur, wenn das Feld da ist, und steht immer auf Angepasst, auch nach dem Schließen und erneuten Öffnen.

Umgeschaltet werden genau sechs Felder: `zutaten`, `schritte`, `kcal`, `protein`, `fett`, `quelle`. Tags, Status, Prep-Angaben, Zeit und Geräte bleiben stehen, die gelten nur für die angepasste Fassung. Nährwerte stehen jetzt auch im Rezept selbst, sonst wäre der Unterschied nicht sichtbar.

Portionsrechner, Zutaten kopieren und Kochmodus beziehen sich auf die gerade angezeigte Fassung. Wochenplan, Vorkoch-Rechnung, Zutatenliste der Woche und Nährwertsummen nehmen immer die angepasste, unabhängig davon, was auf dem Bildschirm steht. Anpassen bearbeitet ebenfalls immer die angepasste Fassung und schaltet vorher zurück. Nach dem Kochen der Originalfassung fragt die App nicht nach der Ausbeute, weil `portionen_real` zur angepassten Fassung gehört.

## Neu in v21

Im Wochenabschluss sprang der Bildschirm bei jedem Antippen nach oben, weil das ganze Blatt neu aufgebaut wurde. Jetzt ändert sich nur die angetippte Stelle, die Ansicht bleibt stehen. Dasselbe im Einplanen-Blatt und bei der Ausbeute-Frage.

## Neu in v20

**Ausbeute statt Schätzung.** Am Ende des Kochmodus fragt die App einmal, wie viele Portionen aus den Mengen des Rezepts geworden sind. Der Wert landet in `portionen_real`. Ab dann rechnet die App alle Mengen auf diesen gemessenen Wert um statt auf die geschätzte `basis`: Zutaten im Rezept, im Kochmodus, im Wochenblatt und in der Zutatenliste der Woche. Überspringen geht mit einem Tipper.

**Vorschläge** oben in der Planung. Bis zu drei Gerichte, die "kommt wieder" bekommen haben und mindestens zehn Tage her sind, dazu bis zu zwei Kandidaten, die noch nie dran waren. Antippen öffnet direkt das Einplanen-Blatt. Was schon in der Woche steht, taucht nicht auf.

Das Abzeichen für das Kind ist von den Katalogkarten verschwunden, die Angabe steht weiter im Rezept unter Notizen.

## Neu in v19

**Woche abschließen.** Unten in der Planung. Geht die Gerichte der Woche durch, je Gericht ein Urteil, ob das Kind gegessen hat und wie viele Portionen tatsächlich herauskamen, dazu eine Notiz zur Woche. Danach ist die Planung leer und die Woche liegt im Archiv. Wer nur leeren will, nimmt im selben Blatt den zweiten Knopf.

Die Urteile landen in den Rezepten und damit im Export nach `rezepte.json`. Zwei Felder sind dabei neu: `kind_isst` (true/false) und `portionen_real`, letzteres steht bereits im Schema und war bisher überall leer.

**Archiv** im Reiter Daten. Bis zu dreißig abgeschlossene Wochen mit Urteilen und Notiz, jede mit einem fertigen Rückblick-Text für den Chat, wiederherstellbar und löschbar. Die Sicherung nimmt das Archiv mit.

Im Katalog tragen Rezepte jetzt ein Abzeichen, wenn sie zuletzt "kommt wieder" bekommen haben oder das Kind mitgegessen hat.

## Neu in v18

**Plan teilen.** Unter dem Kopiertext steht "Link zur Woche kopieren". Der Link trägt die ganze Woche in sich, ohne Server. Wer ihn öffnet, sieht das Wochenblatt mit allen Rezepten, Zutaten und Kochmodus, ohne dass die eigene Planung angefasst wird. Wahlweise übernehmen oder nur nachschauen. Der Knopf "Woche teilen" schickt Text und Link zusammen ins Teilen-Menü.

Wichtig auf dem iPhone: Ein Link öffnet sich in Safari, nicht in der App vom Homescreen, und beide haben getrennte Speicher. Wer die Woche in seiner installierten App haben will, tippt in der geteilten Ansicht auf "Code kopieren" und fügt ihn dort unter "Aus dem Chat übernehmen" ein. Das Feld versteht jetzt auch Links und Codes.

**Schritte mit Zutatenverweisen.** Ein Schritt darf jetzt statt eines Textes ein Objekt sein:

    "zutaten": [
      { "menge": 250, "einheit": "g", "name": "Kritharaki", "ref": "kritharaki" }
    ],
    "schritte": [
      { "text": "Wasser mit Salz aufkochen, Kritharaki bissfest kochen.",
        "zutaten": ["kritharaki", "wasser"] }
    ]

In `zutaten` eines Schrittes stehen entweder die Kurznamen aus dem Feld `ref`, die Namen selbst oder die Positionen (0 für die erste Zutat). Fehlt das alles, rät die App weiter über den Wortvergleich. Reine Texte bleiben gültig, beides darf gemischt werden.

## Neu in v17

Die Kopfzeile im Rezept trägt nur noch Zurück und Kochmodus. Einplanen und Anpassen stehen als Chips unter dem Titel.

Im Kochmodus stehen die Mengen unter dem Schritt. Die App vergleicht die Wörter des Schritttextes mit den Zutatennamen und zeigt nur die Zutaten, die in diesem Schritt vorkommen, in der Menge der gewählten Portionen. Der Zutaten-Knopf mit der vollständigen Liste bleibt.

Die Seite lässt sich nicht mehr seitlich verschieben, lange Rezeptnamen brechen jetzt um, statt die Karten aufzudehnen. Das Zusammenkneifen zum Zoomen wird abgefangen. Wer größere Schrift will: Reiter Daten, Abschnitt Darstellung, drei Stufen.

## Neu in v16

Kochmodus zusätzlich als Knopf oben in der Kopfzeile des Rezepts, neben Einplanen und Anpassen.

Einplanen direkt aus dem Katalog: jede Rezeptkarte hat unten rechts "+ Einplanen". Darauf ein Blatt mit den nächsten vierzehn Tagen und den vier Mahlzeiten, zwei Tipper, fertig. Ist die Mahlzeit schon belegt, steht das vorher da.

Zweite Ansicht in der Planung, umschaltbar oben: "Wochenblatt". Zeigt die geplante Woche von der ersten bis zur letzten Mahlzeit als durchgehende Liste von Rezeptkarten, mit Vorkoch-Block oben, Tagesüberschriften, Portionen, Zeiten, Nährwerten, aufklappbaren Zutaten in der geplanten Menge und einem direkten Weg in den Kochmodus.

## Neu in v14, Planung

Ein Tag ist jetzt eine Karte mit vier Mahlzeiten. Datum im Kalender antippen, die Karte erscheint mit Frühstück, Mittag, Abend und Snack. Die Zeile antippen, Rezept wählen, fertig. Kein Anlegen einzelner Mahlzeiten mehr, kein Sammeln von Karten.

Die Meal-Prep-Liste ist ersatzlos weg. Vorkochen wird abgeleitet: steht dasselbe Gericht an zwei Stellen der Woche, rechnet die App zusammen, wie viel du am ersten Termin kochst, prüft anhand von `prep.haltbar_tage`, ob es bis zum zweiten Termin frisch bleibt, und schlägt sonst das Gefrierfach vor. Im Kopiertext steht das unverändert als `Meal Prep: Name xN`.

Der gespeicherte Plan wird beim ersten Start automatisch in die neue Form gebracht. Standen zwei Gerichte für dieselbe Mahlzeit am selben Tag, bleibt das erste. Mahlzeiten ohne erkennbares Datum entfallen, die Planung ist jetzt durchgehend datumsbasiert.

## Neu in v13, Timer

Der Timer rechnet mit einem Endzeitpunkt statt mit einem herunterzählenden Zähler. Er stimmt deshalb auch dann, wenn das Display zwischendurch aus war oder die App geschlossen wurde. Die Anzeige ist groß, im Kochmodus füllt sie die halbe Breite, außerhalb läuft eine Leiste am unteren Rand mit.

Was nicht geht: ein Wecker bei dunklem Bildschirm. Eine Website darf auf dem iPhone nicht im Hintergrund laufen und nichts auf dem Sperrbildschirm anzeigen, unabhängig davon, wie die App gebaut ist. Für einen echten Wecker gibt es den Knopf "iPhone-Uhr" im Kochmodus. Der ruft einen Kurzbefehl namens `Küchentimer` auf, den du einmal selbst anlegen musst:

1. Kurzbefehle öffnen, neuer Kurzbefehl, Name `Küchentimer`.
2. Aktion "Timer starten" hinzufügen, als Dauer die Kurzbefehl-Eingabe wählen, Einheit Minuten.
3. Fertig. Der Name muss genau stimmen, sonst findet iOS ihn nicht.

Anderer Name gewünscht: in `app.js` ganz oben steht `SHORTCUT_NAME`.

## Neu in v12

Reste- und Brotzeit-Tage im Kalender, Portionen pro Mahlzeit in halben Schritten, Sicherung der lokalen Daten, Erkennung, wenn sich ein Rezept in `rezepte.json` unter einer eigenen Anpassung verändert hat, Anzeige des Dateistands.

Dazu drei optionale Felder, die die App liest, sobald sie in `rezepte.json` stehen:

    "zeit_aktiv": 15,      Minuten aktive Arbeit
    "zeit_gesamt": 40,     Minuten von Anfang bis Teller
    "salz_g": 1.8          Gramm Salz pro Portion

Fehlen sie, liest die App wie bisher das Freitextfeld `zeit` und sagt zum Salz nichts.
Optional ist auch eine neue Dateiform: statt der blanken Liste ein Objekt mit `stand` und `rezepte`. Beides wird gelesen, die blanke Liste bleibt gültig.

## Neu in v10

Drei Reiter statt zwei: Katalog, Planung, Daten. Der farbige Streifen an der Rezeptkarte steht jetzt für die Mahlzeit, nicht mehr für Tags, das Typ-Abzeichen daneben hat dieselbe Farbe. Rezepte lassen sich in der App anpassen, Mengen, Zutaten, Schritte, Basis und eine eigene Notiz. Diese Änderungen liegen als getrennte Ebene auf dem Gerät und legen sich beim Laden über `rezepte.json`, die Datei selbst bleibt unangetastet und kann jederzeit ausgetauscht werden. Im Reiter Daten gibt es beides zurück: einen kurzen Textblock für den Chat und die vollständige Datei zum Herunterladen.

Dazu: Wochenwächter für Ausnahmegerichte, salzige Tags, Doppelplanung und kürzlich Gekochtes. Reste-Anzeige. Gekocht-Haken mit Urteil und Rückblick-Text. Zutaten-Rohliste der Woche. Schnellfilter unter 20 Minuten. Teilen-Knopf. Notizen und Quellen sind eingeklappt, die Schrittnummer sitzt auf Höhe der ersten Textzeile.

Neues Feld: `notiz_eigen`. Steht nicht im bisherigen Schema von `rezepte.json`, taucht aber nur auf, wenn du eine eigene Notiz schreibst.

## Neu in v9

Die Planung läuft jetzt über einen mitlaufenden Kalender: zwei Wochen im Blick, Tag antippen, Kategorie wählen, fertig. Jede Mahlzeit hat eine Kategorie (Frühstück, Mittag, Abend, Snack), die Rezeptauswahl sortiert passende Gerichte nach oben. Der Meal-Prep-Bereich zeigt nur noch die tatsächlich gewählten Gerichte, dazu Vorschläge und ein Suchfeld über den kompletten Rezeptspeicher, und trennt frische von eingefrorenen Portionen. Im Kochmodus gibt es Timer, die die Minutenangaben aus dem Schritttext übernehmen.

Der Kopiertext bleibt kompatibel. Neu ist nur eine Kategorie in Klammern hinter dem Tag, und die erscheint nur, wenn es nicht Abendessen ist:

    Mi 19.08.: Kritharaki-Salat (Sporttag)
    Do 20.08. (Mittag): Linsen-Bolognese

## Was in v8 repariert wurde

Der schwerste Fehler lag in der CSS: die Klasse `.hidden` war nirgends definiert und `.overlay` hatte keine Positionierung. Die Detailansicht öffnete sich damit nicht als Vollbild, sondern unterhalb des Katalogs im normalen Seitenfluss, in heller Schrift auf hellem Grund, und der Zurück-Knopf schloss sie nie. Dazu kamen ein Service Worker, der `rezepte.json` nie vorab gespeichert hat, ein Import, dessen Ergebnismeldung sofort wieder verschwand, und ein Meal-Prep-Bereich, der importierte Einträge mitzählte, aber nicht anzeigte. Die vollständige Liste steht im Chat.

Alle Dateien wurden gegen die aktuelle `rezepte.json` durchgetestet: jedes Rezept einmal geöffnet, Kochmodus gestartet, Import und Kopiertext im Rundlauf geprüft.

## Aufbau

Keine Unterordner. Alle Dateien liegen im selben Verzeichnis, App-Code und Manifest verweisen ohne Präfix. Der Dateiname `rezepte.json` steht nur noch an zwei Stellen, jeweils als Konstante ganz oben in `app.js` und in `service-worker.js`.

## Deploy

1. Im Repo `smt-esz/futterassi` die geänderten Dateien ersetzen: `index.html`, `style.css`, `app.js`, `service-worker.js`, `manifest.json`, `README.md`.
2. Die fünf Icon- und vier Splash-Dateien bleiben unverändert liegen.
3. Commit. Nach ein bis zwei Minuten aktualisiert sich https://smt-esz.github.io/futterassi/ automatisch.
4. Falls das Handy die alte Version im Cache hat: App vom Homescreen löschen und über Safari neu "Zum Home-Bildschirm" hinzufügen.

## Rezepte aktualisieren

Neue `rezepte.json` aus dem Chat direkt im Root ersetzen. `CACHE_NAME` in `service-worker.js` bei jeder Aktualisierung um eins erhöhen, aktuell `futterassi-v22`.

Der Service Worker holt die Rezeptdaten immer zuerst aus dem Netz, eine neue Datei kommt also ohne Versionssprung an, sobald die App online geöffnet wird. Der Versionssprung ist nur für Änderungen an HTML, CSS oder JS nötig.

## Offene Punkte

- Die `rezepte.json` im Repo enthält 37 Rezepte, im Chat-Projekt liegen 49. Die neuere Datei muss noch hochgeladen werden.
- Die Google-Schriften werden nicht mit gecacht. Beim ersten Start ohne Netz greift die Rückfallschrift des Systems, das Layout bleibt gleich.
- Zwischen den Geräten wird nichts synchronisiert, das ist Absicht. Die Wochenplanung liegt in `localStorage` und gilt nur für das Gerät, auf dem sie eingegeben wurde.
