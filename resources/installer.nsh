# Windows application registration.
#
# electron-builder already writes the Add/Remove Programs entry, so the app has
# always appeared under Settings > Apps > Installed apps. What it does not write
# is the registration that makes Windows treat OpenStrawberry as an application
# it *knows about*: the Default Programs keys. Without them the app is missing
# from Settings > Default apps, missing from the browser picker, and unknown to
# the Run dialog - so the "Set as default browser" button in the settings panel
# opens `ms-settings:defaultapps` and hands the person to a page that has never
# heard of us. The button was correct; the registration behind it was absent.
#
# Four registrations, each load-bearing on its own:
#
#   1. A ProgID under `Software\Classes` - the thing an association points *at*.
#      An association with no ProgID to name has nothing to record.
#   2. A client entry under `Software\Clients\StartMenuInternet` - what makes
#      Windows classify this as a web browser rather than as a program that
#      happens to accept a URL. Only clients listed here are offered under
#      "Web browser" in Default apps.
#   3. `Software\RegisteredApplications` - the index Settings actually reads. An
#      application missing from it does not exist as far as Default apps is
#      concerned, however complete the other three are.
#   4. `App Paths` - so the Run dialog and `start openstrawberry` resolve the
#      executable without a full path.
#
# Everything is written to SHELL_CONTEXT rather than a hardcoded root. The
# installer is per-user (`perMachine: false`), so SHELL_CONTEXT is HKCU, and a
# write to HKLM would fail for want of elevation - silently, because NSIS does
# not abort on a failed registry write. Windows reads both roots for all four
# registrations, so a per-user install is a complete one.
#
# Deliberately not written: the legacy `InstallInfo` subkey (ReinstallCommand,
# HideIconsCommand, ShowIconsCommand). It was read by "Set Program Access and
# Computer Defaults", which Windows 10 removed, and its commands are switches
# this application does not implement. Writing them would put three lies in the
# registry to satisfy a control panel that no longer exists.
#
# This is not a guess. Chrome, Firefox, and every Chromium fork on a test
# machine write the subkey, so it was the first suspect when the app failed to
# appear in Settings > Default apps with all four registrations present and
# correct. Adding it by hand changed nothing; the missing piece was the file
# associations below. The subkey stays unwritten.

# The identity Windows will remember.
#
# These are the strings that must never change casually. Windows records the
# person's default-browser choice as a UserChoice naming the ProgID, sealed with
# a hash it will not let an installer forge; rename the ProgID and that choice
# stops resolving, silently, and link clicks fall back to the "how do you want
# to open this?" picker. So they are written out literally rather than derived
# from ${PRODUCT_NAME}, which is a display string and free to change.
#
# The ProgID carries the `HTML` suffix every browser uses, and both the URL and
# the document associations below point at this one name.
!define OPENSTRAWBERRY_PROGID "OpenStrawberryHTML"
!define OPENSTRAWBERRY_CLIENT "OpenStrawberry"
!define OPENSTRAWBERRY_CLIENT_KEY "Software\Clients\StartMenuInternet\${OPENSTRAWBERRY_CLIENT}"
!define OPENSTRAWBERRY_CAPABILITIES_KEY "${OPENSTRAWBERRY_CLIENT_KEY}\Capabilities"

!macro customInstall
  # 1. The ProgID - what an association names.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}" "" "OpenStrawberry HTML Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  # The shell reads the `Application` subkey for the name, icon, and description
  # it shows beside the choice. `AppUserModelId` appears on both keys so a window
  # opened by a link click groups under the same taskbar button as one opened
  # from the Start menu - the split-pinning failure docs/RELEASES.md already
  # warns about for shortcuts, reached by the other door.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}" "AppUserModelId" "${APP_ID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}\Application" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}\Application" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}\Application" "ApplicationDescription" "${APP_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}\Application" "AppUserModelId" "${APP_ID}"

  # 2. The browser client entry. `shell\open\command` here takes no argument:
  # this is the "open the browser" verb the Start menu and Default apps use, not
  # the "open this URL" verb, which is the ProgID's above.
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CLIENT_KEY}" "" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CLIENT_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CLIENT_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}" "ApplicationDescription" "${APP_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\StartMenu" "StartMenuInternet" "${OPENSTRAWBERRY_CLIENT}"

  # http and https, together: an app owning one and not the other is a broken
  # default rather than a partial one - the same pair `DEFAULT_BROWSER_PROTOCOLS`
  # names in src/shared/default-browser.ts, and they must stay in step.
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\URLAssociations" "http" "${OPENSTRAWBERRY_PROGID}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\URLAssociations" "https" "${OPENSTRAWBERRY_PROGID}"

  # The document types, which are also a promise.
  #
  # This list must equal `LOCAL_DOCUMENT_EXTENSIONS` in src/shared/navigation.ts,
  # and `pnpm verify:config` fails the release if it does not. That check is the
  # point of the list rather than bookkeeping around it: an extension registered
  # here that the app will not render means someone picks OpenStrawberry for
  # their .html files and gets an empty tab on every double-click. The app
  # refuses `file:` everywhere except the launch path for exactly this reason,
  # so the two lists going out of step is the one way that guarantee breaks.
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\FileAssociations" ".htm" "${OPENSTRAWBERRY_PROGID}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\FileAssociations" ".html" "${OPENSTRAWBERRY_PROGID}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\FileAssociations" ".shtml" "${OPENSTRAWBERRY_PROGID}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\FileAssociations" ".xht" "${OPENSTRAWBERRY_PROGID}"
  WriteRegStr SHELL_CONTEXT "${OPENSTRAWBERRY_CAPABILITIES_KEY}\FileAssociations" ".xhtml" "${OPENSTRAWBERRY_PROGID}"

  # The shell offers the app for a file type only when it says it supports it,
  # and reads the list from here rather than from Capabilities above.
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".htm" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".html" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".shtml" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xht" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xhtml" ""

  # 3. The index. The value is a key path relative to the same root, and must
  # carry no leading backslash - Windows silently ignores the entry if it does.
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${OPENSTRAWBERRY_CLIENT}" "${OPENSTRAWBERRY_CAPABILITIES_KEY}"

  # 4. The executable, resolvable by name.
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"

  # The name the "Open with" list shows. Without it the shell falls back to the
  # bare filename, and the app is offered to people as "OpenStrawberry.exe".
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  # electron-builder writes InstallLocation to its own bookkeeping key but not
  # to the Add/Remove Programs entry, which is left blank. Settings > Installed
  # apps reads it for the install path it shows, and repair tooling reads it to
  # find the application at all.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"

  # SHCNE_ASSOCCHANGED. Explorer caches associations, so without this the new
  # registration is invisible until the next sign-in - which reads to the person
  # as the installer having done nothing.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  # An update runs the old uninstaller before the new installer, and the new
  # installer rewrites all of this a moment later. Tearing the registration down
  # in between is pointless when the update succeeds and harmful when it does
  # not: a failed update would leave the person with no default browser and no
  # sign of why. Only a real uninstall unregisters.
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${OPENSTRAWBERRY_CLIENT}"
    DeleteRegKey SHELL_CONTEXT "${OPENSTRAWBERRY_CLIENT_KEY}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${OPENSTRAWBERRY_PROGID}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
    DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"

    # `Software\Clients\StartMenuInternet` itself is left alone. It is shared -
    # every browser on the machine has an entry under it - and removing it would
    # be this uninstaller reaching outside its own installation.
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ${endIf}
!macroend
