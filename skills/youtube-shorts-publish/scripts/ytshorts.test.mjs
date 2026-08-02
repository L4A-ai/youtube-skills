import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  analyzeProbe,
  buildPublishPlan,
  summarizeVideo,
  verifyVideoAgainstPlan,
} from "./ytshorts-lib.mjs";
import { OAUTH_SCOPES, authorizedAccess, uploadVideoResumable } from "./ytshorts-api.mjs";
import {
  claimUploadAttempt,
  discardAcceptedSnapshot,
  findPrimaryAttempt,
  updateUploadAttempt,
} from "./ytshorts-state.mjs";

const execFileAsync = promisify(execFile);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(scriptsDir, "ytshorts.mjs");
const channelId = "UCaaaaaaaaaaaaaaaaaaaaaa";

function probe({ width = 1080, height = 1920, duration = "30", rotation = 0, sar = "1:1", audio = true } = {}) {
  return {
    format: { duration, size: "12345" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width,
        height,
        sample_aspect_ratio: sar,
        side_data_list: rotation ? [{ rotation }] : [],
      },
      ...(audio ? [{ codec_type: "audio", codec_name: "aac" }] : []),
    ],
  };
}

function validPlanOptions(overrides = {}) {
  return {
    title: "A careful Short",
    channelId,
    madeForKids: "no",
    containsSyntheticMedia: "no",
    ...overrides,
  };
}

test("media analysis recognizes portrait, square, landscape, rotation, and SAR", () => {
  assert.equal(analyzeProbe(probe()).shorts_candidate, true);
  assert.equal(analyzeProbe(probe({ width: 1080, height: 1080 })).aspect, "square");
  assert.equal(analyzeProbe(probe({ width: 1920, height: 1080 })).shorts_candidate, false);

  const rotated = analyzeProbe(probe({ width: 1920, height: 1080, rotation: 90 }));
  assert.deepEqual(rotated.displayed_dimensions, { width: 1080, height: 1920 });
  assert.equal(rotated.shorts_candidate, true);

  const anamorphic = analyzeProbe(probe({ width: 720, height: 720, sar: "2:1" }));
  assert.deepEqual(anamorphic.displayed_dimensions, { width: 1440, height: 720 });
  assert.equal(anamorphic.shorts_candidate, false);
});

test("duration boundary is inclusive and edge duration warns", () => {
  const atLimit = analyzeProbe(probe({ duration: "180" }));
  assert.equal(atLimit.shorts_candidate, true);
  assert.ok(atLimit.warnings.some((warning) => warning.code === "DURATION_AT_LIMIT"));
  const overLimit = analyzeProbe(probe({ duration: "180.001" }));
  assert.equal(overLimit.shorts_candidate, false);
  assert.ok(overLimit.issues.some((issue) => issue.code === "DURATION_TOO_LONG"));
});

test("publishing plan is private and notification-free by default", () => {
  const media = analyzeProbe(probe());
  const plan = buildPublishPlan(media, validPlanOptions());
  assert.equal(plan.safe_to_publish, true);
  assert.equal(plan.target.privacy, "private");
  assert.equal(plan.target.notify_subscribers, false);
  assert.deepEqual(plan.request.query, { notifySubscribers: false });
  assert.equal(plan.request.body.status.selfDeclaredMadeForKids, false);
  assert.equal(plan.request.body.status.containsSyntheticMedia, false);
  assert.match(plan.plan_id, /^[a-f0-9]{64}$/u);
});

test("plan ID is deterministic and binds source plus normalized request", () => {
  const media = { ...analyzeProbe(probe()), sha256: "a".repeat(64) };
  const first = buildPublishPlan(media, validPlanOptions());
  const repeated = buildPublishPlan(media, validPlanOptions());
  const changedTitle = buildPublishPlan(media, validPlanOptions({ title: "Changed" }));
  const changedSource = buildPublishPlan({ ...media, sha256: "b".repeat(64) }, validPlanOptions());
  assert.equal(first.plan_id, repeated.plan_id);
  assert.notEqual(first.plan_id, changedTitle.plan_id);
  assert.notEqual(first.plan_id, changedSource.plan_id);
});

test("plan blocks missing declarations, wrong channel, invalid metadata, and unsafe schedule", () => {
  const media = analyzeProbe(probe());
  const plan = buildPublishPlan(
    media,
    {
      title: `${"x".repeat(100)}y`,
      channelId: "wrong",
      privacy: "public",
      publishAt: "2099-01-01T00:00:00Z",
      description: "<bad>",
    },
    new Date("2026-01-01T00:00:00Z"),
  );
  const codes = new Set(plan.blocking_issues.map((issue) => issue.code));
  for (const code of [
    "INVALID_CHANNEL_ID",
    "TITLE_TOO_LONG",
    "DESCRIPTION_INVALID_CHAR",
    "AUDIENCE_DECLARATION_REQUIRED",
    "SYNTHETIC_MEDIA_DECLARATION_REQUIRED",
    "SCHEDULE_REQUIRES_PRIVATE",
  ]) {
    assert.ok(codes.has(code), `expected ${code}`);
  }
});

test("schedule requires an explicit timezone and reports processed_scheduled", () => {
  const media = analyzeProbe(probe());
  const now = new Date("2026-01-01T00:00:00Z");
  const ambiguous = buildPublishPlan(
    media,
    validPlanOptions({ publishAt: "2099-01-01T09:00:00" }),
    now,
  );
  assert.ok(ambiguous.blocking_issues.some((issue) => issue.code === "INVALID_PUBLISH_AT"));
  const tooClose = buildPublishPlan(
    media,
    validPlanOptions({ publishAt: "2026-01-01T00:10:00Z" }),
    now,
  );
  assert.ok(tooClose.blocking_issues.some((issue) => issue.code === "PUBLISH_AT_TOO_CLOSE"));
  const summary = summarizeVideo({
    id: "abc123",
    status: { privacyStatus: "private", publishAt: "2099-01-01T01:00:00Z", uploadStatus: "processed" },
    processingDetails: { processingStatus: "succeeded" },
  });
  assert.equal(summary.state, "processed_scheduled");
});

test("semantic verification distinguishes processing and forced-private mismatch", () => {
  const media = analyzeProbe(probe());
  const plan = buildPublishPlan(media, validPlanOptions({ privacy: "public" }));
  const video = {
    id: "abc123",
    snippet: {
      title: plan.request.body.snippet.title,
      description: "",
      categoryId: "22",
      channelId,
    },
    status: {
      privacyStatus: "private",
      uploadStatus: "processed",
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    },
    processingDetails: { processingStatus: "succeeded" },
    contentDetails: { duration: "PT30S" },
  };
  const verification = verifyVideoAgainstPlan(video, plan);
  assert.equal(verification.state, "processed_private");
  assert.equal(verification.privacy_restricted, true);
  assert.equal(verification.verified, false);
  const wrongChannel = verifyVideoAgainstPlan(
    {
      ...video,
      snippet: { ...video.snippet, channelId: `UC${"z".repeat(22)}` },
      status: { ...video.status, privacyStatus: "public" },
    },
    plan,
  );
  assert.ok(wrongChannel.mismatches.some((mismatch) => mismatch.field === "snippet.channelId"));
  assert.equal(wrongChannel.verified, false);
  assert.equal(
    summarizeVideo({
      ...video,
      status: { ...video.status, uploadStatus: "uploaded" },
      processingDetails: { processingStatus: "processing" },
    }).state,
    "uploaded_processing",
  );
});

test("processed video is not verified for Shorts when API duration exceeds 180 seconds", () => {
  const media = analyzeProbe(probe());
  const plan = buildPublishPlan(media, validPlanOptions());
  const verification = verifyVideoAgainstPlan(
    {
      id: "abc123",
      snippet: {
        title: plan.request.body.snippet.title,
        description: "",
        categoryId: "22",
        channelId,
      },
      status: {
        privacyStatus: "private",
        uploadStatus: "processed",
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: false,
      },
      processingDetails: { processingStatus: "succeeded" },
      contentDetails: { duration: "PT3M1S" },
    },
    plan,
  );
  assert.equal(verification.state, "processed_private");
  assert.equal(verification.shorts_duration_verified, false);
  assert.equal(verification.verified, false);
});

test("plan and publish-without-yes do not create config state", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-plan-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const videoPath = path.join(temporary, "input.mp4");
  const fakeProbe = path.join(temporary, "fake-ffprobe.mjs");
  const configDir = path.join(temporary, "must-not-exist");
  await writeFile(videoPath, "not inspected by the fake probe");
  await writeFile(
    fakeProbe,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(probe()))});\n`,
  );
  await chmod(fakeProbe, 0o755);

  const common = [
    videoPath,
    "--title",
    "Dry run",
    "--channel-id",
    channelId,
    "--made-for-kids",
    "no",
    "--contains-synthetic-media",
    "no",
  ];
  const env = {
    ...process.env,
    YTSHORTS_FFPROBE_BIN: fakeProbe,
    YTSHORTS_CONFIG_DIR: configDir,
  };
  for (const command of ["plan", "publish"]) {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, command, ...common], { env });
    const result = JSON.parse(stdout);
    assert.equal(result.dry_run, true);
    assert.equal(result.network_requests, 0);
    assert.equal(result.local_writes, 0);
  }
  await assert.rejects(access(configDir), { code: "ENOENT" });
});

test("real publish requires the reviewed plan ID before OAuth is loaded", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-confirm-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const videoPath = path.join(temporary, "input.mp4");
  const fakeProbe = path.join(temporary, "fake-ffprobe.mjs");
  const configDir = path.join(temporary, "must-not-exist");
  await writeFile(videoPath, "stable bytes");
  await writeFile(
    fakeProbe,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(probe()))});\n`,
  );
  await chmod(fakeProbe, 0o755);
  const args = [
    cliPath,
    "publish",
    videoPath,
    "--title",
    "Needs reviewed plan",
    "--channel-id",
    channelId,
    "--made-for-kids",
    "no",
    "--contains-synthetic-media",
    "no",
    "--yes",
  ];
  await assert.rejects(
    execFileAsync(process.execPath, args, {
      env: {
        ...process.env,
        YTSHORTS_FFPROBE_BIN: fakeProbe,
        YTSHORTS_CONFIG_DIR: configDir,
      },
    }),
    (error) => {
      const output = JSON.parse(error.stderr);
      assert.equal(output.error.code, "EXPECTED_PLAN_ID_REQUIRED");
      assert.match(output.error.details.actual_plan_id, /^[a-f0-9]{64}$/u);
      return true;
    },
  );
  await assert.rejects(access(configDir), { code: "ENOENT" });
});

test("upload attempt snapshots reviewed bytes and blocks plan reuse by default", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-attempt-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourcePath = path.join(temporary, "source.mp4");
  const reviewedBytes = Buffer.from("reviewed source bytes");
  await writeFile(sourcePath, reviewedBytes);
  const media = {
    ...analyzeProbe(probe()),
    source: sourcePath,
    sha256: createHash("sha256").update(reviewedBytes).digest("hex"),
    size_bytes: reviewedBytes.length,
  };
  const plan = buildPublishPlan(media, validPlanOptions());
  const configDir = path.join(temporary, "config");
  const attempt = await claimUploadAttempt({ configDir, plan, sourcePath });
  await writeFile(sourcePath, "different bytes after snapshot");
  assert.deepEqual(await readFile(attempt.snapshotPath), reviewedBytes);
  const prior = await findPrimaryAttempt(configDir, plan.plan_id);
  assert.equal(prior.state, "snapshot_ready");
  await assert.rejects(
    claimUploadAttempt({ configDir, plan, sourcePath }),
    (error) => error.code === "PLAN_ALREADY_ATTEMPTED",
  );
  const started = await updateUploadAttempt(attempt, {
    state: "upload_session_starting",
    mutation_possible: true,
  });
  assert.equal(started.mutation_possible, true);
  assert.equal(await discardAcceptedSnapshot(attempt), true);
  await writeFile(sourcePath, reviewedBytes);
  const retry = await claimUploadAttempt({ configDir, plan, sourcePath, allowNewAttempt: true });
  assert.match(retry.operationPath, /\.retry\.json$/u);
  await assert.rejects(
    claimUploadAttempt({ configDir, plan, sourcePath, allowNewAttempt: true }),
    (error) => error.code === "PLAN_ALREADY_ATTEMPTED",
  );
});

test("stored authorization requires both workflow scopes and private permissions", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-auth-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const clientSecretsPath = path.join(temporary, "client.json");
  const tokenPath = path.join(temporary, "token.json");
  const clientId = "desktop-client-id";
  await writeFile(
    clientSecretsPath,
    JSON.stringify({ installed: { client_id: clientId, client_secret: "dummy-secret" } }),
  );
  await chmod(clientSecretsPath, 0o600);
  const baseToken = {
    access_token: "dummy-access-token",
    refresh_token: "dummy-refresh-token",
    expiry_date: Date.now() + 3_600_000,
    client_id: clientId,
    granted_scopes: OAUTH_SCOPES,
  };
  await writeFile(tokenPath, JSON.stringify(baseToken));
  await chmod(tokenPath, 0o600);
  const authorization = await authorizedAccess({ clientSecretsPath, tokenPath });
  assert.equal(authorization.accessToken, baseToken.access_token);

  const { refresh_token: _refreshToken, ...accessOnlyToken } = baseToken;
  await writeFile(tokenPath, JSON.stringify(accessOnlyToken));
  await chmod(tokenPath, 0o600);
  await assert.rejects(
    authorizedAccess({ clientSecretsPath, tokenPath }),
    (error) => error.code === "OAUTH_REFRESH_TOKEN_REQUIRED",
  );

  await writeFile(tokenPath, JSON.stringify({ ...baseToken, granted_scopes: [OAUTH_SCOPES[0]] }));
  await chmod(tokenPath, 0o600);
  await assert.rejects(
    authorizedAccess({ clientSecretsPath, tokenPath }),
    (error) => error.code === "OAUTH_SCOPE_INSUFFICIENT",
  );

  if (process.platform !== "win32") {
    await chmod(tokenPath, 0o644);
    await assert.rejects(
      authorizedAccess({ clientSecretsPath, tokenPath }),
      (error) => error.code === "INSECURE_CREDENTIAL_PERMISSIONS",
    );
  }
});

test("resumable uploader sends fixed chunks and follows 308 Range", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-upload-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const filePath = path.join(temporary, "video.mp4");
  const size = 8 * 1024 * 1024 + 1;
  await writeFile(filePath, Buffer.alloc(size, 7));
  const ranges = [];
  let safetyChecks = 0;
  let tokenChecks = 0;
  let mutationMarks = 0;
  let metadata = null;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST") {
        metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const address = server.address();
        response.writeHead(200, { Location: `http://127.0.0.1:${address.port}/session` });
        response.end();
        return;
      }
      ranges.push(request.headers["content-range"]);
      if (ranges.length === 1) {
        response.writeHead(308, { Range: "bytes=0-8388607" });
        response.end();
      } else {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "uploaded-id" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await uploadVideoResumable({
    accessToken: "test-token",
    accessTokenProvider: async () => {
      tokenChecks += 1;
      return `rotating-test-token-${tokenChecks}`;
    },
    filePath,
    requestBody: { snippet: { title: "Test" }, status: { privacyStatus: "private" } },
    uploadEndpoint: `http://127.0.0.1:${address.port}/videos`,
    beforeRequest: () => {
      safetyChecks += 1;
    },
    onMutationPossible: () => {
      mutationMarks += 1;
    },
  });
  assert.equal(result.id, "uploaded-id");
  assert.equal(metadata.snippet.title, "Test");
  assert.deepEqual(ranges, [`bytes 0-8388607/${size}`, `bytes 8388608-8388608/${size}`]);
  assert.equal(safetyChecks, 3, "guard runs before session creation and each chunk");
  assert.equal(tokenChecks, 3, "authorization is resolved before session creation and each chunk");
  assert.equal(mutationMarks, 1, "the durable mutation boundary is marked once before upload bytes");
});

test("a rejected session never crosses the upload mutation boundary", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-session-reject-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const filePath = path.join(temporary, "video.mp4");
  await writeFile(filePath, Buffer.alloc(1024, 2));
  let mutationMarks = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Rejected metadata", errors: [{ reason: "badRequest" }] } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  await assert.rejects(
    uploadVideoResumable({
      accessToken: "test-token",
      filePath,
      requestBody: { snippet: { title: "Test" }, status: { privacyStatus: "private" } },
      uploadEndpoint: `http://127.0.0.1:${address.port}/videos`,
      onMutationPossible: () => {
        mutationMarks += 1;
      },
    }),
    (error) => error.code === "badRequest",
  );
  assert.equal(mutationMarks, 0);
});

test("resumable uploader queries acknowledged offset after a transient failure", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-recover-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const filePath = path.join(temporary, "video.mp4");
  await writeFile(filePath, Buffer.alloc(1024, 3));
  const observedRanges = [];
  let sessionRequests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") {
        const address = server.address();
        response.writeHead(200, { Location: `http://127.0.0.1:${address.port}/session` });
        response.end();
        return;
      }
      sessionRequests += 1;
      observedRanges.push(request.headers["content-range"]);
      if (sessionRequests === 1) {
        response.writeHead(503, { "Retry-After": "0" });
        response.end();
      } else if (sessionRequests === 2) {
        response.writeHead(308);
        response.end();
      } else {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "recovered-id" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await uploadVideoResumable({
    accessToken: "test-token",
    filePath,
    requestBody: { snippet: { title: "Test" }, status: { privacyStatus: "private" } },
    uploadEndpoint: `http://127.0.0.1:${address.port}/videos`,
  });
  assert.equal(result.id, "recovered-id");
  assert.deepEqual(observedRanges, ["bytes 0-1023/1024", "bytes */1024", "bytes 0-1023/1024"]);
});

test("resumable uploader recovers the video ID when the final response body is lost", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ytshorts-final-recover-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const filePath = path.join(temporary, "video.mp4");
  await writeFile(filePath, Buffer.alloc(1024, 5));
  const observedRanges = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") {
        const address = server.address();
        response.writeHead(200, { Location: `http://127.0.0.1:${address.port}/session` });
        response.end();
        return;
      }
      observedRanges.push(request.headers["content-range"]);
      if (observedRanges.length === 1) {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end("not-json");
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "body-recovered-id" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await uploadVideoResumable({
    accessToken: "test-token",
    filePath,
    requestBody: { snippet: { title: "Test" }, status: { privacyStatus: "private" } },
    uploadEndpoint: `http://127.0.0.1:${address.port}/videos`,
  });
  assert.equal(result.id, "body-recovered-id");
  assert.deepEqual(observedRanges, ["bytes 0-1023/1024", "bytes */1024"]);
});
