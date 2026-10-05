# Marteloio — public source manifest

Exact curated file set for the public repository: **78 files**. Only these files may
enter the public branch. Listing a file here is not by itself permission to commit,
push or publish.

Excluded: `.git` history from the private working repository, internal agent and handoff
records (`HANDOFF.md`, `PROJECT-ASSESSMENT.md`, `CODEX-EXECUTION-PROTOCOL.md`), personal
configuration and credentials (`.env`, `.marteloio-secrets.enc`, `.lanzalister-secrets.enc`,
`.ebay_token.json`), logs (`relay.log`, `httpserver.log`, `router.log`), caches
(`__pycache__/`), `Claude outputs/` and brand working files outside the repository.
Ignored secret files must not be opened, copied or hashed.

The Marteloio name and logo are reserved (see `TRADEMARKS.md`). Screenshots in
`docs/screenshots/` were captured from the app with made-up items and mocked services. Tests use synthetic data and never contact AI providers or eBay.

## Exact files

- `.env.example`
- `.gitattributes`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/workflows/checks.yml`
- `.gitignore`
- `LICENSE`
- `PUBLIC_SOURCE_MANIFEST.md`
- `README.md`
- `SECURITY.md`
- `TRADEMARKS.md`
- `ai_providers.py`
- `assets/brand/marteloio-dark-64.png`
- `assets/brand/marteloio-dark.png`
- `assets/brand/marteloio-light-64.png`
- `assets/brand/marteloio-light.png`
- `assets/brand/marteloio.ico`
- `assets/fonts/OFL-Manrope.txt`
- `assets/fonts/OFL-SpaceGrotesk.txt`
- `assets/fonts/manrope-latin-ext-wght-normal.woff2`
- `assets/fonts/manrope-latin-wght-normal.woff2`
- `assets/fonts/space-grotesk-latin-ext-wght-normal.woff2`
- `assets/fonts/space-grotesk-latin-wght-normal.woff2`
- `create-shortcuts.bat`
- `create-shortcuts.ps1`
- `docs/.nojekyll`
- `docs/GUIDE.md`
- `docs/assets/favicon.svg`
- `docs/assets/fonts/OFL-Manrope.txt`
- `docs/assets/fonts/OFL-SpaceGrotesk.txt`
- `docs/assets/fonts/manrope-latin-ext-wght-normal.woff2`
- `docs/assets/fonts/manrope-latin-wght-normal.woff2`
- `docs/assets/fonts/space-grotesk-latin-ext-wght-normal.woff2`
- `docs/assets/fonts/space-grotesk-latin-wght-normal.woff2`
- `docs/assets/readme-header-dark.png`
- `docs/assets/readme-header-light.png`
- `docs/assets/social-preview.png`
- `docs/index.html`
- `docs/screenshots/app-bundle-dark.webp`
- `docs/screenshots/app-bundle-light.webp`
- `docs/screenshots/app-dark.webp`
- `docs/screenshots/app-light.webp`
- `docs/screenshots/bundle-dark.webp`
- `docs/screenshots/bundle-light.webp`
- `docs/screenshots/listing-dark.webp`
- `docs/screenshots/listing-light.webp`
- `docs/screenshots/listing-phone.webp`
- `docs/screenshots/lookup-dark.webp`
- `docs/screenshots/lookup-light.webp`
- `docs/screenshots/templates-dark.webp`
- `docs/screenshots/templates-light.webp`
- `index.html`
- `launch.py`
- `listing-core.js`
- `relaunch.bat`
- `server.py`
- `start-all.bat`
- `start-all.sh`
- `stop-services.ps1`
- `stop.bat`
- `tests/frontend-regressions.js`
- `tests/serve_frontend_checks.py`
- `tests/test_ai_providers.py`
- `tests/test_barcode_search.py`
- `tests/test_completion_capacity.py`
- `tests/test_create_shortcuts.ps1`
- `tests/test_env_paths.py`
- `tests/test_http_rejections.py`
- `tests/test_launch.py`
- `tests/test_listing_core.js`
- `tests/test_oauth_tokens.py`
- `tests/test_outbound_requests.py`
- `tests/test_product_reference.py`
- `tests/test_provider_failures.py`
- `tests/test_provider_storage.py`
- `tests/test_search_concurrency.py`
- `tests/test_stop_services.ps1`
