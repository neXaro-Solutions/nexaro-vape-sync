# neXaro VAPE Sync 1.4.0

Separate sync component for the neXaro VAPE module. The existing CRM is not modified.

## Scope
Only these groups are accepted:
- Einwegzigaretten
- Prefilled Pods
- Zubehör
- ELFA Liquid

## 1.4 improvements
- Uses Node.js 24 in GitHub Actions.
- Automatically discovers likely category links after login when PRODUCT_URL is not configured.
- Tries multiple common product-card structures instead of one generic selector.
- Writes a safe `out/diagnostics.json` with URL/path, DOM selector counts, login markers, discovered category paths, and counts.
- Does not upload HTML dumps, screenshots, cookies, or credentials.
- Product result is written to `out/products.json` and uploaded as a workflow artifact.

## Secrets
Required:
- DEALER_USER
- DEALER_PASSWORD

Optional:
- DEALER_LOGIN_URL
- PRODUCT_URL
- LOGIN_USER_SELECTOR
- LOGIN_PASSWORD_SELECTOR
- LOGIN_SUBMIT_SELECTOR

No credentials are stored in code.
