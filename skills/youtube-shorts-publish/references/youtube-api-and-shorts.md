# YouTube API and Shorts behavior

Verified against official Google/YouTube documentation on 2026-08-02. Recheck these sources before
changing platform rules or quota assumptions.

## Shorts eligibility versus API proof

For standard channels, videos uploaded now are categorized as Shorts when they are square or
vertical and no longer than three minutes. Official Artist Channels have followed the same rule for
uploads since 2025-12-08.

The `videos.insert` request and the `video` resource have no `shorts`, `isShort`, or Shorts Feed
field. The inference is therefore:

1. The CLI can establish whether local media matches the published duration/aspect rules.
2. YouTube categorizes the uploaded video on the service side.
3. The Data API can verify upload, processing, metadata, and visibility, but not Shorts Feed
   classification or distribution.

Do not add `#Shorts` as a fake classification switch. It may be ordinary metadata, but it is not a
required API field or a substitute for eligible media.

Important Content ID edge case: a Short longer than one minute with an active Content ID claim of
any kind is blocked globally until the claim is resolved. Processing success alone does not prove
that the video is playable.

Sources:

- [Understand three-minute YouTube Shorts](https://support.google.com/youtube/answer/15424877?hl=en)
- [Video resource](https://developers.google.com/youtube/v3/docs/videos)
- [`videos.insert`](https://developers.google.com/youtube/v3/docs/videos/insert)

## Upload and quota

`videos.insert` accepts `video/*` or `application/octet-stream`, with a discovery-document maximum
of 274,877,906,944 bytes (256 GiB). Its upload authorization scope is:

```text
https://www.googleapis.com/auth/youtube.upload
```

The channel guard and owner-only processing verification additionally require:

```text
https://www.googleapis.com/auth/youtube.readonly
```

The current discovery document lists upload scope for `videos.insert`, but not for `channels.list`
or `videos.list`; the CLI requests both scopes in one installed-app authorization.

As of the verification date, uploads use a dedicated Video Uploads quota bucket: the default is 100
`videos.insert` calls per day, and each call costs one unit in that bucket. Older references to a
1,600-unit upload cost are stale. Other endpoint calls use their applicable quota bucket.

Projects created after 2020-07-28 that have not passed the YouTube API compliance audit have API
uploads restricted to private viewing. Always read back actual `status.privacyStatus`; do not trust
requested visibility.

Sources:

- [`videos.insert`](https://developers.google.com/youtube/v3/docs/videos/insert)
- [Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [API revision history](https://developers.google.com/youtube/v3/revision_history)
- [Official YouTube v3 discovery document](https://raw.githubusercontent.com/googleapis/google-api-go-client/main/youtube/v3/youtube-api.json)

## Resumable behavior

The bundled uploader follows the official protocol:

1. `POST .../videos?uploadType=resumable` with metadata and upload length/type.
2. Keep the returned `Location` in memory.
3. `PUT` fixed 8 MiB chunks. Eight MiB is a multiple of 256 KiB.
4. On `308 Resume Incomplete`, continue at one byte after the server's `Range` endpoint.
5. After a network interruption or `500`, `502`, `503`, or `504`, back off and query the session
   using an empty `PUT` with `Content-Range: bytes */TOTAL`; honor `Retry-After` when present and
   never guess the received offset.
6. Renew OAuth access before expiry and continue against the same in-memory session URL.
7. If a final `200`/`201` body is lost or lacks an ID, query that same session before declaring the
   outcome unresolved.
8. Treat the final resource ID as upload acceptance, not processing completion.

If the process itself dies, the current version does not persist the capability-bearing session
URL. Its receipt remains active-looking and exact-plan retry fails closed, because the CLI cannot
prove that another process is not still uploading. Inspect the channel and preserve the receipt;
do not delete it merely to force a retry.

Source: [Resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)

## Metadata and scheduling

- Title: maximum 100 characters; `<` and `>` are disallowed.
- Description: maximum 5,000 UTF-8 bytes; `<` and `>` are disallowed.
- Tags: encoded total maximum 500 characters; commas and quotes around tags containing spaces count.
- `status.selfDeclaredMadeForKids` lets the owner explicitly declare the audience.
- `status.containsSyntheticMedia` discloses realistic altered or synthetic content.
- `status.publishAt` can be set only while `privacyStatus` is `private`; scheduling represents later
  public visibility. This CLI requires an explicit timezone and a 30-minute safety margin, checked
  before every resumable request so retries or transfer time cannot turn the timestamp into an
  accidental immediate publication. For a closer release, upload privately and schedule in Studio.
- `notifySubscribers` defaults to `false` in this CLI even though the API default is `true`.

Sources:

- [Video resource fields](https://developers.google.com/youtube/v3/docs/videos)
- [Required minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [Altered or synthetic content disclosure](https://support.google.com/youtube/answer/14328491)

## Post-upload verification

Read the returned ID with:

```text
videos.list?part=id,snippet,status,processingDetails,contentDetails&id=VIDEO_ID
```

Owner authorization is required for processing details. Distinguish:

- `status.uploadStatus`: `uploaded`, `processed`, `failed`, `rejected`, or `deleted`.
- `processingDetails.processingStatus`: `processing`, `succeeded`, `failed`, or `terminated`.
- `failureReason`, `rejectionReason`, or `processingFailureReason` when present.
- requested versus actual privacy, schedule, category, title, audience, and disclosure.

An ID plus `uploaded_processing` is a real created video and must not be uploaded again merely
because it is not playable yet.

Sources:

- [Check an uploaded video's status](https://developers.google.com/youtube/v3/guides/implementation/videos#check_the_status_of_an_uploaded_video)
- [`videos.list`](https://developers.google.com/youtube/v3/docs/videos/list)
