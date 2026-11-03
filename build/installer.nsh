; Premation's additions to electron-builder's NSIS installer (electron-builder.yml nsis.include).

; The page wording. electron-builder's assisted installer has no Welcome page
; unless customWelcomePage exists, so without this the first thing a user saw
; was the per-user/all-users choice. The bitmaps beside these pages come from
; scripts/installer-art (installerSidebar.bmp, installerHeader.bmp).
;
; The Finish defines ride in the same macro: they only have to exist before
; MUI_PAGE_FINISH, which comes later in assistedInstaller.nsh. An update run
; (--updated) skips the Welcome page.
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Setup will install ${PRODUCT_NAME} ${VERSION} on this computer.$\r$\n$\r$\nIf ${PRODUCT_NAME} is open, save your work and close it before you continue.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME

  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} is installed"
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} ${VERSION} is ready to use."
  !define MUI_FINISHPAGE_RUN_TEXT "Open ${PRODUCT_NAME} now"
!macroend

; No "Anyone who uses this computer / Only for me" page: its wording is
; electron-builder's and it asks a question almost everyone answers the same
; way. Installs go to the current user, except where an all-users install
; already exists and none for this user: that one keeps upgrading in place
; (elevating, as before) instead of leaving a second copy beside it.
; `/allusers` on the command line still wins (checked first in multiUserUi.nsh).
; The uninstaller keeps its own logic: it asks only when both kinds exist.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  !endif
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Remove ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Setup will remove ${PRODUCT_NAME} from this computer.$\r$\n$\r$\nYour projects and media are not touched.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME

  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} was removed"
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} has been removed from this computer."
!macroend

; Claude for Premation (docs/MCP_PLAN.md D9). On a REAL uninstall — not the
; uninstall an auto-update runs before installing the new version — ask the app
; to remove `mcpServers.premation` from Claude Desktop's config, so Claude is
; not left launching a program that no longer exists. Runs before the files are
; deleted; the app edits only its own entry and exits. A failure is ignored: an
; uninstall must never stop on this.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --premation-mcp-uninstall'
  ${endIf}
!macroend
