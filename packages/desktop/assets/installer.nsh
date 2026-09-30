; Custom NSIS header for the DSH SSH Desktop installer (electron-builder picks
; up assets/installer.nsh as `nsis.include`). It is inserted before the
; installer script proper, so the defines below take effect there.

; electron-builder keeps a copy of the installer for its updater in
; %LOCALAPPDATA%\<npm name>-updater. Every folder this app owns is named after
; the product instead: DSH SSH Desktop.
!ifdef APP_INSTALLER_STORE_FILE
  !undef APP_INSTALLER_STORE_FILE
!endif
!define APP_INSTALLER_STORE_FILE "DSH SSH Desktop\updater\installer.exe"

!macro customInstall
  ; The folder an earlier build named after the npm package.
  RMDir /r "$LOCALAPPDATA\dsh-ssh-desktop-updater"
!macroend

!macro customUnInstall
  ; Only the installer copy; saved connections and logs stay, like app data.
  RMDir /r "$LOCALAPPDATA\DSH SSH Desktop\updater"
  RMDir "$LOCALAPPDATA\DSH SSH Desktop"
!macroend
