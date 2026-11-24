; Windows 安装向导展示确认页，旧 Squirrel 测试版仅在用户点击安装且退出应用后迁移。
!include "nsDialogs.nsh"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom AgentConfirmPage AgentConfirmLeave

Var agentOldInstall

; 在安装文件之前显示最终确认，安装目录始终由向导传入。
Function AgentConfirmPage
  StrCpy $agentOldInstall ""
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\autopilot_desktop" "DisplayName"
  ${If} $0 == "Autopilot Desktop"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\autopilot_desktop\Update.exe"
    StrCpy $agentOldInstall "$LOCALAPPDATA\autopilot_desktop"
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "准备安装" "请确认安装位置，然后点击安装。"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "Autopilot Desktop ${VERSION}$\r$\n安装位置：$INSTDIR"
  Pop $0
  ${If} $agentOldInstall != ""
    ${NSD_CreateLabel} 0 45u 100% 50u "检测到旧的 Squirrel 测试版。点击安装后将移除旧程序，保留工作台配置和 CLI 用户数据。请先正常退出正在运行的 Desktop。"
    Pop $0
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装"
  nsDialogs::Show
FunctionEnd

; 用户明确点击安装后才迁移旧程序，拒绝安装到旧 Squirrel 根，避免卸载误删新文件。
Function AgentConfirmLeave
  ${If} $agentOldInstall != ""
    StrLen $1 "$agentOldInstall\"
    StrCpy $2 "$INSTDIR\" $1
    ${If} $2 == "$agentOldInstall\"
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择新的安装目录，不能使用旧 Squirrel 程序目录。"
      Abort
    ${EndIf}
    nsProcess::_FindProcess "autopilot-desktop.exe"
    Pop $0
    ${If} $0 == 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "请先正常退出 Autopilot Desktop 并完成终端关闭确认，再点击安装。"
      Abort
    ${EndIf}
    ClearErrors
    ExecWait '"$agentOldInstall\Update.exe" --uninstall --silent' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "旧测试版卸载未完成，请在 Windows 已安装应用中卸载旧测试版后重试。用户数据将保留。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd
!macroend
