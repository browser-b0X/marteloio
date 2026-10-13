; Marteloio - per-user Windows installer (Inno Setup 6.7.3)
;
; Do not compile this file by hand: double-click packaging\build-installer.cmd (see
; BUILDING.md). That script stages the files from packaging\files.txt and Python's official
; embeddable package in packaging\build\app\, checks them, and then runs
;   ISCC.exe /DMyAppVersion=<contents of VERSION> packaging\installer.iss
; which writes packaging\dist\Marteloio-Setup.exe.
;
; What the installer does:
;   - installs for the current Windows user only, without administrator rights
;     ({autopf} is %LOCALAPPDATA%\Programs when PrivilegesRequired=lowest)
;   - brings its own Python in {app}\runtime\ (python314._pth has an extra '..' line, so
;     the app's own modules in {app} can be imported)
;   - shortcuts run {app}\runtime\pythonw.exe "{app}\launch.py", so no console window opens
;   - installs the empty marker file {app}\marteloio-installed: with it the app keeps keys,
;     settings and logs in %LOCALAPPDATA%\Marteloio, never in the program folder
;   - stops a running copy with launch.py --stop --quiet before installing over it and
;     before uninstalling. It never kills processes by name: other programs run as
;     pythonw.exe too.
;   - uninstalling keeps %LOCALAPPDATA%\Marteloio unless the user answers Yes to
;     "Also remove your saved keys and settings?"

#ifndef MyAppVersion
  #error Run packaging\build-installer.cmd instead: it passes /DMyAppVersion from the VERSION file.
#endif

; Folder with the staged app and runtime, relative to this file.
#define StageDir "build\app"

[Setup]
; The AppId identifies Marteloio for upgrades and the uninstall entry. Never change it.
AppId={{B20D620A-676B-48E8-91AD-F9B04A21EABD}
AppName=Marteloio
AppVersion={#MyAppVersion}
AppVerName=Marteloio {#MyAppVersion}
AppPublisher=Marteloio
AppPublisherURL=https://github.com/browser-b0X/marteloio
AppSupportURL=https://github.com/browser-b0X/marteloio/issues
AppUpdatesURL=https://github.com/browser-b0X/marteloio/releases
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName=Marteloio
VersionInfoDescription=Marteloio Setup
; Per user, never elevated: no UAC prompt, nothing outside the user's own folders.
PrivilegesRequired=lowest
DefaultDirName={autopf}\Marteloio
DefaultGroupName=Marteloio
; As few pages as possible: the shortcut choice (its Next button says Install), progress,
; then Finish with "Open Marteloio now".
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
ShowLanguageDialog=no
WizardStyle=modern
SetupIconFile={#StageDir}\assets\brand\marteloio.ico
WizardSmallImageFile={#StageDir}\assets\brand\marteloio-light-64.png
UninstallDisplayIcon={app}\assets\brand\marteloio.ico
UninstallDisplayName=Marteloio
; The bundled Python is 64-bit and needs Windows 10 or newer.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2
SolidCompression=yes
OutputDir=dist
OutputBaseFilename=Marteloio-Setup
; launch.py --stop --quiet (see PrepareToInstall) normally stops the app before any file is
; replaced. Only if that fails, Windows Restart Manager offers to close the programs that
; still hold files in this install folder - nothing else on the PC.
CloseApplications=force
CloseApplicationsFilter=*.exe,*.dll,*.pyd
RestartApplications=no
; Writes "Setup Log <date>.txt" to %TEMP%, which helps when a tester reports a problem.
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WizardSelectTasks=Install Marteloio
SelectTasksDesc=Marteloio will be installed for your Windows account only.
SelectTasksLabel2=Choose whether you want a desktop shortcut, then click Install.
FinishedHeadingLabel=Marteloio is installed
FinishedLabelNoIcons=Marteloio is installed. It opens in your web browser.
FinishedLabel=You can open Marteloio any time from the Start menu. It opens in your web browser.

[Tasks]
; Checked by default.
Name: "desktopicon"; Description: "Add a Marteloio shortcut to the desktop"; GroupDescription: "Shortcuts:"

[InstallDelete]
; Replace the bundled Python as a whole, so no files of an older Python stay behind, and
; drop cached bytecode of the old version. Neither folder ever holds user data.
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\__pycache__"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; Empty marker: tells the app it was installed, so it keeps user data in %LOCALAPPDATA%\Marteloio.
Source: "marteloio-installed"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Marteloio"; Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\launch.py"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\brand\marteloio.ico"; Comment: "Open Marteloio in your web browser"
Name: "{group}\Stop Marteloio"; Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\launch.py"" --stop"; WorkingDir: "{app}"; IconFilename: "{app}\assets\brand\marteloio.ico"; Comment: "Stop Marteloio"
Name: "{autodesktop}\Marteloio"; Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\launch.py"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\brand\marteloio.ico"; Comment: "Open Marteloio in your web browser"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\launch.py"""; WorkingDir: "{app}"; Description: "Open Marteloio now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; Runs first when uninstalling, before any file is removed.
Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\launch.py"" --stop --quiet"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "StopMarteloio"

[UninstallDelete]
; Bytecode Python writes next to the app's modules. User data is never in {app}.
Type: filesandordirs; Name: "{app}\__pycache__"

[Code]
// The shortcut page is the last one before installing (DisableReadyPage=yes), so its button
// says Install, as the page text promises. Inno Setup leaves it at Next otherwise.
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpSelectTasks then
    WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);
end;

// Installing over an existing copy: stop it first, so its files can be replaced. launch.py
// --stop stops only the Marteloio that belongs to this folder (it checks the app's own
// /health answer and asks it to shut down) and --quiet keeps it from showing messages.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PythonW, Launcher: String;
  ResultCode: Integer;
begin
  Result := '';
  PythonW := ExpandConstant('{app}\runtime\pythonw.exe');
  Launcher := ExpandConstant('{app}\launch.py');
  if FileExists(PythonW) and FileExists(Launcher) then
  begin
    if Exec(PythonW, AddQuotes(Launcher) + ' --stop --quiet', ExpandConstant('{app}'),
            SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Log(Format('launch.py --stop --quiet exited with code %d', [ResultCode]))
    else
      Log(Format('launch.py --stop --quiet could not be started: %s', [SysErrorMessage(ResultCode)]));
  end;
  // Exit code 1 can also mean another program uses the port, so it never blocks the install.
end;

function FolderHasFiles(const Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Dir) + '*', FindRec) then
  try
    repeat
      Result := (FindRec.Name <> '.') and (FindRec.Name <> '..');
    until Result or not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

// After the program files are gone: offer to remove the user's data folder as well. The
// answer defaults to No, and a silent uninstall always keeps the data. An empty folder
// (nothing was ever saved) is removed without asking.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\Marteloio');
    if DirExists(DataDir) then
    begin
      if not FolderHasFiles(DataDir) then
        RemoveDir(DataDir)
      else if not UninstallSilent then
      begin
        if MsgBox('Also remove your saved keys and settings?' + #13#10#13#10 +
                  'Choose No to keep them for the next time you install Marteloio.',
                  mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        begin
          if not DelTree(DataDir, True, True, True) then
            MsgBox('Some of your saved files couldn''t be removed. You can delete this folder yourself: ' +
                   DataDir, mbInformation, MB_OK);
        end;
      end;
    end;
  end;
end;
