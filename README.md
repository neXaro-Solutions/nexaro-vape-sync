# neXaro VAPE Sync 10.4.0

Separate sync component for the neXaro CRM. The existing CRM is not modified by this package.

## Search strategy
After dealer login, the sync searches the dealer area for:
- ELFBAR
- ELFA
- LOST MARY
- ELFLIQ

It follows search-result pagination up to `MAX_SEARCH_PAGES` per term, removes duplicates, and keeps only these four neXaro groups:
- Einwegzigaretten
- Prefilled Pods
- Zubehör
- ELFA Liquid

Only products matching the requested brands are retained. Dealer credentials are read exclusively from GitHub Actions Secrets. No credentials are committed to the repository.

## Outputs
`out/products.json`, `out/summary.json`, `out/diagnostics.json` are uploaded as a workflow artifact and are not committed to the public repository.

## Required GitHub Secrets
- `DEALER_USER`
- `DEALER_PASSWORD`

Optional selector secrets are supported if the shop changes its form markup.
