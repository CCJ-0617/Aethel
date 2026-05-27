# User Issue Log

This file tracks user-reported Aethel issues, what caused them, and whether the
project has a verified fix or only a workaround.

## Issue AETHEL-2026-05-27-001: OAuth commands fail with `invalid_grant`

- Status: Fixed in source, pending live re-auth verification
- Reported: 2026-05-27
- Commands:
  - `aethel add`
  - `aethel status`
  - `aethel auth`
- Observed output:

```text
Connection failed
Error: invalid_grant
```

### Cause

The failure happens during Google OAuth authentication before Aethel starts
loading workspace status or staging changes.

Aethel reads its cached OAuth token from the configured token path, normally
`~/.config/aethel/token.json` unless `--token` or `GOOGLE_DRIVE_TOKEN_PATH` is
set. `invalid_grant` is returned by Google's OAuth server when the cached grant
can no longer be used. Common reasons are:

- the refresh token expired or was revoked;
- the user changed Google account security settings or removed app access;
- the OAuth client credentials changed after the token was created;
- the same OAuth app issued too many refresh tokens and Google invalidated an
  older one;
- the local machine clock is far enough out of sync to make the grant invalid.

### Current workaround

Re-run authentication to replace the cached token:

```powershell
aethel auth
```

If the same error appears during `aethel auth`, remove the stale token file and
authenticate again:

```powershell
Remove-Item "$env:USERPROFILE\.config\aethel\token.json"
aethel auth
```

Use a custom token path only if the failing commands were also using that path:

```powershell
aethel auth --token <path-to-token.json>
```

### Fix status

- Diagnosis added: Yes
- User-facing recovery documented: Yes
- Code fix added: Yes
  - the CLI now translates `invalid_grant` into a recovery message
  - `aethel auth` now forces a fresh browser OAuth flow instead of reusing the
    stale cached token
- Verification status: Source tests passed; live re-auth still requires the
  user's Google browser session

### Candidate product fix

Aethel should catch OAuth `invalid_grant` failures and print a recovery-focused
message, for example:

```text
Your saved Google OAuth token is no longer valid.
Run `aethel auth` to sign in again. If that still fails, delete the saved
token.json and retry.
```

This would make the cause obvious without requiring users to know Google's OAuth
error names.
