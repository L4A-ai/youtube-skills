# Google OAuth setup for `ytshorts`

Verified against Google documentation on 2026-08-02.

## What to create

Use a Google Cloud project owned by the operator. Do not use credentials shipped by a skill author
or another team. The CLI supports only a Google OAuth **Desktop app** client and asks for the least
combined scope set needed by its full safety workflow:

```text
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.readonly
```

`youtube.upload` authorizes `videos.insert`. The current YouTube discovery document does not allow
that scope for `channels.list(mine=true)` or `videos.list`; `youtube.readonly` is therefore required
to verify the target channel before mutation and read processing/status afterward. An older token
that contains only upload scope is rejected and must be re-authorized.

Service accounts are not a substitute for a normal creator channel. YouTube service-account use is
limited to supported content-owner arrangements.

## Console steps

1. Create or select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the Google Auth Platform consent screen. Add the account as a test user while the app
   is in Testing.
4. Create an OAuth client with application type **Desktop app**.
5. Download its JSON. It must contain an `installed` object, not `web`.
6. Store it outside the repository at the default path below, or pass a path explicitly.

Default locations:

```text
macOS/Linux: ~/.config/ytshorts/client_secret.json
token:       ~/.config/ytshorts/token.json
```

Configuration overrides:

```bash
export YTSHORTS_CONFIG_DIR=/private/operator/config/ytshorts
export YTSHORTS_CLIENT_SECRETS=/private/operator/client_secret.json
export YTSHORTS_TOKEN_PATH=/private/operator/token.json
```

Prefer a private, user-owned config directory. Restrict both files to the user:

```bash
chmod 700 ~/.config/ytshorts
chmod 600 ~/.config/ytshorts/client_secret.json
```

The CLI creates its token directory as `0700`, writes the token atomically, and requests `0600`
permissions. `doctor` reports file presence and permission posture without printing contents or
contacting Google. The stored authorization must include a refresh token; `auth` fails instead of
reporting readiness when Google returns only a short-lived access token.

## Authorize

```bash
node scripts/ytshorts.mjs doctor
node scripts/ytshorts.mjs auth
```

`auth` binds a one-use listener to a random port on `127.0.0.1`, opens the system browser, validates
a random `state`, and uses PKCE S256 before exchanging the authorization code. The manual
copy/paste OOB flow is not supported. `--no-open` prints the consent URL for environments where the
browser must be opened manually on the same desktop.

Google may present a channel/account chooser. The command reads the authorized channel and returns
its ID. Always put that exact value in `--channel-id`; the write path compares it again immediately
before creating an upload session.

## Two reviews that are easy to confuse

- **OAuth consent verification/publishing** governs who may authorize the app and how tokens
  behave.
- **YouTube API compliance audit** governs whether newer projects may make API-uploaded videos
  public or unlisted.

They are separate processes. A successful OAuth flow does not lift the private-only upload
restriction.

For an External OAuth app left in **Testing**, refresh tokens for scopes beyond basic identity can
expire after seven days. `OAUTH_REAUTH_REQUIRED` means run `auth` again; for ongoing use, review the
Google Auth Platform publishing/verification requirements rather than copying tokens around.

## Secret handling

- Never add client JSON or tokens to the repository, a skill package, chat, CI artifacts, or issue
  logs.
- Do not print the resumable upload `Location`; it is a temporary capability URL.
- Do not share one OAuth client to work around testing-user, audit, or quota restrictions.
- Revoke access through the Google Account security page if a token or client is exposed, then
  replace the affected material.

## Official sources

- [OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [YouTube installed-app authorization](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- [OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [YouTube Data API overview](https://developers.google.com/youtube/v3/getting-started)
- [Official YouTube v3 discovery document](https://raw.githubusercontent.com/googleapis/google-api-go-client/main/youtube/v3/youtube-api.json)
