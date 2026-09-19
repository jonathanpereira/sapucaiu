# Aufgabe: Prototyp zu produktiver App umbauen

Du arbeitest im Repository `jonathanpereira/sapucaiu`. Im Root liegt `index.html` — ein
kompilierter, in sich geschlossener HTML-Prototyp einer Web-App für die Berliner
Sambaschule "Sapucaiu no Samba". Er läuft bereits über GitHub Pages.

**Arbeite in zwei Phasen: erst planen, dann ausführen.** Lies zuerst `index.html`
vollständig, stelle mir Rückfragen wo nötig, und leg mir einen Plan vor. Baue erst
nach meinem OK.

---

## Was der Prototyp kann (Ist-Zustand)

Eine responsive Website auf Deutsch, mobile-first. Der Header enthält Logo und Namen
(führen zur Veranstaltungsliste), die Navigation nur "Alle Veranstaltungen"; der
Organisator-Modus liegt als dezenter Link im Footer.

1. **Namensauswahl** — Liste aller Mitglieder mit Suchfeld; die Auswahl merkt sich die
   Person und erscheint als Chip rechts im Header (Klick auf das × wechselt den Namen).
   "Neu hier?" legt ein Mitglied an — **nur Vor- und Nachname**, Pflichtfeld, der Button
   bleibt sonst deaktiviert. Ob jemand tanzt oder trommelt, wird pro Event entschieden.
2. **Veranstaltungen** — Tabs "Nächste" / "Vergangene", Karten mit Datum, Titel, Ort
   und Zusagen-Zähler.
3. **Veranstaltungsdetail** — der wichtigste Screen:
   - Grüner Infoblock, standardmäßig eingeklappt hinter "Alle Infos anzeigen":
     Treffpunkt (mit "Karte öffnen"-Link, wenn eine Google-Maps-URL hinterlegt ist),
     Ankunft, Showtime, Outfit, Setlist, **Hinweise** (freies Textfeld der Organisation,
     Zeilenumbrüche bleiben erhalten).
   - Button "Wer kommt mit?" mit Live-Zählung (Ja · Vielleicht · Nein · offen), führt
     zur Übersicht.
   - Ja / Nein / Vielleicht plus Kommentarfeld.
   - "Was machst du hier?" — Tanz und/oder Bateria (beides gleichzeitig möglich), bei
     Bateria Mehrfachauswahl der Instrumente. **Pro Event gespeichert**, vorbelegt mit
     der letzten Wahl der Person.
   - Liste der Probentermine, je mit Ja/Nein/Vielleicht.
   - Abschluss-Button "Speichern", der zur Übersicht führt.
4. **Übersicht** — alle Mitglieder des Events mit Rolle, Instrumenten, Antwort und
   Probenpunkten; Filter-Chips Alle / Ja / Vielleicht / Nein / Offen mit Anzahl;
   Zurück-Link zum Event. Nur lesen.
5. **Organisator-Modus** — hinter PIN. Eventliste, Event anlegen/bearbeiten (Titel,
   Datum, Ankunft, Showtime, Ende, Ort, Treffpunkt, Maps-Link, Outfit, Setlist-Link,
   Hinweise), Probentermine mit Datum, Uhrzeit und Ort anlegen/bearbeiten/löschen.

Instrumente: Tamborim, Caixa, Repinique, Surdo 1a, Surdo 2a, Surdo 3a, Agogô, Ripa,
Chocalho, Cuíca, Timbal.

Alle Daten sind derzeit Arrays im JavaScript (`MEMBERS`, `EVENTS`) und der State geht
beim Reload verloren.

## Ziel

Dieselbe App, aber mit echter Persistenz: alle Mitglieder sehen dieselben Daten,
Antworten bleiben erhalten, Organisatoren pflegen Events online.

## Vorgaben

- **Hosting bleibt GitHub Pages** (statisch, kein eigener Server).
- **Datenbank: Supabase** (kostenloses Tier, Postgres + JS-Client direkt aus dem Browser).
- **Kein Build-Step**, wenn es sich vermeiden lässt — ES-Module und der Supabase-CDN-Client
  reichen. Kein npm-Bundler, kein Framework-Umbau.
- **Das Design nicht verändern.** Farben, Abstände, Typografie, Copy und Layout bleiben
  exakt wie im Prototyp. Du ersetzt nur die Datenschicht.

## Schritt 1 — Repository umstrukturieren

`index.html` ist eine kompilierte Einzeldatei und so nicht wartbar. Zerleg sie in:

```
index.html        Markup + Styles
app.js            UI-Logik und Rendering
db.js             alle Supabase-Aufrufe, sonst nichts
config.js         Supabase-URL und anon-Key
assets/logo.png   bleibt
```

Nach diesem Schritt muss die App **exakt wie vorher** aussehen und funktionieren
(noch mit den Arrays als Daten). Erst wenn das steht, weiter.

## Schritt 2 — Datenmodell in Supabase

Leg das Schema als SQL-Migration im Repo ab (`supabase/schema.sql`), damit es
nachvollziehbar ist.

- `members` — id, name, created_at
- `events` — id, title, date, place, treffpunkt, maps_url, ankunft, showtime, ende,
  outfit, setlist_url, hinweise (text), created_at
- `rehearsals` — id, event_id, date, time, place
- `event_signups` — id, member_id, event_id, response (ja/nein/vielleicht),
  comment, does_tanz (bool), does_bateria (bool), instruments (text[]), updated_at —
  unique auf (member_id, event_id)
- `rehearsal_attendance` — id, member_id, rehearsal_id, response —
  unique auf (member_id, rehearsal_id)

Beim Löschen eines Events müssen Proben, Zusagen und Anwesenheiten mitgehen
(`on delete cascade`).

## Schritt 3 — Datenschicht anbinden

Ersetze die Arrays durch Supabase-Abfragen. Beachte:

- Antworten sollen sofort sichtbar sein (optimistisches Update), Fehler sichtbar melden.
- Der gewählte Name gehört in `localStorage`, damit man nicht bei jedem Besuch
  neu auswählen muss.
- "Vergangene" vs. "Nächste" nicht als Flag speichern, sondern aus dem Datum ableiten.
- Realtime ist nice-to-have, nicht Pflicht. Wenn einfach: Übersicht per
  Supabase-Realtime aktualisieren.
- Die Supabase-URL und der anon-Key dürfen im Quelltext stehen (dafür sind sie gedacht),
  aber leg sie in `config.js`, damit sie leicht austauschbar sind.

## Schritt 4 — Zugriffsschutz

Der PIN im Prototyp ist reine Kosmetik — im statischen Quelltext lesbar. Schlag mir
beide Wege vor und empfiehl einen:

- **A)** PIN bleibt als UI-Hürde, aber die Schreibrechte für Events und Proben hängen an
  Supabase Auth (Organisator-Login per Magic Link); Row Level Security erlaubt allen
  anderen nur Lesen plus Schreiben der eigenen Zeile.
- **B)** PIN ganz raus, Organisatoren loggen sich per E-Mail-Magic-Link ein.

In jedem Fall: **RLS auf allen Tabellen aktivieren.** Ohne RLS ist der anon-Key eine
offene Tür.

## Schritt 5 — PWA und Deployment

- `manifest.webmanifest` mit dem Logo als Icon (192 und 512 px), Theme-Farbe `#ed7f07`,
  Hintergrund `#f9f3e7`, `display: standalone`, deutschsprachiger Name.
- Service Worker, der die Shell cached, damit die App offline startet — Daten selbst
  dürfen online bleiben.
- GitHub Action, die bei jedem Push auf `main` nach Pages deployt.

---

## Definition of done

- Zwei verschiedene Personen können auf zwei Geräten zusagen und sehen sich gegenseitig
  in der Übersicht.
- Ein Organisator legt ein Event mit drei Probenterminen an; es erscheint bei allen
  unter "Nächste".
- Nach Reload ist alles noch da.
- Die App ist auf dem Handy installierbar.
- Das Design ist unverändert.

Fang mit dem Plan an.
