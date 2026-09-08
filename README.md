# neXaro VAPE Sync 9.0.0

Separate GitHub Actions sync component for the neXaro VAPE catalog. The existing CRM is not modified.

## Search scope
The dealer portal is searched by manufacturer/brand terms:
- ELFBAR
- ELFA
- LOST MARY
- ELFLIQ

Only these neXaro groups are retained:
- Einwegzigaretten
- Prefilled Pods
- Zubehör
- ELFA Liquid

## V9 classification
V9 keeps the manufacturer search as the primary discovery method, but does not rely only on the product name. It carries the search term into every candidate and reads visible category/breadcrumb/page context. Brand matches that remain ambiguous are opened on their product detail pages so category/breadcrumb information can be used before filtering.

Duplicates are removed before the result is written.

## Security
Dealer credentials are read only from GitHub Actions Secrets (`DEALER_USER`, `DEALER_PASSWORD`). Do not commit credentials or private dealer price data.

The workflow uploads only `out/products.json`, `out/summary.json`, and `out/diagnostics.json` as a short-lived GitHub Actions artifact. No cookies, screenshots or HTML dumps are uploaded.

No CAPTCHA/2FA bypass is implemented.

## Run
GitHub → Actions → neXaro VAPE Sync → Run workflow.

The existing neXaro CRM is intentionally not touched by this component.
