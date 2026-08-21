# Futterassi App, v3

Statische PWA, kein Build-Schritt, keine Abhängigkeiten außer den Google-Font-Links. Läuft direkt als Dateien.

## v6, Splash Screen passend zum Icon

Ein Splash Screen ist das kurze Bild, das beim Antippen des App-Icons erscheint, bevor die eigentliche Oberfläche geladen ist, quasi der Startbildschirm. Vorher war das nur Text auf hellem Grund, ohne Bezug zum Icon. Jetzt: petrolfarbener Hintergrund, exakt die Farbe aus deinem Icon, das Icon-Motiv verkleinert mittig platziert, kein Text. `background_color` in manifest.json ist ebenfalls auf diese Farbe gestellt, damit auch Android beim Start nicht kurz hell aufblitzt. `CACHE_NAME` steht auf `futterassi-v6`.

## v5, dein Icon eingesetzt

Dein ChatGPT-generiertes Icon (Kalenderblatt mit Schneebesen und Schüssel, petrolfarbener Hintergrund) ist jetzt in allen fünf Größen eingesetzt, 152/167/180/192/512px, sauber skaliert, keine Transparenz, quadratisch, passt zu den Vorgaben. `theme-color` in manifest.json und index.html an die Icon-Hintergrundfarbe angeglichen (#0D5557), das färbt bei manchen Android-Browsern die Werkzeugleiste ein, iOS betrifft es kaum. Wenn dir das dunklere Grün dort nicht gefällt, sag Bescheid, dann setze ich es zurück auf die bisherige Farbe. `CACHE_NAME` steht auf `futterassi-v5`.

Splash-Screens sind unverändert, die zeigen nur den Schriftzug "Futterassi" auf hellem Grund, kein Bezug zum Icon-Motiv. Wenn du willst, dass sie farblich zum neuen Icon passen, sag Bescheid.

## Fehlerbehebung: App öffnete sich nicht (v4)

Grund, echt getestet und nicht nur vermutet: Browser blockieren `fetch()` auf lokale Dateien, sobald die Seite über `file://` statt `http://` läuft, das trat auf, wenn die heruntergeladenen Dateien direkt per Doppelklick geöffnet wurden. Das ist keine Eigenheit dieser App, das betrifft jede PWA mit externer Datenquelle. Deshalb war GitHub Pages von Anfang an nötig, nicht nur zum Installieren, sondern damit die App überhaupt starten kann.

Geändert: Fehlerbehandlung beim Laden von `data/rezepte.json`, bei einem Ladefehler zeigt die App jetzt eine klare Meldung statt einer leeren weißen Seite. `CACHE_NAME` steht auf `futterassi-v4`.

Zum Testen vor dem Deploy, falls gewünscht: im Ordner einen simplen lokalen Server starten (z.B. `python3 -m http.server 8000` im Terminal, dann `http://localhost:8000` öffnen) statt die index.html direkt zu doppelklicken. Für den täglichen Gebrauch reicht der Weg über GitHub Pages, dann stellt sich die Frage nicht mehr.

## Deploy auf GitHub Pages

1. Neues Repo anlegen, z.B. `futterassi-app`, öffentlich (GitHub Pages im kostenlosen Tarif braucht ein öffentliches Repo, außer du hast GitHub Pro/Team).
2. Alle Dateien aus diesem Ordner in den Repo-Root hochladen (per Weboberfläche geht ohne Git, per Drag-and-Drop im Browser).
3. Repo-Einstellungen, Pages, Branch main, Ordner root. Speichern.
4. Nach ein bis zwei Minuten ist die App unter `https://<dein-username>.github.io/futterassi-app/` erreichbar.
5. Auf iPhone/iPad in Safari öffnen, Teilen-Symbol, "Zum Home-Bildschirm". Auf Android in Chrome "App installieren".

## Rezepte aktualisieren

`data/rezepte.json` ist eine Kopie, keine Live-Verbindung zum Chat. Nach jeder Chat-Session, in der sich rezepte.json ändert:

1. Neue rezepte.json aus dem Chat laden.
2. Datei im Repo unter `data/rezepte.json` ersetzen.
3. In `service-worker.js` die Zahl in `CACHE_NAME` um eins erhöhen. Sonst bleibt auf dem Gerät die alte, gecachte Version stehen.
4. Commit. GitHub Pages baut automatisch neu.
5. Beim nächsten Öffnen der App zieht sie sich die neue Version.

Aktuell steht `CACHE_NAME` auf `futterassi-v3`.

## Was diese Version kann

- Katalog aller Rezepte, Suche, Filter nach den acht Projekt-Tags, raus-Status standardmäßig ausgeblendet mit Umschalter (behebt den offenen raus-Filter-Bug aus der Projektanweisung für diese App, das Python-Skript für den Wochenplaner ist davon nicht betroffen)
- Detailansicht mit portionsskalierten Zutaten, Zubereitung, Notiz, bei Ausnahmegerichten der Leichter-Umbau
- Kochmodus, ein Schritt pro Bildschirm, groß, kontraststark, dunkel
- Zutaten kopieren als Text
- Planung: Kochtage anlegen, Rezept zuweisen, Sporttag-Schalter mit Warnung bei Low Carb, Meal-Prep-Zähler mit 10-Portionen-Ziel, Kopiertext-Button für den Chat
- Import-Feld in der Planung: Plan-Text aus dem Chat einfügen (gleiches Format wie der Kopiertext), die App ordnet Zeilen automatisch Rezepten zu. Nicht erkannte Zeilen werden benannt, dann manuell über das Dropdown in der Kochtag-Karte nachtragen. Übernehmen ersetzt die bisherige Planung auf dem Gerät, mit Rückfrage.

Format für den Import:
```
Mi 19.08.: Griechischer Kritharaki-Salat (Sporttag)
Fr 21.08.: Sandwich mit veganem Chicken

Meal Prep: Weißer Bohnensalat x4
```

## Design

Farbpalette Off-White/fast schwarzer Text/Orange-Rot als Akzent/Petrol als Zweitfarbe, Bricolage Grotesque für Überschriften, IBM Plex Mono für Zahlen und Chips, farbige Kategorie-Leiste an den Karten (vegan vor vegetarisch vor Low Carb vor High Protein vor Sport, sonst keine Farbe), dunkler Kochmodus mit sehr großer Schrift. Die Topbar mit den zwei Tabs habe ich selbst ergänzt, dafür gab es keine Vorgabe.

## iPhone/iPad-Anpassungen

- App-Icons in 152/167/180/192/512px
- Splash-Screens für iPhone Standard, iPhone Pro Max, iPad Pro 11" und 12.9", verhindert weißes Aufblitzen beim Start
- apple-mobile-web-app-Metatags, App startet vom Home-Bildschirm ohne Safari-Leiste
- Kein Gummiband-Bounce beim Überscrollen, kein Copy-Menü auf Buttons/Chips, kein Doppel-Tap-Zoom-Delay
- Zwei Spalten im Katalog ab Tablet-Breite, drei ab Desktop-Breite, größere Kochmodus-Schrift auf dem iPad
- Google Fonts laden per Link beim ersten Aufruf, danach normaler Browser-Cache. Der Service Worker cacht sie nicht separat, ganz ohne vorherigen Seitenbesuch fällt die App offline auf System-Schriften zurück

## Was fehlt, bewusst

- Kein Sync zu einem zweiten Gerät. Person 1 sieht denselben Katalog und Kochmodus, aber nicht deinen Planungsstand.
- Kein Reminders-Zugriff, die Einkaufsliste entsteht weiter im Chat.
- Keine automatische Recherche neuer Kandidaten und kein Beratungsabsatz, das bleibt Chat-Arbeit.
- Öffentliche URL ohne Passwortschutz. Die Rezeptdaten enthalten Gesundheits-Tags (LEBER, BLUTDRUCK, SCHILDDRÜSE), das ist kein Geheimnis, aber auch nicht für jeden gedacht. Wenn dir das wichtig ist, sag Bescheid, dann bauen wir einen einfachen Zugriffsschutz ein.

## Bekannte Baustelle

Die App nutzt gerade die rezepte.json aus dem Projekt-Ordner mit 37 Einträgen. Laut deinem letzten Stand wurden zwei Versionen auf 46 Rezepte zusammengeführt, diese gemergte Datei aber noch nicht ins Projekt hochgeladen. Vor dem ersten Deploy die aktuelle, gemergte rezepte.json einsetzen, sonst arbeitest du mit einem veralteten Stand.
