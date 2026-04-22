; PM Copilot NSIS Installer Hooks
; - PREINSTALL: Kill all PM Copilot processes before file replacement
;   Prevents file-lock failures when updating bun.exe / node.exe / etc.

; Shared cleanup logic — kill all processes launched from our install directory,
; plus orphan SDK/MCP processes that reference .pm-copilot in their command line.
; Uses ExecutablePath for install-dir processes (precise, matches the locked file)
; and CommandLine for orphans (SDK/MCP may be system node/bun, not our binary).
!macro _PM_COPILOT_KILL_PROCESSES
  DetailPrint "Cleaning up PM Copilot background processes..."

  ; 1. Kill ALL processes whose executable lives under our install directory.
  ;    Covers bun.exe (sidecar), node.exe (MCP via bundled npx), and any future binaries.
  ;    Uses ExecutablePath — the actual on-disk binary — so we won't false-positive
  ;    on processes that merely mention our path in their arguments.
  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like \"$INSTDIR\*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'

  ; 2. Kill orphan SDK/MCP child processes that may use system node/bun
  ;    (their executable is NOT under $INSTDIR, but their CommandLine references .pm-copilot)
  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*claude-agent-sdk*\" -and $_.CommandLine -like \"*.pm-copilot*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'
  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*.pm-copilot\mcp\*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'

  ; Brief wait for processes to fully terminate and release file locks
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _PM_COPILOT_KILL_PROCESSES

  ; Remove bun.exe alias before upgrade — hardlink goes stale when the target exe is replaced
  Delete "$INSTDIR\bun.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Create bun.exe hardlink for SDK subprocess compatibility.
  ; Tauri externalBin names the binary with target triple suffix (bun-x86_64-pc-windows-msvc.exe),
  ; but SDK uses which("bun") which only matches bun.exe/bun.cmd/bun.bat.
  ; Hardlink: zero extra disk space, same file, instant creation.
  IfFileExists "$INSTDIR\bun-x86_64-pc-windows-msvc.exe" 0 bun_alias_done
    IfFileExists "$INSTDIR\bun.exe" bun_alias_done 0
      nsExec::ExecToLog 'cmd /c mklink /H "$INSTDIR\bun.exe" "$INSTDIR\bun-x86_64-pc-windows-msvc.exe"'
      Pop $0
      ${If} $0 != 0
        ; Hardlink failed (e.g. non-NTFS), fall back to copy
        CopyFiles /SILENT "$INSTDIR\bun-x86_64-pc-windows-msvc.exe" "$INSTDIR\bun.exe"
      ${EndIf}
  bun_alias_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Kill all PM Copilot processes before uninstall (same file-lock issue as update)
  !insertmacro _PM_COPILOT_KILL_PROCESSES

  ; Clean up bun.exe alias created by POSTINSTALL (not in Tauri's externalBin list)
  Delete "$INSTDIR\bun.exe"
!macroend
