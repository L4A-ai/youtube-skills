import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.resolve(scriptsDir, "../examples/verify-zero-publish.mjs");

function probe({ width = 360, height = 640, duration = "1", videoCodec = "h264" } = {}) {
  return {
    format: { duration, size: "14" },
    streams: [
      {
        codec_type: "video",
        codec_name: videoCodec,
        width,
        height,
        sample_aspect_ratio: "1:1",
        side_data_list: [],
      },
      { codec_type: "audio", codec_name: "aac" },
    ],
  };
}

async function fakeMediaTools(temporary, probeFixture = probe()) {
  const ffmpeg = path.join(temporary, "fake-ffmpeg.mjs");
  const ffprobe = path.join(temporary, "fake-ffprobe.mjs");
  await writeFile(
    ffmpeg,
    "#!/usr/bin/env node\n"
      + "const { writeFileSync } = await import('node:fs');\n"
      + "writeFileSync(process.argv.at(-1), 'synthetic bytes');\n",
  );
  await writeFile(
    ffprobe,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(probeFixture))});\n`,
  );
  await chmod(ffmpeg, 0o755);
  await chmod(ffprobe, 0o755);
  return { ffmpeg, ffprobe };
}

test("zero-publish verifier is deterministic and truthfully separates fixture writes", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-verifier-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const tools = await fakeMediaTools(temporary);
  const verifierTemporary = path.join(temporary, "verifier-temporary");
  await mkdir(verifierTemporary);
  const environment = {
    ...process.env,
    TMPDIR: verifierTemporary,
    YTSHORTS_FFMPEG_BIN: tools.ffmpeg,
    YTSHORTS_FFPROBE_BIN: tools.ffprobe,
  };

  const first = await execFileAsync(process.execPath, [verifier], { env: environment });
  const second = await execFileAsync(process.execPath, [verifier], { env: environment });
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(await readdir(verifierTemporary), []);
  assert.doesNotMatch(first.stdout, /UCaaaaaaaa|[a-f0-9]{64}|"(?:source|plan_id|channel_id)"|"\/(?:Users|home|tmp)\//u);

  const result = JSON.parse(first.stdout);
  assert.deepEqual(result, {
    schema_version: "1.0",
    skill_version: "0.1.0",
    fixture: "generated-360x640-h264-aac",
    status: "ok",
    inspection: {
      displayed_dimensions: { width: 360, height: 640 },
      duration_seconds: 1,
      video_codec: "h264",
      audio_codec: "aac",
      shorts_candidate: true,
    },
    plan: {
      safe_to_publish: true,
      privacy: "private",
      notify_subscribers: false,
      executed: false,
    },
    safety: {
      oauth_used: false,
      network_guard_armed: true,
      network_requests: 0,
      youtube_writes: 0,
      plan_local_writes: 0,
      config_dir_created: false,
      credential_files_created: false,
      temporary_fixture_written: true,
      temporary_artifacts_removed: true,
    },
    passed: true,
  });
});

test("zero-publish verifier fails closed when the media contract changes", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-verifier-mismatch-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const tools = await fakeMediaTools(temporary, probe({
    width: 640,
    height: 360,
    duration: "181",
    videoCodec: "vp9",
  }));

  await assert.rejects(
    execFileAsync(process.execPath, [verifier], {
      env: {
        ...process.env,
        YTSHORTS_FFMPEG_BIN: tools.ffmpeg,
        YTSHORTS_FFPROBE_BIN: tools.ffprobe,
      },
    }),
    (error) => {
      assert.equal(error.stderr, "");
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "ok");
      assert.equal(result.inspection.shorts_candidate, false);
      assert.equal(result.inspection.video_codec, "vp9");
      assert.equal(result.inspection.duration_seconds, 181);
      assert.equal(result.plan.safe_to_publish, false);
      assert.equal(result.passed, false);
      return true;
    },
  );
});

test("zero-publish verifier rejects arguments before creating a fixture", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [verifier, "unexpected"]),
    (error) => {
      assert.equal(error.stdout, "");
      assert.deepEqual(JSON.parse(error.stderr), {
        schema_version: "1.0",
        status: "error",
        error: {
          code: "ARGUMENTS_NOT_ALLOWED",
          message: "This verifier takes no arguments.",
        },
        passed: false,
      });
      return true;
    },
  );
});

test("zero-publish verifier sanitizes a missing FFmpeg failure and cleans up", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-verifier-missing-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const missingFfmpeg = path.join(temporary, "does-not-exist-ffmpeg");

  await assert.rejects(
    execFileAsync(process.execPath, [verifier], {
      env: {
        ...process.env,
        TMPDIR: temporary,
        YTSHORTS_FFMPEG_BIN: missingFfmpeg,
      },
    }),
    (error) => {
      assert.equal(error.stdout, "");
      assert.deepEqual(JSON.parse(error.stderr), {
        schema_version: "1.0",
        status: "error",
        error: {
          code: "FFMPEG_NOT_FOUND",
          message: "FFmpeg is required to generate the local synthetic fixture.",
        },
        passed: false,
      });
      return true;
    },
  );
  assert.deepEqual(await readdir(temporary), []);
});
