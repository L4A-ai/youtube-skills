import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export const SHORT_MAX_SECONDS = 180;
export const MAX_UPLOAD_BYTES = 274_877_906_944;
export const MIN_SCHEDULE_LEAD_SECONDS = 1800;
export const DEFAULT_CATEGORY_ID = "22";
export const PRIVACY_VALUES = new Set(["private", "unlisted", "public"]);

export class YtShortsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "YtShortsError";
    this.code = code;
    this.details = details;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedRotation(stream) {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const sideRotation = sideData.find((entry) => finiteNumber(entry?.rotation) !== null)?.rotation;
  const raw = sideRotation ?? stream.tags?.rotate ?? 0;
  const rotation = finiteNumber(raw) ?? 0;
  return ((rotation % 360) + 360) % 360;
}

function sampleAspectRatio(stream) {
  const match = String(stream.sample_aspect_ratio ?? "1:1").match(/^(\d+):(\d+)$/u);
  if (!match || Number(match[2]) === 0) return 1;
  return Number(match[1]) / Number(match[2]);
}

function displayedDimensions(stream) {
  const width = finiteNumber(stream.width);
  const height = finiteNumber(stream.height);
  if (!width || !height) return { width: null, height: null };
  const displayWidth = width * sampleAspectRatio(stream);
  const rotation = normalizedRotation(stream);
  const swapsAxes = rotation === 90 || rotation === 270;
  return swapsAxes
    ? { width: height, height: displayWidth }
    : { width: displayWidth, height };
}

export function analyzeProbe(probe, source = null) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const videoStreams = streams.filter(
    (stream) => stream.codec_type === "video" && Number(stream.disposition?.attached_pic ?? 0) !== 1,
  );
  if (videoStreams.length === 0) {
    throw new YtShortsError("MEDIA_NO_VIDEO", "The file does not contain a usable video stream.");
  }

  const video = videoStreams[0];
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
  const dimensions = displayedDimensions(video);
  const duration =
    finiteNumber(probe?.format?.duration) ?? finiteNumber(video.duration) ?? finiteNumber(audio?.duration);
  const sizeBytes = finiteNumber(probe?.format?.size);
  const issues = [];
  const warnings = [];

  if (duration === null || duration <= 0) {
    issues.push({ code: "DURATION_UNKNOWN", message: "Could not determine a positive duration." });
  } else if (duration > SHORT_MAX_SECONDS) {
    issues.push({
      code: "DURATION_TOO_LONG",
      message: `Duration ${duration.toFixed(3)}s exceeds the ${SHORT_MAX_SECONDS}s Shorts limit.`,
    });
  }

  if (!dimensions.width || !dimensions.height) {
    issues.push({ code: "DIMENSIONS_UNKNOWN", message: "Could not determine displayed dimensions." });
  } else if (dimensions.width > dimensions.height) {
    issues.push({
      code: "LANDSCAPE_VIDEO",
      message: `Displayed dimensions ${dimensions.width}x${dimensions.height} are landscape, not square or vertical.`,
    });
  }

  if (!audio) {
    warnings.push({ code: "NO_AUDIO", message: "No audio stream was detected; silent Shorts are allowed." });
  }
  if (duration !== null && duration >= 179.5 && duration <= SHORT_MAX_SECONDS) {
    warnings.push({
      code: "DURATION_AT_LIMIT",
      message: "Duration is within 0.5 seconds of the Shorts limit; trim slightly to avoid container/timestamp edge cases.",
    });
  }
  if (duration !== null && duration > 60 && duration <= SHORT_MAX_SECONDS) {
    warnings.push({
      code: "CONTENT_ID_BLOCK_RISK",
      message:
        "YouTube globally blocks Shorts over one minute while any active Content ID claim remains; local inspection cannot detect claims.",
    });
  }
  if (video.codec_name && video.codec_name !== "h264") {
    warnings.push({
      code: "NON_H264_VIDEO",
      message: `Video codec is ${video.codec_name}; H.264 is a conservative compatibility choice, but this is not a blocker.`,
    });
  }
  if (audio?.codec_name && audio.codec_name !== "aac") {
    warnings.push({
      code: "NON_AAC_AUDIO",
      message: `Audio codec is ${audio.codec_name}; AAC is a conservative compatibility choice, but this is not a blocker.`,
    });
  }

  return {
    source,
    duration_seconds: duration,
    stored_dimensions: {
      width: finiteNumber(video.width),
      height: finiteNumber(video.height),
    },
    displayed_dimensions: dimensions,
    sample_aspect_ratio: video.sample_aspect_ratio ?? null,
    rotation_degrees: normalizedRotation(video),
    aspect: dimensions.width && dimensions.height
      ? dimensions.width === dimensions.height
        ? "square"
        : dimensions.width < dimensions.height
          ? "vertical"
          : "landscape"
      : "unknown",
    video_codec: video.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    has_audio: Boolean(audio),
    size_bytes: sizeBytes,
    shorts_candidate: issues.length === 0,
    classification_note:
      "This is a local eligibility check. The YouTube Data API does not expose or set a Shorts classification flag.",
    issues,
    warnings,
  };
}

export async function probeMedia(inputPath, options = {}) {
  const resolved = path.resolve(inputPath);
  try {
    await access(resolved);
  } catch {
    throw new YtShortsError("MEDIA_NOT_FOUND", `Video file not found: ${resolved}`);
  }
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new YtShortsError("MEDIA_NOT_FILE", `Video path is not a regular file: ${resolved}`);
  }
  if (fileStat.size === 0) {
    throw new YtShortsError("MEDIA_EMPTY", `Video file is empty: ${resolved}`);
  }

  const ffprobe = options.ffprobeBin ?? process.env.YTSHORTS_FFPROBE_BIN ?? "ffprobe";
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    resolved,
  ];
  const [output, sha256] = await Promise.all([
    run(ffprobe, args, { maxBytes: 8 * 1024 * 1024 }),
    hashFile(resolved),
  ]);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new YtShortsError("FFPROBE_INVALID_JSON", "ffprobe returned invalid JSON.", {
      cause: error.message,
    });
  }
  const after = await stat(resolved);
  if (after.size !== fileStat.size || after.mtimeMs !== fileStat.mtimeMs) {
    throw new YtShortsError(
      "MEDIA_CHANGED_DURING_INSPECTION",
      "The video changed while it was being inspected and hashed. Stop the writer and try again.",
    );
  }
  const analysis = { ...analyzeProbe(parsed, resolved), sha256, size_bytes: fileStat.size };
  if (fileStat.size > MAX_UPLOAD_BYTES) {
    analysis.issues.push({
      code: "MEDIA_TOO_LARGE",
      message: "The file exceeds YouTube's general 256 GB upload limit.",
    });
    analysis.shorts_candidate = false;
  }
  return analysis;
}

export function parseYesNo(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["yes", "true", "1"].includes(normalized)) return true;
  if (["no", "false", "0"].includes(normalized)) return false;
  throw new YtShortsError("INVALID_BOOLEAN", `${fieldName} must be yes or no.`);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function normalizedTags(tags) {
  const result = [];
  for (const raw of tags ?? []) {
    for (const value of String(raw).split(",")) {
      const tag = value.trim();
      if (tag && !result.includes(tag)) result.push(tag);
    }
  }
  return result;
}

function tagsLength(tags) {
  return tags.reduce((total, tag, index) => {
    const characterLength = Array.from(tag).length;
    const quotedLength = tag.includes(" ") ? characterLength + 2 : characterLength;
    return total + quotedLength + (index === 0 ? 0 : 1);
  }, 0);
}

export function buildPublishPlan(media, options = {}, now = new Date()) {
  const title = String(options.title ?? "").trim();
  const description = String(options.description ?? "");
  const privacy = String(options.privacy ?? "private").toLowerCase();
  const categoryId = String(options.categoryId ?? DEFAULT_CATEGORY_ID);
  const tags = normalizedTags(options.tags);
  const madeForKids = parseYesNo(options.madeForKids, "--made-for-kids");
  const containsSyntheticMedia = parseYesNo(
    options.containsSyntheticMedia,
    "--contains-synthetic-media",
  );
  const notifySubscribers = parseYesNo(options.notifySubscribers ?? "no", "--notify-subscribers");
  const blockingIssues = [...(media.issues ?? [])];

  if (!options.channelId) {
    blockingIssues.push({
      code: "CHANNEL_ID_REQUIRED",
      message: "Set --channel-id to the exact channel returned by auth before publishing.",
    });
  } else if (!/^UC[A-Za-z0-9_-]{22}$/u.test(String(options.channelId))) {
    blockingIssues.push({ code: "INVALID_CHANNEL_ID", message: "--channel-id is not a valid YouTube channel ID." });
  }

  if (!title) {
    blockingIssues.push({ code: "TITLE_REQUIRED", message: "A non-empty --title is required." });
  } else if (Array.from(title).length > 100) {
    blockingIssues.push({ code: "TITLE_TOO_LONG", message: "Title exceeds 100 characters." });
  } else if (/[<>]/u.test(title)) {
    blockingIssues.push({ code: "TITLE_INVALID_CHAR", message: "Title cannot contain < or >." });
  }

  if (byteLength(description) > 5000) {
    blockingIssues.push({
      code: "DESCRIPTION_TOO_LONG",
      message: "Description exceeds the API limit of 5000 UTF-8 bytes.",
    });
  } else if (/[<>]/u.test(description)) {
    blockingIssues.push({ code: "DESCRIPTION_INVALID_CHAR", message: "Description cannot contain < or >." });
  }
  if (!PRIVACY_VALUES.has(privacy)) {
    blockingIssues.push({
      code: "INVALID_PRIVACY",
      message: "--privacy must be private, unlisted, or public.",
    });
  }
  if (!/^\d+$/u.test(categoryId)) {
    blockingIssues.push({ code: "INVALID_CATEGORY", message: "--category-id must be numeric." });
  }
  if (tagsLength(tags) > 500) {
    blockingIssues.push({ code: "TAGS_TOO_LONG", message: "Tags exceed the API's 500-character encoding limit." });
  }
  if (madeForKids === null) {
    blockingIssues.push({
      code: "AUDIENCE_DECLARATION_REQUIRED",
      message: "Explicitly set --made-for-kids yes|no before publishing.",
    });
  }
  if (containsSyntheticMedia === null) {
    blockingIssues.push({
      code: "SYNTHETIC_MEDIA_DECLARATION_REQUIRED",
      message: "Explicitly set --contains-synthetic-media yes|no before publishing.",
    });
  }

  let publishAt = null;
  if (options.publishAt) {
    const rawPublishAt = String(options.publishAt);
    const hasExplicitZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      rawPublishAt,
    );
    const parsed = new Date(rawPublishAt);
    if (!hasExplicitZone || Number.isNaN(parsed.getTime())) {
      blockingIssues.push({
        code: "INVALID_PUBLISH_AT",
        message: "--publish-at must be an ISO 8601 timestamp with an explicit Z or UTC offset.",
      });
    } else if (parsed.getTime() <= now.getTime()) {
      blockingIssues.push({ code: "PUBLISH_AT_NOT_FUTURE", message: "--publish-at must be in the future." });
    } else if (parsed.getTime() < now.getTime() + MIN_SCHEDULE_LEAD_SECONDS * 1000) {
      blockingIssues.push({
        code: "PUBLISH_AT_TOO_CLOSE",
        message: `--publish-at must be at least ${MIN_SCHEDULE_LEAD_SECONDS / 60} minutes in the future to prevent it passing during authorization/upload setup.`,
      });
    } else if (privacy !== "private") {
      blockingIssues.push({
        code: "SCHEDULE_REQUIRES_PRIVATE",
        message: "YouTube requires privacyStatus=private when status.publishAt is set.",
      });
    } else {
      publishAt = parsed.toISOString();
    }
  }

  const snippet = { title, description, categoryId };
  if (tags.length > 0) snippet.tags = tags;
  if (options.defaultLanguage) snippet.defaultLanguage = String(options.defaultLanguage);

  const status = { privacyStatus: privacy };
  if (madeForKids !== null) status.selfDeclaredMadeForKids = madeForKids;
  if (containsSyntheticMedia !== null) status.containsSyntheticMedia = containsSyntheticMedia;
  if (publishAt) status.publishAt = publishAt;

  const request = {
    part: ["snippet", "status"],
    query: { notifySubscribers },
    body: { snippet, status },
  };
  const target = {
    expected_channel_id: options.channelId ?? null,
    channel_verification: "deferred_until_publish",
    privacy,
    scheduled_publish_at: publishAt,
    eventual_visibility: publishAt ? "public_at_scheduled_time" : privacy,
    notify_subscribers: notifySubscribers,
  };
  const planId = createHash("sha256")
    .update(
      JSON.stringify({
        policy_version: "2026-08-02",
        source: {
          sha256: media.sha256 ?? null,
          size_bytes: media.size_bytes ?? null,
          duration_seconds: media.duration_seconds ?? null,
          displayed_dimensions: media.displayed_dimensions ?? null,
        },
        target,
        request,
      }),
    )
    .digest("hex");

  return {
    schema_version: 1,
    policy_version: "2026-08-02",
    plan_id: planId,
    operation: "youtube.videos.insert",
    executed: false,
    video: media,
    target,
    request,
    safe_to_publish: blockingIssues.length === 0,
    blocking_issues: blockingIssues,
    warnings: [
      ...(media.warnings ?? []),
      {
        code: "SHORTS_CLASSIFICATION_NOT_IN_API",
        message: "Upload success does not prove Shorts classification; YouTube categorizes eligible media after upload.",
      },
      ...(privacy !== "private" || publishAt
        ? [{
            code: "EXTERNAL_VISIBILITY",
            message: publishAt
              ? `The video is scheduled to become public at ${publishAt}.`
              : `The requested privacy is ${privacy}.`,
          }]
        : []),
    ],
  };
}

export function parseIsoDuration(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function summarizeVideo(video) {
  if (!video) {
    return { state: "not_found", terminal: true };
  }
  const upload = video.status?.uploadStatus ?? null;
  const processing = video.processingDetails?.processingStatus ?? null;
  const privacy = video.status?.privacyStatus ?? null;
  let state = "uploaded_unknown";
  let terminal = false;

  if (upload === "failed" || processing === "failed") {
    state = "processing_failed";
    terminal = true;
  } else if (upload === "rejected") {
    state = "rejected";
    terminal = true;
  } else if (upload === "deleted") {
    state = "deleted";
    terminal = true;
  } else if (processing === "succeeded" || upload === "processed") {
    state = video.status?.publishAt ? "processed_scheduled" : `processed_${privacy ?? "unknown"}`;
    terminal = true;
  } else if (processing === "processing" || upload === "uploaded") {
    state = "uploaded_processing";
  } else if (processing === "terminated") {
    state = "processing_status_unavailable";
    terminal = true;
  }

  const durationSeconds = parseIsoDuration(video.contentDetails?.duration);
  return {
    state,
    terminal,
    video_id: video.id,
    title: video.snippet?.title ?? null,
    channel_id: video.snippet?.channelId ?? null,
    privacy_status: privacy,
    scheduled_publish_at: video.status?.publishAt ?? null,
    upload_status: upload,
    processing_status: processing,
    failure_reason:
      video.status?.failureReason ??
      video.processingDetails?.processingFailureReason ??
      video.status?.rejectionReason ??
      null,
    duration_seconds: durationSeconds,
    shorts_duration_candidate: durationSeconds === null ? null : durationSeconds <= SHORT_MAX_SECONDS,
    shorts_classification: "not_exposed_by_youtube_data_api",
    watch_url: video.id ? `https://www.youtube.com/watch?v=${video.id}` : null,
    shorts_candidate_url: video.id ? `https://www.youtube.com/shorts/${video.id}` : null,
  };
}

export function verifyVideoAgainstPlan(video, plan) {
  const summary = summarizeVideo(video);
  if (!video) {
    return { ...summary, verified: false, mismatches: [{ field: "video", expected: "present", actual: null }] };
  }
  const expected = plan.request.body;
  const mismatches = [];
  const compare = (field, expectedValue, actualValue) => {
    const dateField = field === "status.publishAt";
    const expectedSerialized =
      dateField && expectedValue !== undefined ? new Date(expectedValue).getTime() : JSON.stringify(expectedValue);
    const actualSerialized =
      dateField && actualValue !== undefined ? new Date(actualValue).getTime() : JSON.stringify(actualValue);
    if (expectedValue !== undefined && expectedSerialized !== actualSerialized) {
      mismatches.push({ field, expected: expectedValue, actual: actualValue ?? null });
    }
  };
  compare("snippet.title", expected.snippet.title, video.snippet?.title);
  compare("snippet.description", expected.snippet.description, video.snippet?.description);
  compare("snippet.categoryId", expected.snippet.categoryId, video.snippet?.categoryId);
  compare("snippet.channelId", plan.target.expected_channel_id, video.snippet?.channelId);
  compare("snippet.tags", expected.snippet.tags, video.snippet?.tags);
  compare("snippet.defaultLanguage", expected.snippet.defaultLanguage, video.snippet?.defaultLanguage);
  compare("status.privacyStatus", expected.status.privacyStatus, video.status?.privacyStatus);
  compare("status.publishAt", expected.status.publishAt, video.status?.publishAt);
  compare(
    "status.selfDeclaredMadeForKids",
    expected.status.selfDeclaredMadeForKids,
    video.status?.selfDeclaredMadeForKids,
  );
  compare(
    "status.containsSyntheticMedia",
    expected.status.containsSyntheticMedia,
    video.status?.containsSyntheticMedia,
  );
  const privacyRestricted =
    ["public", "unlisted"].includes(expected.status.privacyStatus) && video.status?.privacyStatus === "private";
  const durationEligible = summary.duration_seconds !== null && summary.duration_seconds <= SHORT_MAX_SECONDS;
  return {
    ...summary,
    verified:
      summary.state.startsWith("processed_") && mismatches.length === 0 && !privacyRestricted && durationEligible,
    shorts_duration_verified: durationEligible,
    eligibility_note: durationEligible
      ? null
      : "Processed duration is missing or exceeds 180 seconds, so this cannot be verified as a Shorts-eligible upload.",
    privacy_restricted: privacyRestricted,
    restriction_note: privacyRestricted
      ? "The API returned private despite a public/unlisted request. An unaudited API project is a common cause."
      : null,
    mismatches,
  };
}

function run(command, args, { maxBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill();
        reject(new YtShortsError("COMMAND_OUTPUT_TOO_LARGE", `${command} output exceeded the safety limit.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });
    child.on("error", (error) => {
      const code = error.code === "ENOENT" ? "FFPROBE_NOT_FOUND" : "COMMAND_FAILED";
      reject(new YtShortsError(code, `Could not run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new YtShortsError("FFPROBE_FAILED", `${command} exited with code ${code}.`, {
            stderr: Buffer.concat(stderr).toString("utf8").trim(),
          }),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => {
      reject(new YtShortsError("MEDIA_HASH_FAILED", `Could not hash source video: ${error.message}`));
    });
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
