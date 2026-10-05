# Security and privacy

## Reporting

Prefer GitHub private vulnerability reporting when it is available on this repository.
Otherwise contact the repository owner through a private channel you already know.
Do not post sensitive details in a public issue. No security-report email address or
response-time guarantee is currently established.

## Official sources

Get Marteloio only from [github.com/browser-b0X/marteloio](https://github.com/browser-b0X/marteloio)
or its website, [browser-b0x.github.io/marteloio](https://browser-b0x.github.io/marteloio/).
The MIT License lets anyone publish a modified copy, but not under the Marteloio name or logo
(see [TRADEMARKS.md](TRADEMARKS.md)). Treat a "Marteloio" download from anywhere else as
untrusted, and never give an unofficial copy your AI or eBay keys. If you find one, please
report it.

## Sensitive files

Do not publicly attach:

- `.env`, `.marteloio-secrets.enc`, `.ebay_token.json` or any other file holding keys
  or tokens;
- AI provider keys, eBay Client ID/Secret, RuName, authorization codes or redirect URLs
  containing them;
- `relay.log` before you have read and redacted it;
- draft backup files or screenshots containing real items, seller details or statistics
  you don't want public.

Reproduce bugs with a made-up item and redacted details.

## Security model

Marteloio is a local, single-user application. A small Python relay serves the interface
on the loopback address only and checks the Host and Origin of every request; sensitive
requests also need a per-session token. There is no Marteloio account or server, and the app
loads no remote scripts, fonts or analytics.

On Windows, keys saved in Settings are encrypted with DPAPI for the current Windows account.
This protects them at rest from other accounts, not from programs running as you, and it is
not a defence against a compromised Windows account. Without DPAPI, keys and eBay tokens
are stored in plain text (`.env`, `.ebay_token.json`) with normal file permissions. Keys are
never stored in browser storage, are sent only to their own provider, and are redacted from
provider errors kept by the relay.

Outbound requests never follow redirects and refuse responses over 4 MB. Generation sends
your item details and any accepted reference to the AI providers you configured; Look up and
Find keywords send the product name or barcode to eBay. Generated listing HTML contains no
scripts, forms or links.

Do not expose the relay to an untrusted network or run it as a shared, multi-user service.
The automated checks use synthetic data and mocked services; they are not a security audit.
