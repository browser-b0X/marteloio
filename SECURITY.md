# Security and privacy

## Reporting

Prefer GitHub private vulnerability reporting when it is available on this repository.
Otherwise contact the repository owner through a private channel you already know.
Do not post sensitive details in a public issue. No security-report email address or
response-time guarantee is currently established.

## Official sources

Get Marteloio only from [github.com/browser-b0X/marteloio](https://github.com/browser-b0X/marteloio)
or its website, [browser-b0x.github.io/marteloio](https://browser-b0x.github.io/marteloio/).
The Windows installer is published only on this repository's
[Releases page](https://github.com/browser-b0X/marteloio/releases), as `Marteloio-Setup.exe`
together with `Marteloio-Setup.exe.sha256`.
The MIT License lets anyone publish a modified copy, but not under the Marteloio name or logo
(see [TRADEMARKS.md](TRADEMARKS.md)). Treat a "Marteloio" download from anywhere else as
untrusted, and never give an unofficial copy your AI or eBay keys. If you find one, please
report it.

## Checking the installer

`Marteloio-Setup.exe.sha256` holds the SHA-256 checksum of the installer published with it.
To check your download on Windows:

1. Open PowerShell in the folder that holds the download: in File Explorer, type `powershell`
   in the address bar of that folder and press Enter.
2. Run `Get-FileHash .\Marteloio-Setup.exe -Algorithm SHA256`.
3. Compare the Hash it shows with the value in `Marteloio-Setup.exe.sha256` (open it in
   Notepad). Capital and small letters don't matter. If you downloaded both files to the same
   folder, this prints `True` when they match:
   `(Get-FileHash .\Marteloio-Setup.exe -Algorithm SHA256).Hash -eq (Get-Content .\Marteloio-Setup.exe.sha256).Split(' ')[0]`

If the values differ, don't run the file. Download it again from the Releases page, and report
it if it still differs.

The installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC"
and an unknown publisher. The plan is to apply to the [SignPath Foundation](https://signpath.org/),
which signs open-source projects for free. A matching checksum shows that you have the file
that was published on the Releases page; it doesn't replace a signature.

## Where Marteloio keeps your data

| What | Installed with Marteloio-Setup.exe | ZIP or source copy |
| --- | --- | --- |
| Program | `%LOCALAPPDATA%\Programs\Marteloio` | The folder you unzipped or cloned |
| Keys, settings and log | `%LOCALAPPDATA%\Marteloio` | The same folder as the program |
| Drafts, templates and shop details | Your browser's storage for `http://localhost:8080` | The same |

Settings › About shows the data folder. Uninstalling asks whether to remove it; the default
keeps it.

## Sensitive files

Do not publicly attach:

- `.env`, `.marteloio-secrets.enc` (and any `.marteloio-secrets.unreadable-*.enc`),
  `.ebay_token.json` or any other file holding keys or tokens;
- AI keys, eBay Client ID/Secret, RuName, authorization codes or redirect web addresses
  containing them;
- `relay.log` or `relay.log.1` before you have read and redacted it;
- draft backup files or screenshots containing real items, seller details or statistics
  you don't want public.

Reproduce bugs with a made-up item and redacted details. The Version and Build in
Settings › About are safe to share.

## Security model

Marteloio is a local, single-user application. A small Python relay serves the interface
on the loopback address only and checks the Host and Origin of every request; sensitive
requests also need a per-session token. There is no Marteloio account or server, and the app
loads no remote scripts, fonts or analytics.

On Windows, keys saved in Marteloio are encrypted with DPAPI for the current Windows account.
This protects them at rest from other accounts, not from programs running as you, and it is
not a defence against a compromised Windows account. Without DPAPI, keys and eBay tokens
are stored in plain text (`.env`, `.ebay_token.json`) with normal file permissions. Keys are
never stored in browser storage, are sent only to their own service, and are redacted from
the service errors kept by the relay. A FreeLLMAPI address must be on this computer or the
home network, and it is never reached through a proxy.

Outbound requests never follow redirects and refuse responses over 4 MB. Generation sends
your item details and any accepted reference to the AI services you set up; testing a key
sends one tiny request to that service; Look up and Find keywords send the product name or
barcode to eBay. Generated listing HTML contains no scripts, forms or links.

The installer installs for the current Windows user only and never asks for administrator
rights. Before it replaces or removes files, it asks the running copy to shut down; if that
fails, Windows offers to close only what still uses files in the install folder. It never
closes programs by name.

Do not expose the relay to an untrusted network or run it as a shared, multi-user service.
The automated checks use synthetic data and mocked services; they are not a security audit.
