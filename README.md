# Snake — Java Web Edition

Ein klassisches Snake-Spiel als Webapplikation. Die komplette Spiellogik läuft
**serverseitig in Java**, der Browser ist nur für Darstellung und Eingabe
zuständig. Es werden **keine externen Bibliotheken** benötigt — nur das JDK
(Java 21+).
Der HTTP-Server ist der im JDK enthaltene `com.sun.net.httpserver`.

## Starten

```bash
./run.sh
```

Danach im Browser öffnen: <http://localhost:8080>

Anderer Port:

```bash
./run.sh --port 9090
```

### In IntelliJ IDEA

Das Projekt ist bereits als IDEA-Modul eingerichtet (`src` ist Source-Root).

1. `src/snake/Main.java` öffnen
2. `Main` starten — Arbeitsverzeichnis muss der Projektordner sein
   (Standard bei der generierten Run-Configuration)
3. <http://localhost:8080> aufrufen

## Steuerung

| Taste | Funktion |
| --- | --- |
| Pfeiltasten / WASD | Richtung |
| Leertaste | Start / Pause / Weiter |
| R | Neustart |
| P | Pause |

Auf Touch-Geräten gibt es ein Steuerkreuz und Wisch-Gesten auf dem Spielfeld.

## Spielregeln

- Jeder Apfel gibt einen Punkt, die Schlange wächst und wird schneller.
- Wände und der eigene Körper bedeuten Game Over.
- Pro 5 Äpfel steigt das Level.
- Der Rekord gilt für alle Spiele, solange der Server läuft.

## Architektur

```
src/snake/Main.java         HTTP-Server, Routing, statische Dateien, JSON-API
src/snake/Game.java         Spiellogik (Bewegung, Kollisionen, Futter, Punkte)
src/snake/GameService.java  Spiele-Verwaltung, Ticker (15 ms), SSE-Push
web/index.html              Oberfläche
web/style.css               Styling
web/game.js                 Canvas-Rendering, Eingaben, SSE, Sound
```

Der Server ist autoritativ: Er simuliert alle Spiele in einem eigenen
Ticker-Thread. Neue Zustände werden per **Server-Sent Events** sofort an den
Browser geschoben (früher: Alle 60 ms per HTTP abfragen – das kostete bis zu
60 ms Verzögerung). Polling alle 400 ms ist nur noch Fallback, wenn SSE nicht
verfügbar ist. Richtungswechsel gehen als POST direkt an den Server; Lese-
und Schreib Requests laufen in getrennten Queues, damit Eingaben nicht hinter
einem laufenden Poll warten. Der Client interpoliert die Bewegung passend zur
jeweiligen Schrittgeschwindigkeit.

Für flüssiges Rendering werden Hintergrund/Gitter, Apfel und Kopfglow nur
einmal pro Größe in Offscreen-Canvases gezeichnet. Pro Frame bleiben im
Wesentlichen `drawImage` und einfache Pfade – keine teuren Gradienten oder
`shadowBlur`-Effekte mehr. Zusätzlich wurde das Food-Spawning von einer
O(Feldfläche × Schlangenlänge)-Suche auf Zufallsproben umgestellt, damit
lange Schlangen keine Hitches mehr erzeugen.

### API

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `POST` | `/api/games` | Neues Spiel anlegen |
| `GET` | `/api/games/{id}` | Aktuellen Zustand abrufen |
| `POST` | `/api/games/{id}/start` | Spiel starten |
| `POST` | `/api/games/{id}/pause` | Pause an/aus |
| `POST` | `/api/games/{id}/restart` | Neu starten |
| `POST` | `/api/games/{id}/direction?dir=UP` | Richtung setzen |
| `GET` | `/api/games/{id}/events` | Zustand als SSE-Push (Text/Event-Stream) |

Alle Endpunkte antworten mit dem vollständigen Spielzustand als JSON:

```json
{
  "id": "a1b2c3d4e5f6",
  "width": 23,
  "height": 23,
  "status": "RUNNING",
  "version": 17,
  "stepMs": 133,
  "score": 3,
  "highScore": 12,
  "level": 1,
  "won": false,
  "direction": "RIGHT",
  "food": [17, 9],
  "snake": [[11, 11], [10, 11], [9, 11], [8, 11]]
}
```
