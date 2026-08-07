#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(HERE, "..");
const CLI = path.join(SKILL_ROOT, "scripts", "ytshorts.mjs");
const PACKAGE = path.join(SKILL_ROOT, "package.json");
const NETWORK_GUARD = path.join(HERE, "zero-publish-network-guard.mjs");
const CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";

function failure(code, message) {
  process.stderr.write(`${JSON.stringify({
    schema_version: "1.0",
    status: "error",
    error: { code, message },
    passed: false,
  })}\n`);
  process.exitCode = 1;
}

function childEnvironment(configDir, credentialSentinels) {
  const environment = {
    DO_NOT_TRACK: "1",
    YTSHORTS_CONFIG_DIR: configDir,
    YTSHORTS_CLIENT_SECRETS: credentialSentinels.clientSecrets,
    YTSHORTS_TOKEN_PATH: credentialSentinels.token,
  };
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  if (process.env.YTSHORTS_FFPROBE_BIN) {
    environment.YTSHORTS_FFPROBE_BIN = process.env.YTSHORTS_FFPROBE_BIN;
  }
  return environment;
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function runJson(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  return JSON.parse(stdout);
}

async function verifyNetworkGuard(environment) {
  const guardUrl = pathToFileURL(NETWORK_GUARD).href;
  try {
    await execFileAsync(process.execPath, [
      "--import",
      guardUrl,
      "--input-type=module",
      "--eval",
      "await fetch('https://network-guard.invalid/canary')",
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: environment,
    });
  } catch (error) {
    if ((error?.stderr ?? "").includes("NETWORK_BLOCKED")) return true;
    throw Object.assign(error, {
      publicFailure: {
        code: "NETWORK_GUARD_FAILED",
        message: "The zero-publish network guard did not pass its local canary.",
      },
    });
  }
  const error = new Error("Network guard canary was not blocked");
  throw Object.assign(error, {
    publicFailure: {
      code: "NETWORK_GUARD_FAILED",
      message: "The zero-publish network guard did not pass its local canary.",
    },
  });
}

function publicError(error, ffmpegBin) {
  if (error?.code === "ENOENT" && error?.path === ffmpegBin) {
    return {
      code: "FFMPEG_NOT_FOUND",
      message: "FFmpeg is required to generate the local synthetic fixture.",
    };
  }
  try {
    const cliFailure = JSON.parse(error?.stderr ?? "");
    if (cliFailure?.error?.code && cliFailure?.error?.message) {
      return { code: cliFailure.error.code, message: cliFailure.error.message };
    }
  } catch {
    // Fall through to a stable, path-free error.
  }
  return {
    code: "ZERO_PUBLISH_VERIFICATION_FAILED",
    message: "The local zero-publish verification did not complete.",
  };
}

async function verify() {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-proof-"));
  const fixture = path.join(temporary, "fixture.mp4");
  const configDir = path.join(temporary, "no-state");
  const credentialSentinels = {
    clientSecrets: path.join(temporary, "must-not-exist-client-secrets.json"),
    token: path.join(temporary, "must-not-exist-token.json"),
  };
  const ffmpegBin = process.env.YTSHORTS_FFMPEG_BIN ?? "ffmpeg";
  let result;
  let cleanupSucceeded = false;

  try {
    await execFileAsync(ffmpegBin, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=360x640:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo:d=1",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      fixture,
    ], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: childEnvironment(configDir, credentialSentinels),
    });

    const environment = childEnvironment(configDir, credentialSentinels);
    const networkGuardArmed = await verifyNetworkGuard(environment);
    const guardedCli = ["--import", pathToFileURL(NETWORK_GUARD).href, CLI];
    const inspection = await runJson(process.execPath, [...guardedCli, "inspect", fixture], {
      env: environment,
    });
    const planning = await runJson(process.execPath, [
      ...guardedCli,
      "plan",
      fixture,
      "--title",
      "5-minute safety check",
      "--channel-id",
      CHANNEL_ID,
      "--privacy",
      "private",
      "--notify-subscribers",
      "no",
      "--made-for-kids",
      "no",
      "--contains-synthetic-media",
      "no",
    ], { env: environment });
    const packageMetadata = JSON.parse(await readFile(PACKAGE, "utf8"));
    const media = inspection.media;
    const plan = planning.plan;

    result = {
      schema_version: "1.0",
      skill_version: packageMetadata.version,
      fixture: "generated-360x640-h264-aac",
      status: "ok",
      inspection: {
        displayed_dimensions: media.displayed_dimensions,
        duration_seconds: media.duration_seconds,
        video_codec: media.video_codec,
        audio_codec: media.audio_codec,
        shorts_candidate: media.shorts_candidate,
      },
      plan: {
        safe_to_publish: plan.safe_to_publish,
        privacy: plan.target.privacy,
        notify_subscribers: plan.target.notify_subscribers,
        executed: plan.executed,
      },
      safety: {
        oauth_used: false,
        network_guard_armed: networkGuardArmed,
        network_requests: planning.network_requests,
        youtube_writes: 0,
        plan_local_writes: planning.local_writes,
        config_dir_created: await pathExists(configDir),
        credential_files_created: await pathExists(credentialSentinels.clientSecrets)
          || await pathExists(credentialSentinels.token),
        temporary_fixture_written: await pathExists(fixture),
        temporary_artifacts_removed: false,
      },
      passed: false,
    };
  } catch (error) {
    if (error?.publicFailure) throw error;
    throw Object.assign(error, { publicFailure: publicError(error, ffmpegBin) });
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
      cleanupSucceeded = true;
    } catch {
      cleanupSucceeded = false;
    }
  }

  result.safety.temporary_artifacts_removed = cleanupSucceeded;
  result.passed = result.status === "ok"
    && result.inspection.displayed_dimensions.width === 360
    && result.inspection.displayed_dimensions.height === 640
    && result.inspection.duration_seconds === 1
    && result.inspection.video_codec === "h264"
    && result.inspection.audio_codec === "aac"
    && result.inspection.shorts_candidate === true
    && result.plan.safe_to_publish === true
    && result.plan.privacy === "private"
    && result.plan.notify_subscribers === false
    && result.plan.executed === false
    && result.safety.oauth_used === false
    && result.safety.network_guard_armed === true
    && result.safety.network_requests === 0
    && result.safety.youtube_writes === 0
    && result.safety.plan_local_writes === 0
    && result.safety.config_dir_created === false
    && result.safety.credential_files_created === false
    && result.safety.temporary_fixture_written === true
    && result.safety.temporary_artifacts_removed === true;
  return result;
}

if (process.argv.length !== 2) {
  failure("ARGUMENTS_NOT_ALLOWED", "This verifier takes no arguments.");
} else {
  try {
    const result = await verify();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const publicFailure = error?.publicFailure ?? {
      code: "ZERO_PUBLISH_VERIFICATION_FAILED",
      message: "The local zero-publish verification did not complete.",
    };
    failure(publicFailure.code, publicFailure.message);
  }
}
