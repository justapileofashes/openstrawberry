# Migration and Password-Export Privacy

OpenStrawberry detects browser installations using profile-directory metadata only. It imports Chromium bookmarks and the displayed default-search name only after a native approval. It does **not** read browser password databases, cookies, active sessions, payment data, account tokens, or history.

| Data class | Migration behavior | Storage and exposure |
|---|---|---|
| Bookmarks and displayed search name | Imported only after the user chooses a detected Chromium profile and approves the native dialog. | Stored in OpenStrawberry-owned local storage. |
| Passwords | Available only from a user-selected, browser-exported `.csv` file. The main process returns a count-only review and requires a second native approval before committing. | Passwords are encrypted with OS-backed protection. This release stages them only; it does not render, autofill, sync, or send them to websites, providers, or agents. |
| Cookies, sessions, tokens, payment data, history | Never read or imported. | Not collected. |

Chrome documents password export through Google Password Manager’s **Export passwords → Download file** setting and instructs users to delete the CSV after completing an import.[1] Firefox likewise states that exported login CSV files are readable to anyone who can access the file and should not be uploaded, emailed, or shared.[2] For that reason, OpenStrawberry accepts only a user-selected CSV through a native picker, does not expose password text to the renderer, holds pre-commit entries only in memory, and encourages deletion of the source file after successful import.

> **Important:** A CSV export is plaintext until you remove it. Complete the local import, verify the resulting review, then securely delete the original export from the folder where the browser created it.

## Current limitation

The encrypted staging format is deliberately not connected to a browser autofill service in this release. Importing a CSV does not alter site login behavior, and no agent can access imported values. A future credential-vault center must add explicit user controls, auditability, disclosure, and another security review before any credential can be used for autofill.

## References

[1]: https://support.google.com/chrome/answer/13068232 "Google Chrome Help — Import or export passwords and passkeys with Google Password Manager"
[2]: https://support.mozilla.org/en-US/kb/export-login-data-firefox "Mozilla Support — Export login data from Firefox"
