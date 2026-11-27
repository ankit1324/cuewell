; Included by the electron-builder NSIS installer (build.nsis.include).
;
; Cuewell always installs for the current user only: no admin prompt and no
; "for all users" page. The user can still choose the folder. Cuewell keeps
; its .env, profile.json and Whisper venv in its %APPDATA% folder, so the
; installer does not create them, and the uninstaller leaves them in place.

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
!macroend

!macro customUnInstall
!macroend
