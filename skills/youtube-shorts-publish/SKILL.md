---
name: youtube-shorts-publish
description: >
  Inspect, plan, authenticate, upload, schedule, and verify YouTube Shorts through the official
  YouTube Data API, for the user's own channel. Use whenever someone asks to upload, publish,
  post, or schedule a YouTube Short; check whether a video qualifies as a Short; safely dry-run a
  YouTube upload; configure YouTube upload OAuth; diagnose a Short stuck processing, rejected, or
  unexpectedly private; or verify an upload by video ID. Handles local ffprobe media checks,
  Desktop OAuth, private-by-default resumable uploads, Made for Kids and synthetic-media
  declarations, and post-upload processing checks. Not for generating or editing the video, bulk
  multi-channel posting, evading platform enforcement, or claiming Shorts Feed placement that the
  API cannot prove.
---

# Publish YouTube Shorts safely

Use the bundled zero-dependency Node CLI. It separates local eligibility, API acceptance, video
processing, visibility, and Shorts classification instead of treating them as one success state.

## Non-negotiable safety rules

- Work with one channel owned or controlled by the user. Never rotate accounts, proxies, or OAuth
  clients to evade quotas or enforcement.
- Run a dry plan before every upload. `plan` never reads OAuth files, contacts Google, or writes
  local state. `publish` without `--yes` has the same guarantee.
- Only add `--yes` and the reviewed `--expected-plan-id` when the user's request clearly authorizes
  that exact upload and the plan's channel, source SHA-256, title, visibility, schedule, and
  declarations match their intent.
- Keep the default `private` unless the user explicitly asks for `public`, `unlisted`, or a future
  publication time. Scheduling a private video means it will become public later.
- Never infer whether content is Made for Kids or contains realistic altered/synthetic media.
  Obtain explicit `yes` or `no` choices for both.
- Use the channel ID returned by `auth`; the CLI refuses a write if the authorized channel differs.
- Treat a `plan_id` as one-shot. Before creating an upload session, the CLI stores a receipt and a
  read-only snapshot matching the reviewed SHA-256. A previous receipt blocks the same plan by
  default, including after crashes and ambiguous responses.
- After an upload returns an ID, check that ID. Never search by title, delete a same-title video,
  or blindly upload again because processing or verification timed out.
- Call an eligible upload a **Shorts candidate**. The Data API has no Shorts classification field,
  so do not claim confirmed Shorts Feed placement.

## Locate the CLI

Commands below assume the current directory is this skill directory. Otherwise use the absolute
path to `scripts/ytshorts.mjs`. Pass an absolute path for the source video when changing directories.

```bash
node scripts/ytshorts.mjs --help
node scripts/ytshorts.mjs doctor
```

Requirements are Node.js 20+ and `ffprobe`. There are no npm runtime dependencies.

## First-time authorization

Read [OAuth setup](references/oauth-setup.md), then run:

```bash
node scripts/ytshorts.mjs auth
```

The system browser handles Google consent through a Desktop-app loopback flow. It requests
`youtube.upload` for insertion and `youtube.readonly` for the channel guard and owner-only status
read-back. Record the returned `channel_id`; pass it to every plan and publish command. Never open
or print the token file. If authorization is not needed for the current task, do not run `auth`
speculatively.

## Inspect local media

```bash
node scripts/ytshorts.mjs inspect /absolute/path/short.mp4
```

Treat `shorts_candidate: true` as a local check against the published duration and displayed aspect
rules. Rotation and sample aspect ratio are applied before deciding whether the video is square or
vertical. A missing audio track is only a warning. Landscape media, unknown duration, or duration
over 180 seconds blocks publishing.

If the video needs conversion, let the user choose crop versus padding and then consult
[media preparation](references/media-preparation.md). Do not silently alter their composition.

## Build an exact, side-effect-free plan

```bash
node scripts/ytshorts.mjs plan /absolute/path/short.mp4 \
  --title "Launch day in 30 seconds" \
  --description-file /absolute/path/description.txt \
  --channel-id UCxxxxxxxxxxxxxxxxxxxxxx \
  --privacy private \
  --made-for-kids no \
  --contains-synthetic-media no
```

Useful metadata flags:

- `--tag value` is repeatable; comma-separated values also work.
- `--category-id 22` defaults to People & Blogs.
- `--notify-subscribers yes|no` defaults to `no`.
- `--default-language en` sets the metadata language.
- `--publish-at 2026-08-10T09:00:00+08:00` requires `--privacy private` and represents future
  public visibility. It must remain at least 30 minutes away throughout session creation and chunk
  transfer; otherwise the CLI stops rather than risk a past timestamp becoming public immediately.

Inspect `safe_to_publish`, `blocking_issues`, `warnings`, `target`, source `sha256`, `plan_id`, and
the exact API `request` (including `notifySubscribers`). Resolve every blocker before proceeding.
The channel is verified online only after confirmation; the plan marks that explicitly.

## Publish only after reviewing the plan

The same command without `--yes` is still a dry run:

```bash
node scripts/ytshorts.mjs publish /absolute/path/short.mp4 \
  --title "Launch day in 30 seconds" \
  --channel-id UCxxxxxxxxxxxxxxxxxxxxxx \
  --privacy private \
  --made-for-kids no \
  --contains-synthetic-media no
```

For a user-authorized real upload, repeat the unchanged command with the dry run's `plan_id` and
`--yes`:

```bash
node scripts/ytshorts.mjs publish /absolute/path/short.mp4 \
  --title "Launch day in 30 seconds" \
  --channel-id UCxxxxxxxxxxxxxxxxxxxxxx \
  --privacy private \
  --made-for-kids no \
  --contains-synthetic-media no \
  --expected-plan-id PLAN_ID_FROM_DRY_RUN \
  --yes
```

The CLI hashes the video and canonical request again before touching OAuth. A changed video,
description file, metadata flag, or target produces `PLAN_CHANGED` and no upload starts. After the
channel check it copies those reviewed bytes to a `0400` local snapshot and atomically creates an
operation receipt immediately before mutation.

The uploader creates one resumable session, sends fixed 8 MiB chunks, follows YouTube's `308 Range`
offset after interruptions, renews OAuth access before expiry without restarting the session, and
polls the returned video ID for up to 60 seconds by default. Set `--wait-seconds 0..900` to change
that window. Progress goes to stderr; structured results go to stdout.

One `plan_id` gets one upload attempt by default. Receipts live under the configured
`operations/` directory and contain no OAuth token or resumable session URL. If a prior attempt is
ambiguous, inspect its receipt and YouTube Studio. Only after confirming no video exists may the
user explicitly authorize the same command with `--new-attempt`; never add that flag automatically.
The CLI permits at most one such exceptional retry and refuses it when any prior receipt already
contains a video ID. It also requires the primary receipt itself to say `ambiguous`; a preparing or
active-looking receipt is fail-closed so a second process cannot upload concurrently.

## Interpret and recheck the result

| state | meaning | next action |
|---|---|---|
| `uploaded_processing` | bytes arrived; YouTube is still processing | wait, then run `status`; do not re-upload |
| `processed_private` | processing succeeded; actual visibility is private | review metadata or publish manually when intended |
| `processed_unlisted` / `processed_public` | processing and requested visibility succeeded | report success, still as a Shorts candidate |
| `processed_scheduled` | processing succeeded and future public release remains scheduled | report the schedule and preserve private-until-publish state |
| `processing_failed` / `rejected` | YouTube failed or rejected the video | report the returned reason; fix before a new upload |
| `verification_timeout` | a video ID exists, but the wait window ended | run `status VIDEO_ID`; do not re-upload |
| `not_found_after_insert` | ID returned but read-back is not visible yet | preserve the ID and recheck; treat outcome as unresolved |

```bash
node scripts/ytshorts.mjs status VIDEO_ID
node scripts/ytshorts.mjs status VIDEO_ID --wait-seconds 120
```

If public or unlisted was requested but read-back says private, report `privacy_restricted` and
explain that an unaudited API project is a common cause. Do not auto-update visibility. Read
[YouTube API and Shorts behavior](references/youtube-api-and-shorts.md) before diagnosing policy,
quota, Content ID, scheduling, or classification behavior.

For `publish`, top-level `upload_accepted: true` means YouTube returned a video ID. Top-level
`ok: true` requires semantic verification too. A false `ok` with a video ID is not permission to
retry; follow `verification.state` and the receipt.

## Troubleshooting

| symptom | likely cause | response |
|---|---|---|
| `FFPROBE_NOT_FOUND` | ffprobe is not installed or not on PATH | install FFmpeg or set `YTSHORTS_FFPROBE_BIN` |
| `CLIENT_SECRETS_NOT_FOUND` | Desktop OAuth JSON is not configured | follow `references/oauth-setup.md` |
| `OAUTH_REAUTH_REQUIRED` | token revoked/expired; Testing projects often expire it after 7 days | run `auth` again; review consent-screen publishing status |
| `OAUTH_REFRESH_TOKEN_REQUIRED` | stored authorization cannot renew during a long upload | run `auth` again; do not substitute a short-lived access token |
| `CHANNEL_MISMATCH` | Google authorized a different channel | stop; authorize/select the intended channel or correct `--channel-id` |
| `PLAN_CHANGED` | source bytes or normalized request differ from the reviewed dry run | inspect the new plan; never reuse the old ID |
| `PLAN_ALREADY_ATTEMPTED` | this exact plan already has a durable receipt | inspect the receipt and Studio; default is never retry |
| `PLAN_VIDEO_ALREADY_EXISTS` | a prior receipt already records a YouTube video ID | check that video; this plan is permanently ineligible for retry |
| `PRIOR_ATTEMPT_NOT_AMBIGUOUS` | the prior receipt is preparing, active-looking, or completed | do not override it; this prevents concurrent duplicate uploads |
| `UPLOAD_OUTCOME_AMBIGUOUS` | a session started but completion could not be proven | do not repeat; inspect Studio, then require explicit user approval for `--new-attempt` if absent |
| requested public, actual private | API project may require a YouTube compliance audit | keep the video private and follow Google's audit path |
| state remains processing | normal asynchronous transcode or an eventual processing issue | re-run `status`; never duplicate the upload |

Do not expose OAuth codes, bearer/refresh tokens, client secrets, or resumable session URLs in chat,
logs, commits, or issue reports.
