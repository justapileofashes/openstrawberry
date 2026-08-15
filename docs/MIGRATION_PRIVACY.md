# Migration and Password-Export Privacy

OpenStrawberry detects browser installations using profile-directory metadata only. It imports Chromium bookmarks and the displayed default-search name only after a native approval. It does **not** read browser password databases, cookies, active sessions, payment data, account tokens, or history.

| Data class | Migration behavior | Storage and exposure |
|---|---|---|
| Chromium bookmarks and displayed search name | Imported only after the user chooses a detected Chromium profile and approves the native dialog. | Stored in OpenStrawberry-owned local storage. |
| Firefox and Safari bookmarks | Available only from a user-selected `.html` or `.htm` bookmark export. The main process shows a count-only review and requires a second native approval before committing compatible HTTP(S) entries. | Stored in OpenStrawberry-owned local storage. The import never opens `places.sqlite` or Safari’s `Bookmarks.plist`. |
| Passwords | Available only from a user-selected, browser-exported `.csv` file. The main process returns a count-only review and requires a second native approval before committing. | Passwords are encrypted with OS-backed protection. This release stages them only; it does not render, autofill, sync, or send them to websites, providers, or agents. |
| Cookies, sessions, tokens, payment data, history | Never read or imported. | Not collected. |

Chrome documents password export through Google Password Manager’s **Export passwords → Download file** setting and instructs users to delete the CSV after completing an import.[1] Firefox likewise states that exported login CSV files are readable to anyone who can access the file and should not be uploaded, emailed, or shared.[2] For that reason, OpenStrawberry accepts only a user-selected CSV through a native picker, does not expose password text to the renderer, holds pre-commit entries only in memory, and encourages deletion of the source file after successful import.

Firefox documents HTML bookmark export as the transfer format for other browsers and computers, distinguishing it from Firefox-only JSON/JSONLZ4 backups.[3] Apple documents Safari’s **File → Export → Bookmarks** flow, which writes `Safari Bookmarks.html` by default.[4] OpenStrawberry therefore accepts only a manually selected HTML export for these browser families. It parses title, HTTP(S) URL, and bounded folder paths; it does not import settings or history in this milestone.

> **Important:** A CSV export is plaintext until you remove it. Complete the local import, verify the resulting review, then securely delete the original export from the folder where the browser created it.

## Current limitation

The encrypted staging format is deliberately not connected to a browser autofill service in this release. Importing a CSV does not alter site login behavior, and no agent can access imported values. A future credential-vault center must add explicit user controls, auditability, disclosure, and another security review before any credential can be used for autofill.

## References

[1]: https://support.google.com/chrome/answer/13068232 "Google Chrome Help — Import or export passwords and passkeys with Google Password Manager"
[2]: https://support.mozilla.org/en-US/kb/export-login-data-firefox "Mozilla Support — Export login data from Firefox"
[3]: https://support.mozilla.org/en-US/kb/export-firefox-bookmarks-to-backup-or-transfer "Mozilla Support — Export Firefox bookmarks to an HTML file to back up or transfer bookmarks"
[4]: https://support.apple.com/en-us/117827 "Apple Support — How to sync or export your bookmarks on devices with iOS 10 or earlier or macOS Sierra 10.12.5 or earlier"
