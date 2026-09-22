; HiDock Model Host installer.
;
; Per-user by default: no elevation, no service, nothing machine-wide. The host
; runs as the signed-in person and holds a GPU only while they say so.
;
; It installs the program and leaves the heavy parts to first run, because a
; CUDA build of torch is 2.5 GB and downloading it inside a setup wizard with no
; way to pause is worse than asking for it once the person can see progress.

Unicode true
SetCompressor /SOLID lzma

!define PRODUCT "HiDock Model Host"
!define PRODUCT_KEY "HiDockModelHost"
!ifndef VERSION
  !define VERSION "0.1.0"
!endif

Name "${PRODUCT} ${VERSION}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
InstallDirRegKey HKCU "Software\${PRODUCT_KEY}" "InstallDir"
ShowInstDetails show
ShowUninstDetails show

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Function .onInit
  ; One host per machine. A second copy would fight the first for the GPU and
  ; for the port, and the person would have no way to tell which one answered.
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "HiDockModelHostSetup") p .r1 ?e'
  Pop $R0
  StrCmp $R0 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "The ${PRODUCT} installer is already running."
    Abort
FunctionEnd

Section "Model Host" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"

  ; Program, models, jobs and credentials each get their own place, so removing
  ; the program does not remove a 2.5 GB download or a paired client's token.
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

  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk" "$INSTDIR\Start Model Host.cmd" "" "" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\Set up ${PRODUCT}.lnk" "$INSTDIR\Set up Model Host.cmd"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section -Finish
  ; Offer setup. Installing is not authorization to download models or start
  ; holding the GPU, so nothing runs unless the person says yes here.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Set up ${PRODUCT} now?$\r$\n$\r$\nSetup checks the GPU and downloads the model runtime (about 2.5 GB). You can do it later from the Start Menu." \
    IDNO skip_setup
    Exec '"$INSTDIR\Set up Model Host.cmd"'
  skip_setup:
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}\Set up ${PRODUCT}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT}"

  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}"
  DeleteRegKey HKCU "Software\${PRODUCT_KEY}"

  ; The models and the paired token are the person's, not the program's. They
  ; are named here so an uninstall can say what it is leaving behind.
  MessageBox MB_OK|MB_ICONINFORMATION \
    "Downloaded models and pairing settings were left in:$\r$\n$LOCALAPPDATA\${PRODUCT}$\r$\n$\r$\nDelete that folder to remove them too."
SectionEnd
