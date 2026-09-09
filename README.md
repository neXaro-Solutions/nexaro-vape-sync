# neXaro VAPE Sync 2.1 – Händler-Erstabgleich

Separater Sync für E-ZIGARETTEN-HANDEL.DE. Das bestehende neXaro-CRM wird nicht verändert.

## Zweck
Der erste Lauf besucht nach dem Login die relevanten Produkt-/Kategorieseiten, öffnet Produktdetailseiten und liest dort – sofern vorhanden – echte Händlerdaten aus:
- Artikel-Nr.
- EAN
- Produktname
- Preis
- Verfügbarkeit/Lieferzeit
- Produktbild

Der vorhandene neXaro-Produktstamm bleibt die Masterliste. Die bisher vergebenen ART-001 usw. werden nur als alte Quellreferenz behandelt und **nicht** als Händler-Schlüssel verwendet.

## Zuordnung
1. Artikel-Nr./EAN werden aus dem Händlerdetail ausgelesen und in `mapping.json` gespeichert.
2. Die erste Produktzuordnung erfolgt konservativ über normalisierten Produktnamen/Kategorie.
3. Hohe Treffer werden als `AUTO_MATCH` markiert.
4. Mittlere Treffer werden als `REVIEW` markiert.
5. Niedrige Treffer bleiben `UNMATCHED`.
6. Bei doppelter Zuordnung wird nicht automatisch überschrieben.

Es gibt keinen Schreibzugriff auf das bestehende CRM.

## Secrets
- `DEALER_USER`
- `DEALER_PASSWORD`

Keine Zugangsdaten in Code, CSV oder Artefakten.

## Start
`npm install`
`npx playwright install --with-deps chromium`
`DEALER_USER=... DEALER_PASSWORD=... npm run sync`

## Ergebnis
- `out/summary.json`
- `out/mapping.json`
- `out/dealer-products.json`
- `out/master-normalized.json`

## Wichtig
CAPTCHA/2FA wird nicht umgangen. Wenn der Händlerbereich eine solche Prüfung verlangt, muss sie regulär abgeschlossen bzw. technisch separat unterstützt werden.
