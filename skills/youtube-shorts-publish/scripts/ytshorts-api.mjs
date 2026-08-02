import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { YtShortsError } from "./ytshorts-lib.mjs";

export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/youtube/v3";
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 60_000;

export function configPaths(overrides = {}) {
  const configDir =
    overrides.configDir ??
    process.env.YTSHORTS_CONFIG_DIR ??
    path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "ytshorts");
  return {
    configDir,
    clientSecretsPath: path.resolve(
      overrides.clientSecretsPath ??
        process.env.YTSHORTS_CLIENT_SECRETS ??
        path.join(configDir, "client_secret.json"),
    ),
    tokenPath: path.resolve(
      overrides.tokenPath ?? process.env.YTSHORTS_TOKEN_PATH ?? path.join(configDir, "token.json"),
    ),
  };
}

export async function readClientSecrets(clientSecretsPath) {
  await assertPrivateCredentialFile(clientSecretsPath, "CLIENT_SECRETS_NOT_FOUND", "OAuth client secrets");
  const raw = await readJson(clientSecretsPath, "CLIENT_SECRETS_NOT_FOUND", "OAuth client secrets");
  if (!raw.installed?.client_id || !raw.installed?.client_secret) {
    throw new YtShortsError(
      "INVALID_CLIENT_SECRETS",
      "Expected a Google OAuth client JSON with an 'installed' Desktop app configuration.",
    );
  }
  return {
    clientId: raw.installed.client_id,
    clientSecret: raw.installed.client_secret,
    projectId: raw.installed.project_id ?? null,
  };
}

export async function readStoredToken(tokenPath) {
  await assertPrivateCredentialFile(tokenPath, "AUTH_REQUIRED", "OAuth token");
  const token = await readJson(tokenPath, "AUTH_REQUIRED", "OAuth token");
  if (!token.refresh_token) {
    throw new YtShortsError(
      "OAUTH_REFRESH_TOKEN_REQUIRED",
      "Stored authorization has no refresh token. Run auth again so long uploads and verification can renew access safely.",
    );
  }
  assertRequiredScopes(token);
  return token;
}

export async function authorizeDesktop(options = {}) {
  const paths = configPaths(options);
  const client = await readClientSecrets(paths.clientSecretsPath);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  let settleCallback;
  const callback = new Promise((resolve, reject) => {
    settleCallback = { resolve, reject };
  });

  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth callback.");
      return;
    }
    if (url.pathname !== "/") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("OAuth state mismatch. Return to the terminal.");
      settleCallback.reject(new YtShortsError("OAUTH_STATE_MISMATCH", "OAuth callback state did not match."));
      return;
    }
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authorization was not completed. Return to the terminal.");
      settleCallback.reject(new YtShortsError("OAUTH_DENIED", `Google OAuth returned: ${oauthError}`));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authorization code missing. Return to the terminal.");
      settleCallback.reject(new YtShortsError("OAUTH_CODE_MISSING", "OAuth callback did not include a code."));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><title>Authorized</title><p>YouTube authorization completed. You can close this tab.</p>");
    settleCallback.resolve(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  options.onAuthorizationUrl?.(authUrl.toString());
  if (options.openBrowser !== false) openSystemBrowser(authUrl.toString());

  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new YtShortsError("OAUTH_TIMEOUT", "OAuth callback timed out after 5 minutes.")),
        options.timeoutMs ?? 300_000,
      );
    });
    const code = await Promise.race([callback, timeout]);
    const exchanged = await exchangeToken({
      client,
      code,
      codeVerifier: verifier,
      redirectUri,
    });
    const token = {
      ...exchanged,
      client_id: client.clientId,
      requested_scopes: OAUTH_SCOPES,
      granted_scopes: exchanged.scope ? grantedScopes(exchanged) : OAUTH_SCOPES,
    };
    if (!token.refresh_token) {
      throw new YtShortsError(
        "OAUTH_REFRESH_TOKEN_MISSING",
        "Google did not return a refresh token. Revoke the app grant if necessary, then run auth again.",
      );
    }
    assertRequiredScopes(token);
    await saveToken(paths.tokenPath, token);
    return { token, paths, client };
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function authorizedAccess(options = {}) {
  const paths = configPaths(options);
  const [client, stored] = await Promise.all([
    readClientSecrets(paths.clientSecretsPath),
    readStoredToken(paths.tokenPath),
  ]);
  if (stored.client_id && stored.client_id !== client.clientId) {
    throw new YtShortsError(
      "OAUTH_CLIENT_MISMATCH",
      "The stored token belongs to a different Desktop OAuth client. Run auth with the selected client JSON.",
    );
  }
  assertRequiredScopes(stored);
  const expiry = Number(stored.expiry_date);
  const accessTokenIsFresh = Number.isFinite(expiry) && expiry > Date.now() + 60_000;
  if (!options.forceRefresh && stored.access_token && accessTokenIsFresh) {
    return { accessToken: stored.access_token, token: stored, paths, client, refreshed: false };
  }
  if (!stored.refresh_token) {
    throw new YtShortsError("AUTH_REQUIRED", "OAuth access expired and no refresh token is available; run auth again.");
  }
  const refreshed = await refreshToken(client, stored.refresh_token);
  const merged = {
    ...stored,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    client_id: client.clientId,
    requested_scopes: OAUTH_SCOPES,
    granted_scopes: refreshed.scope ? grantedScopes(refreshed) : grantedScopes(stored),
  };
  assertRequiredScopes(merged);
  await saveToken(paths.tokenPath, merged);
  return { accessToken: merged.access_token, token: merged, paths, client, refreshed: true };
}

export async function getChannel(accessToken) {
  const url = new URL(`${API_BASE}/channels`);
  url.search = new URLSearchParams({ part: "id,snippet", mine: "true" }).toString();
  const payload = await apiJson(url, { headers: bearer(accessToken) });
  const channel = payload.items?.[0];
  if (!channel) {
    throw new YtShortsError(
      "YOUTUBE_CHANNEL_NOT_FOUND",
      "The authorized Google account does not expose a YouTube channel. Select or create a channel, then authorize again.",
    );
  }
  return {
    channel_id: channel.id,
    title: channel.snippet?.title ?? null,
    custom_url: channel.snippet?.customUrl ?? null,
  };
}

export async function getVideo(accessToken, videoId) {
  const url = new URL(`${API_BASE}/videos`);
  url.search = new URLSearchParams({
    part: "id,snippet,status,processingDetails,contentDetails",
    id: videoId,
  }).toString();
  const payload = await apiJson(url, { headers: bearer(accessToken) });
  return payload.items?.[0] ?? null;
}

export async function uploadVideoResumable({
  accessToken,
  accessTokenProvider,
  filePath,
  requestBody,
  notifySubscribers = false,
  onProgress,
  onMutationPossible,
  beforeRequest,
  requestTimeoutMs,
  fetchImpl = fetch,
  uploadEndpoint = UPLOAD_ENDPOINT,
}) {
  const handle = await open(filePath, "r");
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size <= 0) {
      throw new YtShortsError("MEDIA_EMPTY", "Upload source must be a non-empty regular file.");
    }
    const mimeType = videoMimeType(filePath);
    const sessionUrl = new URL(uploadEndpoint);
    sessionUrl.search = new URLSearchParams({
      uploadType: "resumable",
      part: "snippet,status",
      notifySubscribers: String(Boolean(notifySubscribers)),
    }).toString();
    const sessionResponse = await startUploadSession({
      url: sessionUrl,
      accessToken,
      size: file.size,
      mimeType,
      requestBody,
      fetchImpl,
      accessTokenProvider,
      beforeRequest,
      requestTimeoutMs,
    });
    if (!sessionResponse.ok) await throwApiError(sessionResponse, "UPLOAD_SESSION_FAILED");
    const location = sessionResponse.headers.get("location");
    if (!location) {
      throw new YtShortsError("UPLOAD_LOCATION_MISSING", "YouTube did not return a resumable upload URL.");
    }

    let offset = 0;
    let retries = 0;
    let mutationMarked = false;
    while (offset < file.size) {
      const length = Math.min(CHUNK_SIZE, file.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new YtShortsError("MEDIA_READ_SHORT", `Expected ${length} bytes at offset ${offset}, read ${bytesRead}.`);
      }
      const end = offset + length - 1;
      let response;
      const requestAccessToken = await resolveAccessToken(accessToken, accessTokenProvider);
      await beforeRequest?.();
      if (!mutationMarked) {
        await onMutationPossible?.();
        mutationMarked = true;
      }
      try {
        response = await fetchImpl(location, {
          method: "PUT",
          headers: {
            ...bearer(requestAccessToken),
            "Content-Type": mimeType,
            "Content-Length": String(length),
            "Content-Range": `bytes ${offset}-${end}/${file.size}`,
          },
          body: buffer,
          signal: requestTimeoutSignal(requestTimeoutMs),
        });
      } catch (error) {
        response = null;
        if (++retries > 5) {
          throw new YtShortsError("UPLOAD_NETWORK_FAILED", "Upload failed after resumable retries.", {
            cause: safeErrorMessage(error),
          });
        }
      }

      if (response?.status === 200 || response?.status === 201) {
        let completedVideo = null;
        try {
          completedVideo = await response.json();
        } catch {
          // Recover the terminal resource from the still-known session URL below.
        }
        if (completedVideo?.id) {
          onProgress?.({ uploaded_bytes: file.size, total_bytes: file.size });
          return completedVideo;
        }
        const recovered = await queryUploadStatus({
          location,
          totalBytes: file.size,
          accessToken,
          accessTokenProvider,
          fetchImpl,
          beforeRequest,
          requestTimeoutMs,
        });
        if (recovered.complete) {
          onProgress?.({ uploaded_bytes: file.size, total_bytes: file.size, resumed: true });
          return recovered.video;
        }
        offset = recovered.offset;
        onProgress?.({ uploaded_bytes: offset, total_bytes: file.size, resumed: true });
        continue;
      }
      if (response?.status === 308) {
        offset = nextOffset(response.headers.get("range"));
        retries = 0;
        onProgress?.({ uploaded_bytes: offset, total_bytes: file.size });
        continue;
      }
      if (response && !TRANSIENT_STATUS.has(response.status)) {
        await throwApiError(response, "UPLOAD_FAILED");
      }

      if (response && ++retries > 5) {
        await throwApiError(response, "UPLOAD_RETRIES_EXHAUSTED");
      }
      await delay(retryDelayMs(response, retries));
      const recovered = await queryUploadStatus({
        location,
        totalBytes: file.size,
        accessToken,
        accessTokenProvider,
        fetchImpl,
        beforeRequest,
        requestTimeoutMs,
      });
      if (recovered.complete) return recovered.video;
      offset = recovered.offset;
      onProgress?.({ uploaded_bytes: offset, total_bytes: file.size, resumed: true });
    }
    throw new YtShortsError("UPLOAD_INCOMPLETE", "Upload ended without a completed video resource.");
  } finally {
    await handle.close();
  }
}

export async function inspectCredentialFiles(options = {}) {
  const paths = configPaths(options);
  return {
    config_dir: paths.configDir,
    client_secrets: await fileHealth(paths.clientSecretsPath),
    token: await fileHealth(paths.tokenPath),
  };
}

async function exchangeToken({ client, code, codeVerifier, redirectUri }) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    signal: requestTimeoutSignal(DEFAULT_OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) await throwApiError(response, "OAUTH_TOKEN_EXCHANGE_FAILED");
  return normalizeToken(await response.json());
}

async function refreshToken(client, refreshTokenValue) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshTokenValue,
      grant_type: "refresh_token",
    }),
    signal: requestTimeoutSignal(DEFAULT_OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    let detail = {};
    try {
      detail = await response.clone().json();
    } catch {
      // Use the generic OAuth error below.
    }
    if (detail.error === "invalid_grant") {
      throw new YtShortsError(
        "OAUTH_REAUTH_REQUIRED",
        "The refresh token is expired or revoked. Run auth again. Google OAuth apps in Testing commonly expire refresh tokens after 7 days.",
      );
    }
    await throwApiError(response, "OAUTH_REFRESH_FAILED");
  }
  return normalizeToken(await response.json());
}

function normalizeToken(token) {
  return {
    ...token,
    expiry_date: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : token.expiry_date,
    obtained_at: new Date().toISOString(),
  };
}

function grantedScopes(token) {
  if (Array.isArray(token.granted_scopes)) return [...new Set(token.granted_scopes.map(String))];
  const declared = token.scope ?? token.requested_scopes ?? token.requested_scope ?? "";
  const values = Array.isArray(declared) ? declared : String(declared).split(/\s+/u);
  return [...new Set(values.filter(Boolean))];
}

function assertRequiredScopes(token) {
  const granted = new Set(grantedScopes(token));
  const missing = OAUTH_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new YtShortsError(
      "OAUTH_SCOPE_INSUFFICIENT",
      "Stored authorization lacks the upload/read scopes required for channel protection and post-upload verification. Run auth again.",
      { missing_scopes: missing },
    );
  }
}

async function saveToken(tokenPath, token) {
  const directory = path.dirname(tokenPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  try {
    const existing = await lstat(tokenPath);
    if (existing.isSymbolicLink()) {
      throw new YtShortsError("TOKEN_SYMLINK_REFUSED", `Refusing to replace a token symlink: ${tokenPath}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${tokenPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, tokenPath);
  await chmod(tokenPath, 0o600).catch(() => {});
}

async function readJson(filePath, missingCode, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new YtShortsError(missingCode, `${label} file not found: ${filePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new YtShortsError("INVALID_JSON", `${label} file is not valid JSON: ${filePath}`);
  }
}

async function assertPrivateCredentialFile(filePath, missingCode, label) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new YtShortsError(missingCode, `${label} file not found: ${filePath}`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new YtShortsError("INSECURE_CREDENTIAL_FILE", `${label} must be a regular, non-symlink file: ${filePath}`);
  }
  if (platform() !== "win32" && (info.mode & 0o077) !== 0) {
    throw new YtShortsError(
      "INSECURE_CREDENTIAL_PERMISSIONS",
      `${label} is readable or writable by group/others. Run chmod 600 on: ${filePath}`,
    );
  }
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? requestTimeoutSignal(DEFAULT_API_TIMEOUT_MS),
  });
  if (!response.ok) await throwApiError(response, "YOUTUBE_API_ERROR");
  return response.json();
}

async function throwApiError(response, fallbackCode) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { message: await response.text().catch(() => "") };
  }
  const rawMessage =
    payload?.error?.message ??
    payload?.error_description ??
    payload?.message ??
    `${response.status} ${response.statusText}`;
  const reason = payload?.error?.errors?.[0]?.reason ??
    (typeof payload?.error === "string" ? payload.error : fallbackCode);
  throw new YtShortsError(String(reason || fallbackCode), safeErrorMessage(rawMessage), {
    http_status: response.status,
    reason: String(reason || fallbackCode),
  });
}

async function queryUploadStatus({
  location,
  totalBytes,
  accessToken,
  accessTokenProvider,
  fetchImpl,
  beforeRequest,
  requestTimeoutMs,
}) {
  let lastResponse = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const requestAccessToken = await resolveAccessToken(accessToken, accessTokenProvider);
    await beforeRequest?.();
    try {
      const response = await fetchImpl(location, {
        method: "PUT",
        headers: {
          ...bearer(requestAccessToken),
          "Content-Length": "0",
          "Content-Range": `bytes */${totalBytes}`,
        },
        signal: requestTimeoutSignal(requestTimeoutMs),
      });
      lastResponse = response;
      if (response.status === 200 || response.status === 201) {
        const video = await response.json();
        if (!video?.id) throw new Error("Completed upload status did not include a video ID.");
        return { complete: true, video };
      }
      if (response.status === 308) {
        return { complete: false, offset: nextOffset(response.headers.get("range")) };
      }
      if (!TRANSIENT_STATUS.has(response.status)) {
        await throwApiError(response, "UPLOAD_STATUS_FAILED");
      }
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (error instanceof YtShortsError) throw error;
      lastError = error;
    }
    if (attempt < 5) await delay(retryDelayMs(lastResponse, attempt));
  }
  if (lastResponse?.status === 200 || lastResponse?.status === 201) {
    throw new YtShortsError(
      "UPLOAD_ID_MISSING",
      "The resumable session reports completion, but no video ID could be recovered.",
      { cause: safeErrorMessage(lastError ?? "missing video resource") },
    );
  }
  if (lastResponse) await throwApiError(lastResponse, "UPLOAD_STATUS_RETRIES_EXHAUSTED");
  throw new YtShortsError("UPLOAD_STATUS_NETWORK_FAILED", "Could not query the resumable upload offset.", {
    cause: safeErrorMessage(lastError ?? "unknown network error"),
  });
}

async function startUploadSession({
  url,
  accessToken,
  accessTokenProvider,
  size,
  mimeType,
  requestBody,
  fetchImpl,
  beforeRequest,
  requestTimeoutMs,
}) {
  let lastResponse = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const requestAccessToken = await resolveAccessToken(accessToken, accessTokenProvider);
    await beforeRequest?.();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          ...bearer(requestAccessToken),
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(size),
          "X-Upload-Content-Type": mimeType,
        },
        body: JSON.stringify(requestBody),
        signal: requestTimeoutSignal(requestTimeoutMs),
      });
      lastResponse = response;
      if (response.ok || !TRANSIENT_STATUS.has(response.status)) return response;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await delay(retryDelayMs(lastResponse, attempt));
  }
  if (lastResponse) return lastResponse;
  throw new YtShortsError("UPLOAD_SESSION_NETWORK_FAILED", "Could not create a resumable upload session.", {
    cause: safeErrorMessage(lastError ?? "unknown network error"),
  });
}

function nextOffset(rangeHeader) {
  if (!rangeHeader) return 0;
  const match = rangeHeader.match(/bytes=\d+-(\d+)/u);
  return match ? Number(match[1]) + 1 : 0;
}

function bearer(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function resolveAccessToken(accessToken, accessTokenProvider) {
  const resolved = accessTokenProvider ? await accessTokenProvider() : accessToken;
  if (!resolved) {
    throw new YtShortsError("AUTH_REQUIRED", "No OAuth access token is available for the next request.");
  }
  return resolved;
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/(access_token|refresh_token|client_secret)=([^&\s]+)/giu, "$1=[redacted]");
}

function videoMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return new Map([
    [".mp4", "video/mp4"],
    [".mov", "video/quicktime"],
    [".webm", "video/webm"],
    [".mkv", "video/x-matroska"],
    [".avi", "video/x-msvideo"],
    [".mpeg", "video/mpeg"],
    [".mpg", "video/mpeg"],
  ]).get(extension) ?? "application/octet-stream";
}

function openSystemBrowser(url) {
  const target = platform();
  const command = target === "darwin" ? "open" : target === "win32" ? "rundll32" : "xdg-open";
  const args = target === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function backoffMs(attempt) {
  return Math.min(32_000, 1_000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 500);
}

function retryDelayMs(response, attempt) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return backoffMs(attempt);
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(300_000, Math.max(0, date - Date.now()));
  return backoffMs(attempt);
}

function requestTimeoutSignal(requestTimeoutMs) {
  const raw = typeof requestTimeoutMs === "function" ? requestTimeoutMs() : requestTimeoutMs;
  const milliseconds = Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_REQUEST_TIMEOUT_MS;
  return AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.floor(milliseconds))));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fileHealth(filePath) {
  try {
    const info = await lstat(filePath);
    return {
      path: filePath,
      exists: true,
      regular_file: info.isFile(),
      symbolic_link: info.isSymbolicLink(),
      permissions: (info.mode & 0o777).toString(8).padStart(3, "0"),
      secure_permissions: !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
}
