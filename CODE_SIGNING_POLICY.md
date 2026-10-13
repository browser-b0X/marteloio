# Code signing policy

Marteloio's Windows installer, `Marteloio-Setup.exe`, is to be signed through the SignPath
Foundation's free code signing program for open-source projects.

**Status:** the application is in progress. Releases up to and including 0.2.0 are not
code-signed. Check them with their SHA-256 file, as described in
[SECURITY.md](SECURITY.md#checking-the-installer).

Once signing starts: Free code signing provided by [SignPath.io](https://about.signpath.io/),
certificate by [SignPath Foundation](https://signpath.org/).

## What is signed

- Only `Marteloio-Setup.exe`, the installer published on this repository's
  [Releases page](https://github.com/browser-b0X/marteloio/releases).
- It is built by GitHub Actions from the source code in this repository, using
  [.github/workflows/build-installer.yml](.github/workflows/build-installer.yml). A file built
  on someone's own computer is never submitted for signing.
- The installer includes the official Windows embeddable package of Python from python.org,
  unchanged and checked against its published SHA-256 when the installer is built. Those files
  are already signed by the Python Software Foundation and are not signed again.

## Team and roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [browser-b0X](https://github.com/browser-b0X) (maintainer) |
| Approvers | [browser-b0X](https://github.com/browser-b0X) |

- Changes from anyone outside the team are reviewed before they are merged.
- Every signing request, which means every release, is approved by hand.
- Team members use two-factor authentication on GitHub and on SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it.

In practice, Marteloio runs on your own computer. It sends your item notes only to the AI
service you set up (Google Gemini, Groq, OpenRouter or FreeLLMAPI), and only when you ask it to
write or rewrite a listing. It contacts eBay only when you use Look up, Find keywords or Connect
eBay. It has no analytics, tracking or automatic updates. See [SECURITY.md](SECURITY.md) for
where your data is kept.

## Reporting

Report a security problem, including a suspected fake or tampered installer, as described in
[SECURITY.md](SECURITY.md). Report conduct problems as described in the
[code of conduct](CODE_OF_CONDUCT.md).
