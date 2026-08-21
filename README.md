# Futterassi App, v8, flache Struktur

## Was in dieser Runde repariert wurde

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

Neue `rezepte.json` aus dem Chat direkt im Root ersetzen. `CACHE_NAME` in `service-worker.js` bei jeder Aktualisierung um eins erhöhen, aktuell `futterassi-v8`.

Der Service Worker holt die Rezeptdaten immer zuerst aus dem Netz, eine neue Datei kommt also ohne Versionssprung an, sobald die App online geöffnet wird. Der Versionssprung ist nur für Änderungen an HTML, CSS oder JS nötig.

## Offene Punkte

- Die `rezepte.json` im Repo enthält 37 Rezepte, im Chat-Projekt liegen 49. Die neuere Datei muss noch hochgeladen werden.
- Die Google-Schriften werden nicht mit gecacht. Beim ersten Start ohne Netz greift die Rückfallschrift des Systems, das Layout bleibt gleich.
- Zwischen den Geräten wird nichts synchronisiert, das ist Absicht. Die Wochenplanung liegt in `localStorage` und gilt nur für das Gerät, auf dem sie eingegeben wurde.
