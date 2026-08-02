#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  MIN_SCHEDULE_LEAD_SECONDS,
  YtShortsError,
  buildPublishPlan,
  probeMedia,
  summarizeVideo,
  verifyVideoAgainstPlan,
} from "./ytshorts-lib.mjs";

const HELP = `ytshorts — inspect, plan, and publish YouTube Shorts safely

Usage:
  ytshorts doctor [--client-secrets PATH] [--token PATH]
  ytshorts inspect VIDEO
  ytshorts plan VIDEO --title TITLE --channel-id CHANNEL [metadata]
  ytshorts auth [--client-secrets PATH] [--token PATH] [--no-open]
  ytshorts publish VIDEO --title TITLE --channel-id CHANNEL [metadata] [--yes]
  ytshorts status VIDEO_ID [--wait-seconds 0]

Metadata:
  --description TEXT | --description-file PATH
  --tag TAG                         repeatable; comma-separated also accepted
  --category-id ID                  default: 22 (People & Blogs)
  --privacy private|unlisted|public default: private
  --publish-at ISO8601              scheduled publishing requires private
  --made-for-kids yes|no            required before a real upload
  --contains-synthetic-media yes|no required before a real upload
  --notify-subscribers yes|no       default: no
  --default-language BCP47

Confirmation for a real upload:
  --expected-plan-id SHA256         plan_id from the reviewed dry run
  --yes                             execute this one upload
  --new-attempt                     only after checking Studio for a prior ambiguous attempt

Safety:
  plan is strictly read-only. publish without --yes is also a dry run and does
  not load OAuth credentials or contact Google. A real upload requires --yes,
  --expected-plan-id from the reviewed dry run, an explicit channel ID, and
  both compliance declarations.

Environment:
  YTSHORTS_CONFIG_DIR, YTSHORTS_CLIENT_SECRETS, YTSHORTS_TOKEN_PATH,
  YTSHORTS_FFPROBE_BIN
`;

async function main() {
  const { command, positionals, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    process.stdout.write(HELP);
    return;
  }
  validateOptions(command, options);

  if (command === "inspect") {
    const videoPath = requiredPositional(positionals, 0, "VIDEO");
    rejectExtraPositionals(positionals, 1);
    print({ ok: true, command, media: await probeMedia(videoPath) });
    return;
  }

  if (command === "plan" || command === "publish") {
    const videoPath = requiredPositional(positionals, 0, "VIDEO");
    rejectExtraPositionals(positionals, 1);
    const plan = await createPlan(videoPath, options);
    if (command === "plan" || !options.yes) {
      print({
        ok: true,
        command,
        dry_run: true,
        dry_run_completed: true,
        ready_to_publish: plan.safe_to_publish,
        network_requests: 0,
        local_writes: 0,
        plan,
        next_step:
          plan.safe_to_publish
            ? `Review the plan, then pass --expected-plan-id ${plan.plan_id} with --yes on the unchanged publish command.`
            : "Resolve every blocking issue, then generate a new plan.",
      });
      return;
    }
    if (!plan.safe_to_publish) {
      throw new YtShortsError("PREFLIGHT_BLOCKED", "Publishing is blocked by the plan's validation issues.", {
        blocking_issues: plan.blocking_issues,
      });
    }
    if (!options["expected-plan-id"]) {
      throw new YtShortsError(
        "EXPECTED_PLAN_ID_REQUIRED",
        "A real upload requires --expected-plan-id from the reviewed dry run. OAuth was not loaded.",
        { actual_plan_id: plan.plan_id },
      );
    }
    if (options["expected-plan-id"] !== plan.plan_id) {
      throw new YtShortsError(
        "PLAN_CHANGED",
        "The source bytes or normalized upload request changed after review. OAuth was not loaded.",
        { expected_plan_id: options["expected-plan-id"], actual_plan_id: plan.plan_id },
      );
    }
    await publish(videoPath, plan, options);
    return;
  }

  if (command === "doctor") {
    rejectExtraPositionals(positionals, 0);
    await doctor(options);
    return;
  }

  if (command === "auth") {
    rejectExtraPositionals(positionals, 0);
    await auth(options);
    return;
  }

  if (command === "status") {
    const videoId = requiredPositional(positionals, 0, "VIDEO_ID");
    rejectExtraPositionals(positionals, 1);
    await status(videoId, options);
    return;
  }

  throw new YtShortsError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}

async function createPlan(videoPath, options) {
  const description = await readDescription(options);
  const media = await probeMedia(videoPath);
  return buildPublishPlan(media, {
    title: options.title,
    description,
    tags: asArray(options.tag),
    categoryId: options["category-id"],
    privacy: options.privacy,
    publishAt: options["publish-at"],
    madeForKids: options["made-for-kids"],
    containsSyntheticMedia: options["contains-synthetic-media"],
    notifySubscribers: options["notify-subscribers"],
    defaultLanguage: options["default-language"],
    channelId: options["channel-id"],
  });
}

async function doctor(options) {
  const api = await import("./ytshorts-api.mjs");
  const credentialFiles = await api.inspectCredentialFiles(apiOptions(options));
  let clientSecretsValid = null;
  let tokenValid = null;
  if (credentialFiles.client_secrets.exists) {
    try {
      await api.readClientSecrets(credentialFiles.client_secrets.path);
      clientSecretsValid = true;
    } catch {
      clientSecretsValid = false;
    }
  }
  if (credentialFiles.token.exists) {
    try {
      await api.readStoredToken(credentialFiles.token.path);
      tokenValid = true;
    } catch {
      tokenValid = false;
    }
  }
  const ffprobe = await commandVersion(process.env.YTSHORTS_FFPROBE_BIN ?? "ffprobe", ["-version"]);
  print({
    ok:
      ffprobe.available &&
      Number(process.versions.node.split(".")[0]) >= 20 &&
      clientSecretsValid !== false &&
      tokenValid !== false,
    command: "doctor",
    network_requests: 0,
    local_writes: 0,
    runtime: { node: process.version, supported: Number(process.versions.node.split(".")[0]) >= 20 },
    ffprobe,
    ready_for_auth: clientSecretsValid === true,
    ready_for_publish: clientSecretsValid === true && tokenValid === true,
    credentials: {
      ...credentialFiles,
      client_secrets_valid_desktop_app: clientSecretsValid,
      token_valid_scopes_and_permissions: tokenValid,
      note:
        "File contents and token values are never printed. doctor validates local shape, required scopes, and private permissions without contacting Google or refreshing tokens.",
    },
  });
}

async function auth(options) {
  const api = await import("./ytshorts-api.mjs");
  const authorization = await api.authorizeDesktop({
    ...apiOptions(options),
    openBrowser: !options["no-open"],
    onAuthorizationUrl: (url) => {
      process.stderr.write(`Authorize in your system browser. If it did not open, visit:\n${url}\n`);
    },
  });
  const channel = await api.getChannel(authorization.token.access_token);
  print({
    ok: true,
    command: "auth",
    authorized_scopes: api.OAUTH_SCOPES,
    channel,
    token_path: authorization.paths.tokenPath,
    next_step: `Pass --channel-id ${channel.channel_id} to plan and publish so the target is explicit.`,
  });
}

async function publish(videoPath, plan, options) {
  const [api, state] = await Promise.all([
    import("./ytshorts-api.mjs"),
    import("./ytshorts-state.mjs"),
  ]);
  const paths = api.configPaths(apiOptions(options));
  const previous = await state.findPrimaryAttempt(paths.configDir, plan.plan_id);
  if (previous && !options["new-attempt"]) {
    throw state.priorAttemptError(previous, previous.operation_file);
  }
  if (!previous && options["new-attempt"]) {
    throw new YtShortsError(
      "NEW_ATTEMPT_WITHOUT_PRIOR",
      "--new-attempt is only valid when this plan_id already has a receipt. Use the normal confirmed publish command.",
    );
  }
  if (previous && options["new-attempt"] && previous.video_id) {
    throw new YtShortsError(
      "PLAN_VIDEO_ALREADY_EXISTS",
      "The prior receipt already contains a YouTube video ID. Recheck that video; this plan cannot be uploaded again.",
      { previous_attempt: previous },
    );
  }
  if (previous && options["new-attempt"] && previous.state !== "ambiguous") {
    throw new YtShortsError(
      "PRIOR_ATTEMPT_NOT_AMBIGUOUS",
      "--new-attempt is allowed only after the prior process recorded an ambiguous outcome. Preparing, active, and completed attempts cannot be overridden.",
      { previous_attempt: previous },
    );
  }
  const authorization = await api.authorizedAccess(apiOptions(options));
  const channel = await api.getChannel(authorization.accessToken);
  if (channel.channel_id !== plan.target.expected_channel_id) {
    throw new YtShortsError(
      "CHANNEL_MISMATCH",
      `Authorized channel ${channel.channel_id} does not match --channel-id ${plan.target.expected_channel_id}. No upload started.`,
      { authorized_channel: channel },
    );
  }

  assertScheduleStillSafe(plan);
  const attempt = await state.claimUploadAttempt({
    configDir: paths.configDir,
    plan,
    sourcePath: videoPath,
    allowNewAttempt: Boolean(options["new-attempt"]),
  });
  let uploadAuthorization;
  let getUploadAuthorization;
  try {
    uploadAuthorization = await api.authorizedAccess({ ...apiOptions(options), forceRefresh: true });
    getUploadAuthorization = createAuthorizationProvider(api, options, uploadAuthorization);
    assertScheduleStillSafe(plan);
  } catch (error) {
    await state.cancelPreparedAttempt(attempt);
    throw error;
  }

  process.stderr.write(`Uploading to ${channel.title ?? channel.channel_id} (${channel.channel_id})...\n`);
  let lastPercent = -1;
  let inserted;
  let receipt;
  let mutationPossible = false;
  try {
    receipt = await state.updateUploadAttempt(attempt, {
      state: "upload_session_starting",
      mutation_possible: false,
    });
    inserted = await api.uploadVideoResumable({
      accessToken: uploadAuthorization.accessToken,
      accessTokenProvider: async () => (await getUploadAuthorization()).accessToken,
      filePath: attempt.snapshotPath,
      requestBody: plan.request.body,
      notifySubscribers: plan.request.query.notifySubscribers,
      beforeRequest: () => assertScheduleStillSafe(plan),
      requestTimeoutMs: () => uploadRequestTimeoutMs(plan),
      onMutationPossible: async () => {
        receipt = await state.updateUploadAttempt(attempt, {
          state: "upload_bytes_starting",
          mutation_possible: true,
        });
        mutationPossible = true;
      },
      onProgress: ({ uploaded_bytes: uploaded, total_bytes: total, resumed = false }) => {
        const percent = Math.floor((uploaded / total) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          process.stderr.write(`${resumed ? "Resumed" : "Uploaded"} ${percent}%\n`);
        }
      },
    });
    if (!inserted?.id) {
      throw new YtShortsError("UPLOAD_ID_MISSING", "YouTube accepted the transfer but returned no video ID.");
    }
    receipt = await state.updateUploadAttempt(attempt, {
      state: "upload_accepted",
      mutation_possible: true,
      video_id: inserted.id,
    });
  } catch (error) {
    if (!mutationPossible) {
      await state.cancelPreparedAttempt(attempt);
      throw error;
    }
    const causeCode = error instanceof YtShortsError ? error.code : "UNEXPECTED_UPLOAD_ERROR";
    try {
      receipt = await state.updateUploadAttempt(attempt, {
        state: "ambiguous",
        mutation_possible: true,
        video_id: inserted?.id ?? null,
        error_code: causeCode,
      });
    } catch {
      // The deterministic operation path still exists even if the receipt update failed.
    }
    throw new YtShortsError(
      "UPLOAD_OUTCOME_AMBIGUOUS",
      "An upload session started, but the final outcome could not be proven. Do not repeat this upload until YouTube Studio has been checked.",
      {
        cause_code: causeCode,
        video_id: inserted?.id ?? null,
        mutation_possible: true,
        operation: state.publicAttempt(receipt ?? attempt.operation, attempt.operationPath),
        retry_guidance:
          "Inspect YouTube Studio and the operation receipt. Only if no video exists may the user explicitly authorize --new-attempt.",
      },
    );
  }

  const snapshotRemoved = await state.discardAcceptedSnapshot(attempt);
  receipt = await state.updateUploadAttempt(attempt, { snapshot_retained: !snapshotRemoved }).catch(() => receipt);

  const waitSeconds = numberOption(options["wait-seconds"], 60, "--wait-seconds", 0, 900);
  let verification;
  try {
    verification = await pollVideo(
      api,
      async () => (await getUploadAuthorization()).accessToken,
      inserted.id,
      waitSeconds,
      plan,
    );
  } catch (error) {
    verification = {
      state: "verification_error",
      terminal: false,
      verified: false,
      video_id: inserted.id,
      error: {
        code: error instanceof YtShortsError ? error.code : "UNEXPECTED_VERIFICATION_ERROR",
        message: error?.message ?? String(error),
      },
      next_step: `Run status ${inserted.id}; do not publish the same file again.`,
    };
  }
  let receiptWriteError = null;
  try {
    receipt = await state.updateUploadAttempt(attempt, {
      state: verification.state,
      mutation_possible: true,
      video_id: inserted.id,
      verified: Boolean(verification.verified),
    });
  } catch (error) {
    receiptWriteError = error.message;
  }
  const verified = verification.verified === true;
  print({
    ok: verified,
    command: "publish",
    executed: true,
    upload_accepted: true,
    verified,
    channel,
    requested: {
      privacy: plan.target.privacy,
      scheduled_publish_at: plan.target.scheduled_publish_at,
      notify_subscribers: plan.target.notify_subscribers,
    },
    video_id: inserted.id,
    operation: state.publicAttempt(receipt ?? attempt.operation, attempt.operationPath),
    receipt_write_error: receiptWriteError,
    verification,
    warning:
      "The Data API does not expose Shorts classification. A processed upload that meets the published duration/aspect rules remains a Shorts candidate, not an API-confirmed Short.",
  });
  if (!verified) process.exitCode = verification.terminal ? 7 : 8;
}

async function status(videoId, options) {
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
    throw new YtShortsError("INVALID_VIDEO_ID", "VIDEO_ID must be an 11-character YouTube video ID.");
  }
  const api = await import("./ytshorts-api.mjs");
  const authorization = await api.authorizedAccess(apiOptions(options));
  const getAuthorization = createAuthorizationProvider(api, options, authorization);
  const waitSeconds = numberOption(options["wait-seconds"], 0, "--wait-seconds", 0, 900);
  const deadline = Date.now() + waitSeconds * 1000;
  let video;
  do {
    video = await api.getVideo((await getAuthorization()).accessToken, videoId);
    const summary = summarizeVideo(video);
    if ((video && summary.terminal) || Date.now() >= deadline) {
      print({ ok: Boolean(video), command: "status", ...summary });
      return;
    }
    await delay(5_000);
  } while (true);
}

async function pollVideo(api, accessTokenProvider, videoId, waitSeconds, plan) {
  const deadline = Date.now() + waitSeconds * 1000;
  let latest = null;
  do {
    latest = await api.getVideo(await accessTokenProvider(), videoId);
    if (latest) {
      const verification = verifyVideoAgainstPlan(latest, plan);
      if (verification.terminal) return verification;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(5_000, Math.max(0, deadline - Date.now())));
  } while (true);
  if (!latest) {
    return {
      state: "not_found_after_insert",
      terminal: false,
      verified: false,
      video_id: videoId,
      next_step: `Run status ${videoId}; do not publish the same file again while the result is unresolved.`,
    };
  }
  return {
    ...verifyVideoAgainstPlan(latest, plan),
    last_observed_state: summarizeVideo(latest).state,
    state: "verification_timeout",
    terminal: false,
    next_step: `Run status ${videoId}; do not publish the same file again while processing continues.`,
  };
}

function apiOptions(options) {
  return {
    clientSecretsPath: options["client-secrets"],
    tokenPath: options.token,
    configDir: options["config-dir"],
  };
}

function createAuthorizationProvider(api, options, initialAuthorization) {
  let current = initialAuthorization;
  let refreshInFlight = null;
  const refreshWindowMs = 10 * 60 * 1000;
  return async () => {
    const expiry = Number(current?.token?.expiry_date);
    if (current?.accessToken && Number.isFinite(expiry) && expiry > Date.now() + refreshWindowMs) {
      return current;
    }
    if (!refreshInFlight) {
      refreshInFlight = api
        .authorizedAccess({ ...apiOptions(options), forceRefresh: true })
        .then((authorization) => {
          current = authorization;
          return authorization;
        })
        .finally(() => {
          refreshInFlight = null;
        });
    }
    return refreshInFlight;
  };
}

async function readDescription(options) {
  if (options.description !== undefined && options["description-file"] !== undefined) {
    throw new YtShortsError("DESCRIPTION_CONFLICT", "Use either --description or --description-file, not both.");
  }
  if (options["description-file"] !== undefined) {
    try {
      return await readFile(String(options["description-file"]), "utf8");
    } catch (error) {
      throw new YtShortsError("DESCRIPTION_FILE_FAILED", `Could not read description file: ${error.message}`);
    }
  }
  return String(options.description ?? "");
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const rest = command ? argv.slice(1) : argv;
  const options = {};
  const positionals = [];
  const booleanFlags = new Set(["yes", "new-attempt", "no-open", "help"]);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (!name) throw new YtShortsError("INVALID_OPTION", `Invalid option: ${argument}`);
    let value;
    if (equals !== -1) {
      const supplied = argument.slice(equals + 1);
      if (booleanFlags.has(name)) {
        if (supplied === "true") value = true;
        else if (supplied === "false") value = false;
        else throw new YtShortsError("INVALID_BOOLEAN_FLAG", `--${name}= accepts only true or false.`);
      } else {
        value = supplied;
      }
    } else if (booleanFlags.has(name)) {
      value = true;
    } else {
      value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new YtShortsError("OPTION_VALUE_REQUIRED", `--${name} requires a value.`);
      }
      index += 1;
    }
    if (name === "tag") {
      options.tag = [...asArray(options.tag), value];
    } else {
      if (options[name] !== undefined) {
        throw new YtShortsError("DUPLICATE_OPTION", `--${name} was provided more than once.`);
      }
      options[name] = value;
    }
  }
  return { command, positionals, options };
}

function validateOptions(command, options) {
  const commonMetadata = [
    "title",
    "description",
    "description-file",
    "tag",
    "category-id",
    "privacy",
    "publish-at",
    "made-for-kids",
    "contains-synthetic-media",
    "notify-subscribers",
    "default-language",
    "channel-id",
  ];
  const credentials = ["client-secrets", "token", "config-dir"];
  const allowedByCommand = {
    inspect: ["help"],
    plan: ["help", ...commonMetadata],
    publish: [
      "help",
      "yes",
      "new-attempt",
      "expected-plan-id",
      "wait-seconds",
      ...credentials,
      ...commonMetadata,
    ],
    doctor: ["help", ...credentials],
    auth: ["help", "no-open", ...credentials],
    status: ["help", "wait-seconds", ...credentials],
  };
  const allowed = allowedByCommand[command];
  if (!allowed) return;
  const unknown = Object.keys(options).find((name) => !allowed.includes(name));
  if (unknown) throw new YtShortsError("UNKNOWN_OPTION", `--${unknown} is not valid for ${command}.`);
}

function requiredPositional(positionals, index, label) {
  const value = positionals[index];
  if (!value) throw new YtShortsError("ARGUMENT_REQUIRED", `${label} is required.`);
  return value;
}

function rejectExtraPositionals(positionals, expected) {
  if (positionals.length > expected) {
    throw new YtShortsError("TOO_MANY_ARGUMENTS", `Unexpected argument: ${positionals[expected]}`);
  }
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function numberOption(value, fallback, label, minimum, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new YtShortsError("INVALID_NUMBER", `${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function assertScheduleStillSafe(plan) {
  const publishAt = plan.target.scheduled_publish_at;
  if (!publishAt) return;
  const remaining = new Date(publishAt).getTime() - Date.now();
  if (remaining < MIN_SCHEDULE_LEAD_SECONDS * 1000) {
    throw new YtShortsError(
      "PUBLISH_AT_TOO_CLOSE",
      `Scheduled publication must remain at least ${MIN_SCHEDULE_LEAD_SECONDS / 60} minutes away throughout the upload. The next upload request was not sent.`,
      { scheduled_publish_at: publishAt, remaining_seconds: Math.max(0, Math.floor(remaining / 1000)) },
    );
  }
}

function uploadRequestTimeoutMs(plan) {
  const publishAt = plan.target.scheduled_publish_at;
  if (!publishAt) return 300_000;
  const budget = new Date(publishAt).getTime() - Date.now() - MIN_SCHEDULE_LEAD_SECONDS * 1000;
  if (budget <= 0) assertScheduleStillSafe(plan);
  return Math.min(300_000, Math.max(1, budget));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandVersion(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.on("error", (error) => resolve({ available: false, error: error.message }));
    child.on("close", (code) => {
      const firstLine = Buffer.concat(output).toString("utf8").split(/\r?\n/u)[0] || null;
      resolve({ available: code === 0, version: firstLine });
    });
  });
}

main().catch((error) => {
  const normalized =
    error instanceof YtShortsError
      ? error
      : new YtShortsError("UNEXPECTED_ERROR", error?.message ?? String(error));
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details === undefined ? {} : { details: normalized.details }),
        },
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = normalized.code === "PREFLIGHT_BLOCKED" ? 3 : 2;
});
