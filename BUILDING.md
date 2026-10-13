# Building the Windows installer

`packaging\build-installer.cmd` makes **Marteloio-Setup.exe**: a one-click installer that
brings its own Python, so people don't need to install anything else. It installs for one
Windows user, needs no administrator rights and adds Start menu and desktop shortcuts.

## What you need (once)

- Windows 10 or 11 (64-bit) and an internet connection for the first build.
- **Inno Setup 6.7.3** from <https://jrsoftware.org/isdl.php> (the same one SuperBookmarks
  uses). Keep its default install folder; the build finds it there or on PATH.
- Nothing else. Python isn't needed on your PC: the build downloads Python's official
  embeddable package 3.14.8 (about 12 MB) from python.org once, into `packaging\cache\`, and
  checks it against the SHA-256 pinned in `packaging\build-installer.ps1`.

## Build

1. Check that `VERSION` holds the version you want to release (for example `0.2.0`).
2. Double-click `packaging\build-installer.cmd`. It takes about a minute and the window
   stays open until you press a key. The last lines say the installer is ready, or why the
   build stopped.
3. The results are in `packaging\dist\`:
   - `Marteloio-Setup.exe`: the installer
   - `Marteloio-Setup.exe.sha256`: its checksum, for the release page
   - `build.log`: everything the build printed

The build stops with a plain message if the Python download doesn't match the pinned hash,
a file listed in `packaging\files.txt` is missing, the bundled Python can't load the app,
or anything that isn't on the list ended up in the installer.

What goes into the installer is listed in `packaging\files.txt` (the app, its fonts and logo,
`LICENSE` and `TRADEMARKS.md`; never tests, docs, `.env`, keys or logs). The installer is
described in `packaging\installer.iss`. `packaging\marteloio-installed` is an empty file on
purpose: installed copies keep keys, settings and logs in `%LOCALAPPDATA%\Marteloio`
because of it. Don't delete it.

## Try it before publishing

Best in a second Windows account or a virtual machine, so your own copy isn't touched.

- Run `Marteloio-Setup.exe`. There is no administrator prompt: one page with the desktop
  shortcut box, then Install, then Finish with "Open Marteloio now" ticked.
- The browser opens `http://localhost:8080`.
- Start menu › Marteloio › **Stop Marteloio** stops it; **Marteloio** opens it again.
- Run the installer again while Marteloio is open: it stops the app, replaces the files and
  keeps your keys.
- Settings › Apps › Installed apps › Marteloio › Uninstall. Answer **No** to "Also remove
  your saved keys and settings?" and check that `%LOCALAPPDATA%\Marteloio` is still there.

Program files go to `%LOCALAPPDATA%\Programs\Marteloio` (replaced by every update). Keys,
settings and logs stay in `%LOCALAPPDATA%\Marteloio`.

## Publish a GitHub release

1. Commit and push the code you built from.
2. On GitHub open **Releases › Draft a new release**. Create the tag `v0.2.0` on that
   branch and use the title `Marteloio 0.2.0`.
3. Attach `Marteloio-Setup.exe` and `Marteloio-Setup.exe.sha256` from `packaging\dist\`.
4. Release notes: what's new, "Download Marteloio-Setup.exe and double-click it", the
   SmartScreen steps below and the SHA-256 from the `.sha256` file.
5. Publish it as the latest release.

The file name never changes, so the website and README can always link to
<https://github.com/browser-b0X/marteloio/releases/latest/download/Marteloio-Setup.exe>.
From a terminal the same release is
`gh release create v0.2.0 packaging/dist/Marteloio-Setup.exe packaging/dist/Marteloio-Setup.exe.sha256 --title "Marteloio 0.2.0" --notes-file notes.md`.

## What users see while the installer is unsigned

The installer isn't code-signed yet, so Windows SmartScreen shows **"Windows protected your
PC"**. Users choose **More info**, then **Run anyway**. Browsers may also ask whether to
keep the download. Signing through the [SignPath Foundation](https://signpath.org/), which
signs open-source projects for free, is in progress; see
[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md). A signed installer shows a publisher name,
and the warning goes away once enough people have downloaded signed releases.

## Build on GitHub

The [Windows installer](.github/workflows/build-installer.yml) workflow builds
`Marteloio-Setup.exe` on a GitHub-hosted Windows machine: for every tag that starts with `v`,
and by hand from **Actions › Windows installer › Run workflow**. It installs Inno Setup 6.7.3
(checked against its SHA-256), runs `packaging\build-installer.ps1` and keeps the installer, its
`.sha256` file and `build.log` as a download on the run's page for 30 days. Only installers
built this way will be submitted for signing; once SignPath approves the project, a signing
step is added to this workflow.

## Release a new version

Change the number in `VERSION` (for example `0.2.1`) and build again. Nothing else changes.
The new installer upgrades an existing copy in place: it stops the running app first and
keeps the user's keys and settings. Never change the `AppId` in `packaging\installer.iss`;
Windows finds the installed copy by it.

## Update the bundled Python

1. On <https://www.python.org/downloads/windows/> open the new release and find **Windows
   embeddable package (64-bit)** (`python-3.x.y-embed-amd64.zip`). Copy its value from the
   **SHA-256 checksum** column.
2. In `packaging\build-installer.ps1` change `$PythonVersion` and `$PythonZipSha256`.
3. In `tests\test_packaging.py` change `PINNED_PYTHON`, `PINNED_ZIP` and `PINNED_SHA256` to
   the same values. For a new minor version (3.15) also update `PRISTINE_PTH` (its `._pth`
   file is then `python315._pth`); the build script works the new names out itself.
4. Build, then try the installer as above. The build refuses a download that doesn't match
   the new hash.

## Clean up

`packaging\build\` and `packaging\dist\` can be deleted at any time. `packaging\cache\` keeps
the Python download for the next build. Git ignores all three.
