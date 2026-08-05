# 3D Gaussian Splatting Viewer

**[Live-Demo ansehen: https://gkvoelkl.github.io/js-3dgs/](https://gkvoelkl.github.io/js-3dgs/)**

Ein Browser-Viewer für 3D-Scans im Gaussian-Splatting-Format – aufgenommen mit dem iPhone, angezeigt ohne Installation direkt im Browser.

---

## Was ist 3D Gaussian Splatting?

Stellen Sie sich vor, Sie fotografieren einen Ort aus vielen Blickwinkeln. Klassische Verfahren erzeugen daraus eine **Punktwolke** – Millionen einzelner Punkte im Raum, jeder mit einer Farbe. Das Ergebnis sieht aus wie ein Sandhaufen: erkennbar, aber körnig und ohne echte Oberfläche.

**3D Gaussian Splatting** macht etwas Cleveres: Statt Punkten entstehen kleine, unscharfe Ellipsen (sogenannte _Gaussians_) – jede mit einer eigenen Farbe, Transparenz, Größe und Ausrichtung. Zusammen ergeben sie ein Bild, das wirkt wie ein echtes Foto – weich, detailreich, lebendig.

| Punktwolke          | 3D Gaussian Splatting   |
| ------------------- | ----------------------- |
| Nur einzelne Punkte | Weiche 3D-Ellipsen      |
| Wirkt körnig        | Wirkt fotorealistisch   |
| Einfach zu erzeugen | Braucht KI-Training     |
| Wenig Speicher      | Kompakter als man denkt |

---

## Wie entstehen die Scans?

Die Szenen in diesem Viewer wurden mit einem **iPhone** und der App **[Scaniverse](https://scaniverse.com)** aufgenommen.

So funktioniert's:

1. App starten, Objekt oder Raum langsam umrunden
2. Scaniverse nimmt automatisch Fotos aus allen Winkeln
3. Die App berechnet daraus das 3D-Modell per KI
4. Export als `.spz`-Datei – fertig

Das Besondere: Früher brauchte man dafür eine Workstation und Stunden Rechenzeit. Heute erledigt das ein Smartphone in der Hosentasche.

---

## Das Format SPZ – was steckt dahinter?

`.spz` ist ein kompaktes Dateiformat speziell für Gaussian Splatting, entwickelt von Niantic (den Machern von Pokémon GO).

**Warum nicht einfach `.ply`?**

Das klassische Format für Gaussian-Splat-Daten ist `.ply` – aber eine einzige Szene kann dort schnell **mehrere hundert Megabyte** groß werden. SPZ löst das:

- Komprimiert die Daten deutlich (**5–10× kleiner** als PLY)
- Nutzt intern **gzip-Kompression**
- Verliert dabei kaum sichtbare Qualität
- Ideal für das Web – kurze Ladezeiten, wenig Speicher

Der Viewer unterstützt sowohl `.spz` als auch `.ply`.

---

## Lokal starten

Kein Build-Schritt, kein Node.js notwendig. Sie brauchen nur einen lokalen Webserver, weil Browser das Laden lokaler Dateien blockieren.

**Mit Python (empfohlen):**

```bash
# Repository klonen
git clone https://github.com/gkvoelkl/js-3dgs.git
cd js-3dgs

# Webserver starten
python3 -m http.server 8080
```

Dann im Browser öffnen: `http://localhost:8080`

**Mit Node.js:**

```bash
npx serve .
```

---

## Eigene Scans hinzufügen

Scaniverse-Export: App → Scan auswählen → **Teilen** → **Gaussian Splat (.ply)** → per AirDrop auf den Mac übertragen.

Für kleinere Dateien kann die `.ply` mit [SuperSplat](https://playcanvas.com/supersplat) in `.spz` konvertiert werden (bis zu 10× kleiner).

Dann:

1. `.spz`- oder `.ply`-Datei in den Ordner `scans/` legen
2. Optional: Vorschaubild (z. B. `images/mein-scan.png`) ablegen
3. In `scans.json` einen Eintrag ergänzen:

```json
{
  "name": "Mein Scan",
  "description": "Kurze Beschreibung",
  "file": "scans/mein-scan.spz",
  "thumbnail": "images/mein-scan.png"
}
```

Fertig – beim nächsten Laden erscheint die Karte in der Galerie.

### Kamera-Position einstellen

Öffnen Sie den Viewer und drücken Sie **K** – dann sehen Sie die aktuellen Kamerakoordinaten live eingeblendet. Diese Werte können Sie direkt in `scans.json` übernehmen, damit der Scan immer vom richtigen Blickwinkel startet:

```json
"cameraPosition": [0.52, 1.15, 0.3],
"cameraLookAt":   [-0.19, 0.2, -0.13],
"cameraUp":       [0, 1, 0]
```

---

## Direkt auf GitHub verwenden

Dieses Projekt läuft ohne Backend – der Viewer braucht nur statische Dateien. Das macht ihn perfekt für **GitHub Pages**.

**GitHub Pages aktivieren:**

1. Repository-Einstellungen öffnen → _Pages_
2. Branch `main`, Ordner `/` (root) auswählen
3. Speichern

Nach wenigen Minuten ist die Galerie erreichbar unter:

```
https://<ihr-nutzername>.github.io/<repo-name>/
```

Für jeden zugänglich, ohne Anmeldung, kostenlos.

> **Hinweis zu großen Dateien:** GitHub hat ein Limit von 100 MB pro Datei. Für größere Scans empfiehlt sich ein externer Speicher (z. B. Cloudflare R2, Backblaze B2).

---

## Projektstruktur

```
index.html      Galerie-Übersicht mit allen Scans
viewer.html     3D-Viewer mit Orbit-Navigation
scans.json      Liste der Scans (Name, Datei, Vorschau, Kamera)
scans/          .spz- oder .ply-Dateien
images/         Vorschaubilder
```

---

## Steuerung im Viewer

| Aktion                     | Eingabe                   |
| -------------------------- | ------------------------- |
| Drehen                     | Linke Maustaste + ziehen  |
| Zoomen                     | Mausrad                   |
| Verschieben                | Rechte Maustaste + ziehen |
| Kamerakoordinaten anzeigen | Taste **K**               |

---

## Verwendete Bibliotheken

- [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) – Rendering-Engine für Gaussian Splatting im Browser
- [Three.js](https://threejs.org) – 3D-Grafik-Framework

Beide werden direkt aus dem CDN geladen – keine lokale Installation nötig.

---

## Lizenz

MIT
