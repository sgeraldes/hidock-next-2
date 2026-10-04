; HiDock Model Host installer.
;
; Per-user: no elevation, no Windows service, nothing machine-wide. A double
; click and nothing else (Sebastián, 4-oct-2026): no folder page, no questions.
; It copies the program, runs setup without prompts (hardware check, private
; Python, CUDA torch and pyannote, about 2.5 GB, progress in a console that
; closes by itself), then starts the tray icon and registers it to start with
; Windows. The Hugging Face token is never asked for: HiDock sends it.

Unicode true
SetCompressor /SOLID lzma
!include WinMessages.nsh

!define PRODUCT "HiDock Model Host"
!define PRODUCT_KEY "HiDockModelHost"
!define TRAY_EXE "HiDockModelHost.exe"
!define TRAY_CLASS "HiDockModelHostTray"
!ifndef VERSION
  !define VERSION "0.3.2"
!endif

Name "${PRODUCT} ${VERSION}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
InstallDirRegKey HKCU "Software\${PRODUCT_KEY}" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
; The window closes by itself when the install worked; a failed setup keeps it
; open (SetAutoClose false below) so the error can be read.
AutoCloseWindow true

Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

; Close a running tray icon, which ends the service with it, so its files can
; be replaced or removed.
!macro CloseTray
  FindWindow $0 "${TRAY_CLASS}"
  IntCmp $0 0 +3
    SendMessage $0 ${WM_CLOSE} 0 0
    Sleep 1500
!macroend

Function .onInit
  ; One installer at a time.
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "HiDockModelHostSetup") p .r1 ?e'
  Pop $R0
  StrCmp $R0 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "The ${PRODUCT} installer is already running."
    Abort
FunctionEnd

Section "Model Host" SEC_MAIN
  SectionIn RO
  !insertmacro CloseTray
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"

  ; Program, models and credentials each get their own place, so removing the
  ; program does not remove a 2.5 GB download or a paired client's token.
  CreateDirectory "$LOCALAPPDATA\${PRODUCT}"
  CreateDirectory "$LOCALAPPDATA\${PRODUCT}\models"
  CreateDirectory "$LOCALAPPDATA\${PRODUCT}\runtime"
  CreateDirectory "$LOCALAPPDATA\${PRODUCT}\logs"

  WriteRegStr HKCU "Software\${PRODUCT_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${PRODUCT_KEY}" "Version" "${VERSION}"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" \
    "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" \
    "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" \
    "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" \
    "NoModify" 1

  ; The icon starts with Windows: HiDock can use the GPU without anyone
  ; opening anything on this machine.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_KEY}" "$\"$INSTDIR\${TRAY_EXE}$\""

  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk" "$INSTDIR\${TRAY_EXE}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section -Setup
  ; No questions. The console shows the download and closes when it is done.
  DetailPrint "Setting up the model runtime (about 2.5 GB the first time)..."
  ; This installer is 32-bit, and Windows sends a 32-bit process's System32 to SysWOW64: the
  ; 32-bit PowerShell there cannot see nvidia-smi (64-bit only), so 0.3.0 and 0.3.1 decided the
  ; RTX 4090 had no driver and installed the CPU build of torch. Sysnative is the real System32.
  StrCpy $1 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists $1 +2
    StrCpy $1 "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  ExecWait '"$1" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\setup.ps1"' $0
  IntCmp $0 0 setup_ok
    DetailPrint "Setup ended with code $0. The details are in $LOCALAPPDATA\${PRODUCT}\logs\setup.log."
    SetAutoClose false
  setup_ok:
  Exec '"$INSTDIR\${TRAY_EXE}"'
SectionEnd

Section "Uninstall"
  !insertmacro CloseTray
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_KEY}"
  Delete "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}\Uninstall.lnk"
  ; Shortcuts of 0.1 and 0.2, when this uninstall follows an upgrade.
  Delete "$SMPROGRAMS\${PRODUCT}\Set up ${PRODUCT}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}\${PRODUCT} - pause or resume.lnk"
  Delete "$DESKTOP\${PRODUCT} - pause or resume.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT}"

  ; $INSTDIR comes from a per-user registry value. Only delete it when it
  ; still names the directory that this installer conventionally owns.
  ; This is intentionally a name guard, not a location guard. Paths such as
  ; C:\a\..\HiDock Model Host and \\server\share\HiDock Model Host pass because
  ; they still identify a directory named ${PRODUCT}.
  ; For paths shorter than 18 characters, the negative StrCpy offset yields an
  ; empty string, so the comparison fails.
  StrCpy $R0 "$INSTDIR" ${NSIS_MAX_STRLEN} -17
  StrCmp $R0 "${PRODUCT}" 0 refuse_program_directory
  StrCpy $R0 "$INSTDIR" 1 -18
  StrCmp $R0 "\" 0 refuse_program_directory

  System::Call 'kernel32::GetFileAttributes(t "$INSTDIR") i .r0'
  IntCmp $0 -1 refuse_program_directory
  IntOp $R1 $0 & 0x400
  IntCmp $R1 0 remove_program refuse_program_directory refuse_program_directory

  remove_program:
    Delete "$INSTDIR\uninstall.exe"
    RMDir /r "$INSTDIR"
    Goto deregister

  refuse_program_directory:
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "The program directory, including its uninstaller, was left in place because '$INSTDIR' does not end with '${PRODUCT}' or could not be safely inspected. Remove that path by hand if it is safe to delete."

  ; Deregister in both cases. The program directory may need manual removal,
  ; but its shortcuts and Add/Remove Programs entry must not remain active.
  deregister:
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}"
    DeleteRegKey HKCU "Software\${PRODUCT_KEY}"

  ; The models and the paired token are the person's, not the program's. They
  ; are named here so an uninstall can say what it is leaving behind.
  MessageBox MB_OK|MB_ICONINFORMATION \
    "Downloaded models and pairing settings were left in:$\r$\n$LOCALAPPDATA\${PRODUCT}$\r$\n$\r$\nDelete that folder to remove them too."
SectionEnd
