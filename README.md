# neXaro VAPE Sync 1.1.0

Separate backend component for synchronizing the dealer portal into the neXaro VAPE catalog.

## Important separation
- This component does NOT modify the existing neXaro CRM.
- No CRM localStorage access.
- No CRM source files are required.
- Dealer credentials stay in server environment variables and are never returned by the API.
- Do not commit `.env` to GitHub.

## Included VAPE groups
Exactly these four groups are accepted:
1. Einwegzigaretten
2. Prefilled Pods
3. Zubehör
4. ELFA Liquid / ELFLIQ

Akkuträger and all other groups are excluded.

## Current portal basis
The public dealer homepage exposes a login with Kundennummer/Passwort and advertises Zubehör and ELFBAR ELFLIQ among its catalog areas. The exact authenticated product DOM can differ, so selectors remain configurable.

## Start
```bash
npm install
npx playwright install chromium
cp .env.example .env
# edit .env locally; never commit it
npm start
```

Health check: `GET http://localhost:8787/health`

Sync: `POST http://localhost:8787/sync`

Filter test: `POST http://localhost:8787/filter` with `{ "items": [...] }`

## Safety
No CAPTCHA/2FA bypass is implemented. If the dealer portal requires additional authentication, complete the portal's normal authentication flow or configure the supported selectors.
