import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { YtShortsError, hashFile } from "./ytshorts-lib.mjs";

export async function findPrimaryAttempt(configDir, planId) {
  const operationPath = primaryOperationPath(configDir, planId);
  try {
    return publicAttempt(await readOperation(operationPath), operationPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function claimUploadAttempt({ configDir, plan, sourcePath, allowNewAttempt = false }) {
  const operationsDir = path.join(path.resolve(configDir), "operations");
  await mkdir(operationsDir, { recursive: true, mode: 0o700 });
  await chmod(operationsDir, 0o700).catch(() => {});

  const operationId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${randomBytes(6).toString("hex")}`;
  const operationPath = allowNewAttempt
    ? path.join(operationsDir, `${plan.plan_id}.retry.json`)
    : primaryOperationPath(configDir, plan.plan_id);
  const extension = safeExtension(sourcePath);
  const snapshotPath = path.join(operationsDir, `.${plan.plan_id}.${operationId}.snapshot${extension}`);
  const initial = {
    schema_version: 1,
    operation_id: operationId,
    plan_id: plan.plan_id,
    state: "preparing_snapshot",
    mutation_possible: false,
    video_id: null,
    source_sha256: plan.video.sha256,
    source_size_bytes: plan.video.size_bytes,
    expected_channel_id: plan.target.expected_channel_id,
    intended_privacy: plan.target.privacy,
    scheduled_publish_at: plan.target.scheduled_publish_at,
    snapshot_file: path.basename(snapshotPath),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    explicit_new_attempt: Boolean(allowNewAttempt),
  };

  try {
    await writeFile(operationPath, `${JSON.stringify(initial, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      const previous = await readOperation(operationPath).catch(() => null);
      throw priorAttemptError(previous, operationPath);
    }
    throw error;
  }

  try {
    await copyFile(sourcePath, snapshotPath, fsConstants.COPYFILE_EXCL);
    await chmod(snapshotPath, 0o400).catch(() => {});
    const [snapshotHash, snapshotStat] = await Promise.all([hashFile(snapshotPath), stat(snapshotPath)]);
    if (snapshotHash !== plan.video.sha256 || snapshotStat.size !== plan.video.size_bytes) {
      throw new YtShortsError(
        "PLAN_CHANGED_BEFORE_UPLOAD",
        "The source changed while the confirmed upload snapshot was being prepared. No upload session started.",
        {
          expected_sha256: plan.video.sha256,
          snapshot_sha256: snapshotHash,
          expected_size_bytes: plan.video.size_bytes,
          snapshot_size_bytes: snapshotStat.size,
        },
      );
    }
    const operation = await updateUploadAttempt(
      { operationPath, snapshotPath, operationId },
      { state: "snapshot_ready", snapshot_sha256: snapshotHash },
    );
    return { operationPath, snapshotPath, operationId, operation };
  } catch (error) {
    await unlink(snapshotPath).catch(() => {});
    await unlink(operationPath).catch(() => {});
    throw error;
  }
}

export async function updateUploadAttempt(attempt, patch) {
  const current = await readOperation(attempt.operationPath);
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  const temporary = `${attempt.operationPath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, attempt.operationPath);
  await chmod(attempt.operationPath, 0o600).catch(() => {});
  return next;
}

export async function discardAcceptedSnapshot(attempt) {
  try {
    await unlink(attempt.snapshotPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

export async function cancelPreparedAttempt(attempt) {
  await unlink(attempt.snapshotPath).catch(() => {});
  await unlink(attempt.operationPath).catch(() => {});
}

export function publicAttempt(record, operationPath) {
  if (!record) return null;
  return {
    operation_id: record.operation_id ?? null,
    plan_id: record.plan_id ?? null,
    state: record.state ?? "unknown",
    mutation_possible: Boolean(record.mutation_possible),
    video_id: record.video_id ?? null,
    created_at: record.created_at ?? null,
    updated_at: record.updated_at ?? null,
    operation_file: operationPath,
  };
}

export function priorAttemptError(record, operationPath) {
  return new YtShortsError(
    "PLAN_ALREADY_ATTEMPTED",
    "This plan_id already has an upload attempt. Inspect its receipt and YouTube Studio before doing anything else.",
    {
      previous_attempt: publicAttempt(record, operationPath),
      retry_guidance:
        "Do not repeat the upload by default. Only after confirming no duplicate exists may the user explicitly authorize --new-attempt.",
    },
  );
}

function primaryOperationPath(configDir, planId) {
  return path.join(path.resolve(configDir), "operations", `${planId}.json`);
}

async function readOperation(operationPath) {
  const raw = await readFile(operationPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new YtShortsError("INVALID_OPERATION_RECEIPT", `Operation receipt is invalid JSON: ${operationPath}`);
  }
}

function safeExtension(sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : ".video";
}
