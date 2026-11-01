// Dropbox storage for the app: sign-in (OAuth PKCE), library listing, and app-data.json.
// Everything lives in the Dropbox "App folder", so paths are relative to Dropbox/Apps/<app name>/.
const Dropbox = (() => {
  const AUTH_KEY = "meadowmount.dropbox";
  const PENDING_KEY = "meadowmount.dropbox.pending";
  const DATA_PATH = "/app-data.json";
  const SUPPORTED = /\.(pdf|png|jpe?g)$/i;
  const MAX_HISTORY = 5000;
  const links = new Map();
  let auth = readStored(AUTH_KEY);

  class DropboxError extends Error {
    constructor(message, { status = 0, summary = "", signedOut = false, offline = false } = {}) {
      super(message);
      this.status = status; this.summary = summary; this.signedOut = signedOut; this.offline = offline;
    }
  }

  const offlineError = () => new DropboxError("You’re offline — this needs a connection to Dropbox.", { offline: true });

  function readStored(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
  }

  function writeStored(key, value) {
    try { value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); } catch { /* storage blocked */ }
  }

  function saveAuth(value) { auth = value; writeStored(AUTH_KEY, value); }

  const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

  // Dropbox-API-Arg must be ASCII, so escape anything else (e.g. accented folder names).
  const headerArg = value => JSON.stringify(value).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

  function isConnected() { return !!auth?.refreshToken; }

  async function connect() {
    if (!DROPBOX_APP_KEY) throw new DropboxError("Add your Dropbox app key to config.js first.");
    const verifier = randomString();
    const state = randomString();
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    writeStored(PENDING_KEY, { verifier, state });
    const params = new URLSearchParams({
      client_id: DROPBOX_APP_KEY, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      token_access_type: "offline", redirect_uri: REDIRECT_URI, state,
    });
    location.assign(`https://www.dropbox.com/oauth2/authorize?${params}`);
  }

  // Completes sign-in when Dropbox redirects back with ?code=…; returns true if it did.
  async function finishConnect() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return false;
    history.replaceState(null, "", REDIRECT_URI);
    const pending = readStored(PENDING_KEY);
    writeStored(PENDING_KEY, null);
    if (params.has("error")) throw new DropboxError(params.get("error_description") || "Dropbox sign-in was cancelled.");
    if (!pending || params.get("state") !== pending.state) throw new DropboxError("Dropbox sign-in could not be verified. Please try again.");
    const token = await tokenRequest({ grant_type: "authorization_code", code: params.get("code"), code_verifier: pending.verifier, redirect_uri: REDIRECT_URI });
    saveAuth({ refreshToken: token.refresh_token, accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 });
    return true;
  }

  async function tokenRequest(fields) {
    let response;
    try { response = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body: new URLSearchParams({ client_id: DROPBOX_APP_KEY, ...fields }) }); }
    catch { throw offlineError(); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (fields.grant_type === "refresh_token" && response.status === 400) {
        saveAuth(null);
        throw new DropboxError("Your Dropbox connection has expired. Please connect again.", { signedOut: true });
      }
      throw new DropboxError(data.error_description || `Dropbox sign-in failed (${response.status}).`);
    }
    return data;
  }

  async function accessToken() {
    if (!isConnected()) throw new DropboxError("Connect Dropbox to continue.", { signedOut: true });
    if (auth.accessToken && Date.now() < auth.expiresAt - 60_000) return auth.accessToken;
    const token = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refreshToken });
    saveAuth({ ...auth, accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 });
    return auth.accessToken;
  }

  // Sends an authorised request, refreshing the access token once if Dropbox rejects it.
  async function send(url, options, retried = false) {
    const headers = { ...options.headers, Authorization: `Bearer ${await accessToken()}` };
    let response;
    try { response = await fetch(url, { ...options, method: "POST", headers }); }
    catch { throw offlineError(); }
    if (response.status === 401 && !retried) {
      saveAuth({ ...auth, accessToken: "" });
      return send(url, options, true);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let summary = "";
      try { summary = JSON.parse(text).error_summary || ""; } catch { summary = text; }
      // A sign-in keeps the permissions it was granted with, so a newly ticked permission needs a fresh sign-in.
      if (summary.startsWith("missing_scope")) {
        saveAuth(null);
        throw new DropboxError("The app’s Dropbox permissions have changed. Please connect Dropbox again.", { status: response.status, summary, signedOut: true });
      }
      throw new DropboxError(`Dropbox request failed: ${summary || response.status}`, { status: response.status, summary });
    }
    return response;
  }

  async function rpc(endpoint, args = null) {
    const response = await send(`https://api.dropboxapi.com/2/${endpoint}`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return response.json();
  }

  async function disconnect() {
    try { if (isConnected()) await rpc("auth/token/revoke"); } catch { /* already revoked */ }
    saveAuth(null);
    links.clear();
  }

  async function listFolder(path) {
    let page = await rpc("files/list_folder", { path, recursive: true });
    const entries = [...page.entries];
    while (page.has_more) {
      page = await rpc("files/list_folder/continue", { cursor: page.cursor });
      entries.push(...page.entries);
    }
    return entries;
  }

  // Returns every folder (as lower-case paths), the top-level folders, and every supported score file.
  // Plain arrays so the listing can be saved on the device for offline use.
  async function listLibrary() {
    const folderPaths = [];
    const topFolders = [];
    const files = [];
    for (const entry of await listFolder("")) {
      const parts = entry.path_display.split("/").slice(1);
      if (parts.some(part => part.startsWith("."))) continue;
      if (entry[".tag"] === "folder") {
        folderPaths.push(entry.path_lower);
        if (parts.length === 1) topFolders.push(entry.name);
      } else if (entry[".tag"] === "file" && parts.length > 1 && SUPPORTED.test(entry.name)) {
        files.push({ name: entry.name, pathDisplay: entry.path_display, pathLower: entry.path_lower, rev: entry.rev || "" });
      }
    }
    return { folderPaths, topFolders, files };
  }

  // Older Mac versions stored absolute folder paths; keep only the folder name inside the library.
  function normalizeData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DropboxError("app-data.json must contain a JSON object.");
    data.pieces = Array.isArray(data.pieces) ? data.pieces : [];
    data.history = Array.isArray(data.history) ? data.history : [];
    data.pieces.forEach(piece => {
      const path = String(piece.path || "");
      if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) piece.path = path.split(/[\\/]/).filter(Boolean).pop() || "";
    });
    return data;
  }

  async function readData() {
    let response;
    try {
      response = await send("https://content.dropboxapi.com/2/files/download", { headers: { "Dropbox-API-Arg": headerArg({ path: DATA_PATH }) } });
    } catch (error) {
      if (error.summary.startsWith("path/not_found")) return { data: { pieces: [], history: [] }, rev: null };
      throw error;
    }
    const rev = JSON.parse(response.headers.get("Dropbox-API-Result") || "{}").rev || null;
    let data;
    try { data = JSON.parse(await response.text()); }
    catch { throw new DropboxError("app-data.json in Dropbox is not valid JSON. Restore a previous version from dropbox.com."); }
    return { data: normalizeData(data), rev };
  }

  async function writeData(data, rev) {
    const mode = rev ? { ".tag": "update", update: rev } : { ".tag": "add" };
    await send("https://content.dropboxapi.com/2/files/upload", {
      headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerArg({ path: DATA_PATH, mode, autorename: false, mute: true, strict_conflict: true }) },
      body: new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`),
    });
  }

  // Read, change, write; if another device saved in between, start again from its version.
  async function mutate(change) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, rev } = await readData();
      change(data);
      data.history = data.history.slice(0, MAX_HISTORY);
      try {
        await writeData(data, rev);
        return data;
      } catch (error) {
        if (!error.summary.startsWith("path/conflict")) throw error;
      }
    }
    throw new DropboxError("Another device kept saving at the same time. Please try again.");
  }

  async function downloadFile(path) {
    const response = await send("https://content.dropboxapi.com/2/files/download", { headers: { "Dropbox-API-Arg": headerArg({ path }) } });
    return response.blob();
  }

  // Temporary links last four hours; reuse them for a little less than that.
  async function mediaUrl(path) {
    const cached = links.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const { link } = await rpc("files/get_temporary_link", { path });
    links.set(path, { url: link, expiresAt: Date.now() + 3.5 * 60 * 60 * 1000 });
    return link;
  }

  return { isConnected, connect, finishConnect, disconnect, listLibrary, readData, mutate, downloadFile, mediaUrl };
})();
