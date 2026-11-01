const state = { pieces: [], library: [], history: [], folders: [], selectedPieceId: "", selectedSection: null, passageTrail: [], passageIndex: -1, toastTimer: null, wakeLock: null, wakeLockPending: false, offline: false, syncing: null, scoreObjectUrl: "", prefetching: null, roundStarts: {} };
const PIECES_HIDDEN_KEY = "meadowmount.piecesHidden";
const FILL_SCORE_KEY = "meadowmount.fillScore";
const SNAPSHOT_KEY = "meadowmount.snapshot";
const PENDING_KEY = "meadowmount.pending";
const PENDING_ROUNDS_KEY = "meadowmount.pendingRounds";
const SCORE_CACHE = "meadowmount-scores";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uniqueId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  // Errors stay until clicked so they can be read; other messages fade.
  if (!isError) state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function handleError(error) {
  console.error(error);
  if (error.signedOut) showSignedOut();
  showToast(error.message, true);
}

function showSignedOut() {
  document.body.classList.add("signed-out");
  $$(".view").forEach(view => view.classList.toggle("active", view.id === "connect-view"));
}

function showView(name) {
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `${name}-view`));
  $$(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  if (name === "history") loadHistory();
  if (name === "library") loadLibrary();
}

// Per-device view preferences.
function readFlag(key) {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

function writeFlag(key, value) {
  try { localStorage.setItem(key, value ? "1" : ""); } catch { /* storage blocked */ }
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

// Practice logs saved on this device that haven't reached Dropbox yet.
const readPending = () => readJson(PENDING_KEY, []);
const writePending = entries => writeJson(PENDING_KEY, entries);

// Round restarts (piece id → time) saved on this device that haven't reached Dropbox yet.
const readPendingRounds = () => readJson(PENDING_ROUNDS_KEY, {});
const writePendingRounds = rounds => writeJson(PENDING_ROUNDS_KEY, rounds);
const hasPending = () => readPending().length > 0 || Object.keys(readPendingRounds()).length > 0;

// Keeps the latest restart time for each piece.
function mergeRoundStarts(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [pieceId, time] of Object.entries(source)) {
      if (!merged[pieceId] || Date.parse(time) > Date.parse(merged[pieceId])) merged[pieceId] = time;
    }
  }
  return merged;
}

// Adds entries not already present, each placed by its practice time (history is newest first).
// Older timestamps are to the second, so an added entry goes before existing ones from the same moment.
function mergeHistory(history, extra) {
  const known = new Set(history.map(entry => entry.id));
  const merged = [...history];
  const time = entry => Date.parse(entry.timestamp) || 0;
  for (const entry of extra) {
    if (known.has(entry.id)) continue;
    const index = merged.findIndex(existing => time(existing) <= time(entry));
    merged.splice(index < 0 ? merged.length : index, 0, entry);
    known.add(entry.id);
  }
  return merged;
}

function setPiecesHidden(hidden) {
  document.body.classList.toggle("pieces-hidden", hidden);
  const button = $("#toggle-pieces");
  const label = hidden ? "Show pieces" : "Hide pieces";
  button.textContent = hidden ? "»" : "«";
  button.setAttribute("aria-expanded", String(!hidden));
  button.setAttribute("aria-label", label); button.title = label;
  writeFlag(PIECES_HIDDEN_KEY, hidden);
}

// Enlarges screenshots to fill the score frame (keeping their proportions).
function setScoreFilled(filled) {
  $("#score-frame").classList.toggle("fill", filled);
  const button = $("#fit-score");
  button.setAttribute("aria-pressed", String(filled));
  button.textContent = filled ? "⤡ Original size" : "⤢ Fill frame";
  writeFlag(FILL_SCORE_KEY, filled);
}

// Keep the screen on while the app is open. The browser drops the lock when the page is hidden,
// and iPadOS can drop it without warning, so it is re-checked on every tap and every 20 seconds.
async function keepScreenAwake() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return updateAwakeStatus();
  if ((state.wakeLock && !state.wakeLock.released) || state.wakeLockPending) return;
  state.wakeLockPending = true;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", updateAwakeStatus);
  } catch {
    state.wakeLock = null; // not allowed until the next tap
  } finally {
    state.wakeLockPending = false;
    updateAwakeStatus();
  }
}

function updateAwakeStatus() {
  const indicator = $("#awake-status");
  const held = !!state.wakeLock && !state.wakeLock.released;
  indicator.classList.toggle("hidden", !("wakeLock" in navigator));
  indicator.classList.toggle("off", !held);
  indicator.textContent = held ? "☀ Screen on" : "☾ Screen may sleep";
  indicator.title = held ? "The screen stays on while the app is open." : "The screen may sleep. Tap to keep it on.";
}

// Local time with offset, to the millisecond so logs and round restarts always order correctly.
function localTimestamp(date = new Date()) {
  const pad = number => String(Math.abs(number)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`
    + `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function sectionFor(pieceId, sectionPath) {
  const piece = state.library.find(item => item.id === pieceId);
  return piece?.sections.find(section => section.path === sectionPath) || null;
}

function buildLibrary(pieces, listing) {
  const folderPaths = new Set(listing.folderPaths);
  return pieces.map(piece => {
    const folder = String(piece.path || "").replace(/^\/+|\/+$/g, "");
    const prefix = `/${folder.toLowerCase()}/`;
    const sections = listing.files
      .filter(file => file.pathLower.startsWith(prefix))
      .map(file => ({ path: file.pathDisplay.slice(prefix.length), name: file.name, type: /\.pdf$/i.test(file.name) ? "pdf" : "image", dropboxPath: file.pathDisplay, pathLower: file.pathLower, rev: file.rev }))
      .sort((a, b) => collator.compare(a.path, b.path));
    const error = folder && folderPaths.has(`/${folder.toLowerCase()}`) ? null : `Folder “${folder}” was not found in your Dropbox app folder.`;
    return { id: piece.id, name: piece.name, sections, error };
  });
}

function folderSummaries(listing) {
  return listing.topFolders
    .map(name => ({ name, fileCount: listing.files.filter(file => file.pathLower.startsWith(`/${name.toLowerCase()}/`)).length }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

function renderPieces() {
  const usable = state.library.filter(piece => !piece.error && piece.sections.length);
  $("#piece-count").textContent = String(state.pieces.length);
  const list = $("#piece-list");
  list.replaceChildren();
  if (!state.pieces.length) {
    list.innerHTML = '<div class="empty-state compact">Add a piece folder to get started.</div>';
  } else {
    state.library.forEach(piece => {
      const button = document.createElement("button");
      button.className = `piece-choice${piece.id === state.selectedPieceId ? " selected" : ""}`;
      button.type = "button";
      const dot = document.createElement("span"); dot.className = "piece-dot";
      const text = document.createElement("span"); text.className = "piece-choice-text";
      const name = document.createElement("strong"); name.textContent = piece.name;
      const sub = document.createElement("small");
      sub.textContent = piece.error ? "Folder unavailable" : `${piece.sections.length} section${piece.sections.length === 1 ? "" : "s"}`;
      text.append(name, sub); button.append(dot, text);
      if (piece.error || !piece.sections.length) button.disabled = true;
      else button.addEventListener("click", () => selectPiece(piece.id, true));
      list.append(button);
      if (piece.error) { const warning = document.createElement("div"); warning.className = "piece-warning"; warning.textContent = "Check folder settings"; list.append(warning); }
    });
  }
  $("#score-empty").classList.toggle("hidden", usable.length > 0);
  $("#score-workspace").classList.toggle("hidden", !state.selectedSection || !usable.length);
  if (state.selectedSection && !sectionFor(state.selectedSection.pieceId, state.selectedSection.path)) {
    state.selectedSection = null;
    $("#score-workspace").classList.add("hidden");
    $("#score-empty").classList.remove("hidden");
  }
  const addButton = $("#add-piece-shortcut");
  addButton.classList.toggle("hidden", !state.pieces.length);
}

function selectPiece(pieceId, pick = false) {
  state.selectedPieceId = pieceId;
  const piece = state.library.find(item => item.id === pieceId);
  if (pick && piece?.sections.length) chooseRandomSection(piece);
  else renderPieces();
}

function setPassage(pieceId, sectionPath, addToTrail = true, forceTrailEntry = false) {
  const section = sectionFor(pieceId, sectionPath);
  if (!section) return false;
  state.selectedPieceId = pieceId;
  state.selectedSection = { pieceId, path: section.path };
  if (addToTrail) {
    if (state.passageIndex < state.passageTrail.length - 1) {
      state.passageTrail = state.passageTrail.slice(0, state.passageIndex + 1);
    }
    const current = state.passageTrail[state.passageIndex];
    if (forceTrailEntry || !current || current.pieceId !== pieceId || current.path !== section.path) {
      state.passageTrail.push({ pieceId, path: section.path });
      state.passageIndex = state.passageTrail.length - 1;
    }
  }
  renderPractice();
  return true;
}

// Works out the current round from the practice history: a round ends once every
// section in the folder has been logged, or when it was restarted (see nextSection).
function roundProgress(piece) {
  const paths = new Set(piece.sections.map(section => section.path));
  const restartedAt = Date.parse(state.roundStarts[piece.id]) || 0;
  let done = new Set();
  for (let i = state.history.length - 1; i >= 0; i--) {
    const event = state.history[i];
    if (event.pieceId !== piece.id || !paths.has(event.sectionPath)) continue;
    if ((Date.parse(event.timestamp) || 0) <= restartedAt) continue;
    done.add(event.sectionPath);
    if (done.size === paths.size) done = new Set();
  }
  return { done, remaining: piece.sections.filter(section => !done.has(section.path)) };
}

// Picks from sections not yet logged this round, avoiding the passage already on screen.
function chooseRandomSection(piece) {
  if (!piece?.sections?.length) return;
  const { remaining } = roundProgress(piece);
  const current = state.selectedSection?.pieceId === piece.id ? state.selectedSection.path : null;
  const notCurrent = sections => sections.filter(section => section.path !== current);
  const pool = [notCurrent(remaining), notCurrent(piece.sections), piece.sections].find(list => list.length);
  const section = pool[Math.floor(Math.random() * pool.length)];
  setPassage(piece.id, section.path, true, true);
}

// Starts a new round for the piece now; shared with other devices like a practice log.
function restartRound(piece) {
  const time = localTimestamp();
  writePendingRounds({ ...readPendingRounds(), [piece.id]: time });
  state.roundStarts = { ...state.roundStarts, [piece.id]: time };
  syncPending().catch(error => { if (!error.offline) handleError(error); });
}

const newRoundMessage = piece => `New round — picking from all ${piece.sections.length} sections of ${piece.name} again.`;

// "Practice next": once only one section is left in the round, start a new round from the full set.
function nextSection(piece) {
  if (!piece?.sections?.length) return;
  const restart = piece.sections.length > 1 && roundProgress(piece).remaining.length === 1;
  if (restart) restartRound(piece);
  chooseRandomSection(piece);
  if (restart) showToast(newRoundMessage(piece));
}

function navigatePassage(index) {
  if (index < 0 || index >= state.passageTrail.length || index === state.passageIndex) return;
  const passage = state.passageTrail[index];
  if (!sectionFor(passage.pieceId, passage.path)) {
    showToast("That passage is no longer available in its piece folder.", true);
    return;
  }
  state.passageIndex = index;
  setPassage(passage.pieceId, passage.path, false);
}

function updatePassageNavigation() {
  const hasPassage = state.passageIndex >= 0;
  $("#passage-back").disabled = !hasPassage || state.passageIndex === 0;
  $("#passage-forward").disabled = !hasPassage || state.passageIndex >= state.passageTrail.length - 1;
  $("#move-to-latest").disabled = !hasPassage || state.passageIndex >= state.passageTrail.length - 1;
}

function showMediaFallback(frame, element, offline = false) {
  if (!element.isConnected) return;
  frame.innerHTML = offline
    ? '<div class="media-fallback">This score isn’t saved on this device yet. Open the app once with an internet connection to download it.</div>'
    : '<div class="media-fallback">This score file could not be displayed. Check that it is still in Dropbox and is a valid PDF, PNG or JPEG.</div>';
}

// Score files are kept on the device (Cache Storage) so practice works offline.
const scoreKey = section => `__scores__/${encodeURIComponent(section.pathLower)}?rev=${encodeURIComponent(section.rev)}`;
const SCORE_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

async function cachedScore(section) {
  const cache = await caches.open(SCORE_CACHE);
  const stored = await cache.match(scoreKey(section));
  if (stored) return stored.blob();
  const type = SCORE_TYPES[section.name.split(".").pop().toLowerCase()] || "application/octet-stream";
  const blob = new Blob([await Dropbox.downloadFile(section.dropboxPath)], { type });
  await cache.put(scoreKey(section), new Response(blob, { headers: { "Content-Type": type } }));
  return blob;
}

async function scoreUrl(section) {
  if (!globalThis.caches) return Dropbox.mediaUrl(section.dropboxPath);
  return URL.createObjectURL(await cachedScore(section));
}

// Downloads every score for the configured pieces and drops copies that are out of date.
async function downloadScores() {
  try {
    const cache = await caches.open(SCORE_CACHE);
    const sections = state.library.flatMap(piece => piece.sections);
    const wanted = new Set(sections.map(section => new URL(scoreKey(section), location.href).href));
    for (const request of await cache.keys()) if (!wanted.has(request.url)) await cache.delete(request);
    for (const section of sections) await cachedScore(section);
  } catch { /* offline or interrupted; carries on next time */ }
}

// Runs one download pass at a time; a request made during a pass queues another with the latest library.
function prefetchScores() {
  if (!globalThis.caches) return Promise.resolve();
  state.prefetching = (state.prefetching || Promise.resolve()).then(downloadScores);
  return state.prefetching;
}

function updateSectionCounter() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  if (!selected) return;
  const piece = state.library.find(item => item.id === state.selectedSection.pieceId);
  const total = piece.sections.length;
  $("#section-counter").textContent = `${piece.sections.indexOf(selected) + 1} of ${total} · ${roundProgress(piece).done.size} of ${total} practised this round`;
}

function renderPractice() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  const validPieceCount = state.library.filter(piece => !piece.error && piece.sections.length).length;
  $("#score-empty").classList.toggle("hidden", !!selected || validPieceCount > 0);
  $("#score-workspace").classList.toggle("hidden", !selected);
  renderPieces();
  updatePassageNavigation();
  if (!selected) return;
  const piece = state.library.find(item => item.id === state.selectedSection.pieceId);
  $("#selected-piece-name").textContent = piece.name.toLocaleUpperCase();
  $("#section-name").textContent = selected.name;
  $("#section-path").textContent = state.selectedSection.path;
  updateSectionCounter();
  const frame = $("#score-frame");
  frame.replaceChildren();
  $("#fit-score").classList.toggle("hidden", selected.type !== "image");
  const element = document.createElement(selected.type === "image" ? "img" : "iframe");
  if (selected.type === "image") {
    element.alt = `${piece.name} — ${selected.name}`;
    element.addEventListener("error", () => showMediaFallback(frame, element));
  } else {
    element.title = `${piece.name} — ${selected.name}`;
    element.setAttribute("allow", "fullscreen");
  }
  frame.append(element);
  scoreUrl(selected)
    .then(url => {
      const isObjectUrl = url.startsWith("blob:");
      if (!element.isConnected) { if (isObjectUrl) URL.revokeObjectURL(url); return; }
      if (state.scoreObjectUrl) URL.revokeObjectURL(state.scoreObjectUrl);
      state.scoreObjectUrl = isObjectUrl ? url : "";
      element.src = url;
    })
    .catch(error => { showMediaFallback(frame, element, error.offline); if (error.signedOut) handleError(error); });
  $("#note-editor").classList.add("hidden");
  $("#note-text").value = "";
}

// History shown on this device includes logs still waiting to sync.
function applyData(data) {
  state.pieces = data.pieces;
  state.history = mergeHistory(data.history, readPending());
  state.roundStarts = mergeRoundStarts(data.roundStarts, readPendingRounds());
}

// For data just read from or written to Dropbox: also refreshes this device's offline copy.
function applySaved(data) {
  const snapshot = readJson(SNAPSHOT_KEY, null);
  if (snapshot) writeJson(SNAPSHOT_KEY, { ...snapshot, data });
  setOffline(false);
  applyData(data);
}

function setOffline(offline) {
  state.offline = offline;
  updateSyncStatus();
}

function updateSyncStatus() {
  const waiting = readPending().length;
  const text = state.offline
    ? (waiting ? `Offline · ${waiting} waiting to sync` : "Offline")
    : waiting ? (state.syncing ? `Syncing ${waiting}…` : `${waiting} waiting to sync`) : "Synced with Dropbox";
  $("#sync-status-text").textContent = text;
  $("#sync-status").classList.toggle("attention", state.offline || waiting > 0);
}

// Reads the library from Dropbox, or this device's last copy when offline.
async function fetchLibrary() {
  try {
    const [{ data }, listing] = await Promise.all([Dropbox.readData(), Dropbox.listLibrary()]);
    writeJson(SNAPSHOT_KEY, { data, listing });
    setOffline(false);
    return { data, listing, fresh: true };
  } catch (error) {
    const snapshot = readJson(SNAPSHOT_KEY, null);
    if (!error.offline || !snapshot) throw error;
    setOffline(true);
    return { ...snapshot, fresh: false };
  }
}

// Sends logs and round restarts saved on this device to Dropbox, merging logs in by practice time.
// Anything added while a sync is running is picked up by the same sync.
function syncPending() {
  if (!state.syncing) {
    state.syncing = (async () => {
      try {
        while (hasPending()) {
          const pending = readPending();
          const rounds = readPendingRounds();
          updateSyncStatus();
          const data = await Dropbox.mutate(saved => {
            saved.history = mergeHistory(saved.history, pending);
            if (Object.keys(rounds).length) saved.roundStarts = mergeRoundStarts(saved.roundStarts, rounds);
          });
          const sent = new Set(pending.map(entry => entry.id));
          writePending(readPending().filter(entry => !sent.has(entry.id)));
          writePendingRounds(Object.fromEntries(Object.entries(readPendingRounds()).filter(([pieceId, time]) => rounds[pieceId] !== time)));
          applySaved(data);
        }
      } catch (error) {
        if (error.offline) setOffline(true);
        throw error;
      } finally {
        state.syncing = null;
        updateSyncStatus();
      }
    })();
  }
  return state.syncing;
}

function syncInBackground() {
  const waiting = readPending().length;
  if (!hasPending() || !Dropbox.isConnected()) return;
  syncPending()
    .then(() => {
      updateSectionCounter();
      if ($("#history-view").classList.contains("active")) renderHistory();
      if (waiting) showToast(`${waiting} practice log${waiting === 1 ? "" : "s"} from this device synced to Dropbox.`);
    })
    .catch(error => { if (!error.offline) handleError(error); });
}

async function refreshLibrary() {
  const { data, listing, fresh } = await fetchLibrary();
  applyData(data);
  state.library = buildLibrary(state.pieces, listing);
  state.folders = folderSummaries(listing);
  if (fresh) { prefetchScores(); syncInBackground(); }
  if (!state.library.some(piece => piece.id === state.selectedPieceId && !piece.error && piece.sections.length)) {
    state.selectedPieceId = state.library.find(piece => !piece.error && piece.sections.length)?.id || "";
    state.selectedSection = null;
  } else if (state.selectedSection && !sectionFor(state.selectedSection.pieceId, state.selectedSection.path)) {
    state.selectedSection = null;
  }
  if (!state.selectedSection) {
    const firstAvailable = state.library.find(piece => !piece.error && piece.sections.length);
    if (firstAvailable) {
      state.selectedPieceId = firstAvailable.id;
      chooseRandomSection(firstAvailable);
      return;
    }
  }
  renderPractice();
}

async function loadLibrary() {
  try {
    await refreshLibrary();
    renderLibrary();
  } catch (error) { handleError(error); }
}

async function disconnectDropbox() {
  if (hasPending()) {
    try { await syncPending(); }
    catch {
      const waiting = readPending().length;
      if (!confirm(`${waiting} practice log${waiting === 1 ? " hasn’t" : "s haven’t"} reached Dropbox yet and will be lost if you disconnect now. Disconnect anyway?`)) return;
    }
  }
  if (!confirm("Disconnect Dropbox on this device? Your files and history stay in Dropbox; you can connect again at any time.")) return;
  await Dropbox.disconnect();
  writePending(null);
  writePendingRounds(null);
  writeJson(SNAPSHOT_KEY, null);
  if (globalThis.caches) await caches.delete(SCORE_CACHE).catch(() => {});
  updateSyncStatus();
  Object.assign(state, { pieces: [], library: [], history: [], folders: [], selectedPieceId: "", selectedSection: null, passageTrail: [], passageIndex: -1 });
  showSignedOut();
}

function renderLibrary() {
  const host = $("#library-list"); host.replaceChildren();
  if (!state.pieces.length) {
    const empty = document.createElement("div"); empty.className = "card empty-state";
    empty.textContent = "No pieces configured yet. Add one to get started."; host.append(empty); return;
  }
  state.library.forEach(piece => {
    const config = state.pieces.find(item => item.id === piece.id);
    if (!config) return;
    const card = document.createElement("article"); card.className = "card library-card";
    const top = document.createElement("div"); top.className = "library-card-top";
    const details = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = config.name;
    const path = document.createElement("div"); path.className = "library-path"; path.textContent = config.path;
    details.append(title, path);
    const badge = document.createElement("span"); badge.className = "file-count";
    badge.textContent = `${piece.sections.length} file${piece.sections.length === 1 ? "" : "s"}`;
    top.append(details, badge); card.append(top);
    if (piece.error) { const error = document.createElement("div"); error.className = "library-error"; error.textContent = piece.error; card.append(error); }
    else if (!piece.sections.length) { const empty = document.createElement("div"); empty.className = "library-error"; empty.textContent = "No PDF, PNG, or JPEG files found in this folder."; card.append(empty); }
    const actions = document.createElement("div"); actions.className = "library-card-actions";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "small-button"; edit.textContent = "Edit"; edit.addEventListener("click", () => openPieceForm(config));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "small-button"; remove.textContent = "Remove"; remove.addEventListener("click", () => removePiece(config.id));
    actions.append(edit, remove); card.append(actions); host.append(card);
  });
}

function openPieceForm(piece = null) {
  $("#piece-form").reset();
  $("#folder-browser").classList.add("hidden");
  $("#piece-id").value = piece?.id || "";
  $("#piece-name").value = piece?.name || "";
  $("#piece-path").value = piece?.path || "";
  $("#piece-form-title").textContent = piece ? "Edit piece" : "Add a piece";
  $("#piece-form-eyebrow").textContent = piece ? "UPDATE PIECE" : "NEW PIECE";
  $("#save-piece").textContent = piece ? "Save changes" : "Save piece";
  $("#piece-form-wrap").classList.remove("hidden");
  $("#piece-name").focus();
  $("#piece-form-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
}

function closePieceForm() { $("#piece-form-wrap").classList.add("hidden"); $("#folder-browser").classList.add("hidden"); $("#piece-form").reset(); }

function renderFolderBrowser() {
  const host = $("#folder-browser"); host.replaceChildren();
  if (!state.folders.length) {
    host.innerHTML = '<div class="empty-state compact">No folders found. In Finder, add a folder of score screenshots to your Dropbox app folder, then choose Browse again.</div>';
    return;
  }
  const editingId = $("#piece-id").value;
  state.folders.forEach(folder => {
    const owner = state.pieces.find(piece => piece.path.toLowerCase() === folder.name.toLowerCase());
    const taken = owner && owner.id !== editingId;
    const button = document.createElement("button"); button.type = "button"; button.className = "folder-choice";
    const name = document.createElement("strong"); name.textContent = folder.name;
    const sub = document.createElement("small");
    sub.textContent = `${folder.fileCount} file${folder.fileCount === 1 ? "" : "s"} · ${taken ? "Already added" : owner ? "This piece" : "Not added yet"}`;
    button.append(name, sub);
    button.disabled = !!taken;
    button.addEventListener("click", () => {
      $("#piece-path").value = folder.name;
      if (!$("#piece-name").value.trim()) $("#piece-name").value = folder.name.replace(/_/g, " ").slice(0, 120);
      host.classList.add("hidden");
    });
    host.append(button);
  });
}

async function toggleFolderBrowser() {
  const host = $("#folder-browser");
  if (!host.classList.contains("hidden")) { host.classList.add("hidden"); return; }
  host.innerHTML = '<div class="empty-state compact">Loading folders…</div>';
  host.classList.remove("hidden");
  try { state.folders = folderSummaries(await Dropbox.listLibrary()); renderFolderBrowser(); }
  catch (error) { host.classList.add("hidden"); handleError(error); }
}

async function savePiece(event) {
  event.preventDefault();
  const id = $("#piece-id").value || uniqueId();
  const piece = { id, name: $("#piece-name").value.trim(), path: $("#piece-path").value.trim() };
  if (!piece.path) { showToast("Choose a folder with Browse… first.", true); return; }
  const isEdit = state.pieces.some(item => item.id === id);
  try {
    await Dropbox.mutate(data => {
      const index = data.pieces.findIndex(item => item.id === id);
      if (index >= 0) data.pieces[index] = piece; else data.pieces.push(piece);
    });
    closePieceForm();
    await refreshLibrary();
    renderLibrary();
    showToast(isEdit ? "Piece settings updated." : "Piece added to your library.");
  } catch (error) { handleError(error); }
}

async function removePiece(id) {
  const piece = state.pieces.find(item => item.id === id);
  if (!piece || !confirm(`Remove “${piece.name}” from this app? Your files will not be deleted. Existing history entries will remain.`)) return;
  try {
    await Dropbox.mutate(data => { data.pieces = data.pieces.filter(item => item.id !== id); });
    if (state.selectedPieceId === id) { state.selectedPieceId = ""; state.selectedSection = null; }
    await refreshLibrary(); renderLibrary();
    showToast("Piece removed. Your score files were not changed.");
  } catch (error) { handleError(error); }
}

async function loadHistory() {
  try {
    const { data } = await Dropbox.readData(); applySaved(data); renderHistory();
  } catch (error) {
    const snapshot = readJson(SNAPSHOT_KEY, null);
    if (error.offline && snapshot) { setOffline(true); applyData(snapshot.data); renderHistory(); }
    else handleError(error);
  }
}

function renderHistory() {
  const host = $("#history-list"); host.replaceChildren();
  const query = $("#history-search").value.trim().toLocaleLowerCase();
  const filtered = state.history.filter(event => `${event.pieceName} ${event.sectionName} ${event.sectionPath} ${event.note}`.toLocaleLowerCase().includes(query));
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "card empty-state";
    empty.textContent = state.history.length ? "No practice entries match your search." : "No practice notes saved yet. Use the Notes button during practice to record a session.";
    host.append(empty); return;
  }
  filtered.forEach(event => {
    const card = document.createElement("article"); card.className = "card history-card";
    const icon = document.createElement("div"); icon.className = "history-icon"; icon.textContent = "♪";
    const main = document.createElement("div"); main.className = "history-main";
    const date = document.createElement("p"); date.className = "history-meta"; date.textContent = formatDate(event.timestamp);
    const title = document.createElement("h3"); title.textContent = event.pieceName || "Unknown piece";
    const filename = document.createElement("p"); filename.className = "history-file"; filename.textContent = event.sectionPath || event.sectionName || "Section unavailable";
    const note = document.createElement("p"); note.className = event.note ? "history-note" : "history-note blank-note"; note.textContent = event.note || "Practice recorded — no note added.";
    main.append(date, title, filename, note);
    const actions = document.createElement("div"); actions.className = "history-actions";
    const reopen = document.createElement("button"); reopen.className = "small-button"; reopen.textContent = "Open section"; reopen.addEventListener("click", () => reopenHistory(event));
    const remove = document.createElement("button"); remove.className = "small-button"; remove.textContent = "Delete"; remove.setAttribute("aria-label", `Delete practice entry for ${event.pieceName}`); remove.addEventListener("click", () => deleteHistory(event.id));
    actions.append(reopen, remove); card.append(icon, main, actions); host.append(card);
  });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "Practice session";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function reopenHistory(event) {
  const piece = state.library.find(item => item.id === event.pieceId);
  if (!piece || piece.error) { showToast("That piece folder is not available. Check its settings first.", true); showView("library"); return; }
  const section = sectionFor(event.pieceId, event.sectionPath);
  if (!section) {
    try { await refreshLibrary(); } catch { /* handled below */ }
  }
  if (!sectionFor(event.pieceId, event.sectionPath)) {
    showToast("That score file is no longer in the configured folder.", true); return;
  }
  setPassage(event.pieceId, event.sectionPath, true, true);
  showView("practice");
}

async function deleteHistory(id) {
  if (!confirm("Delete this practice history entry?")) return;
  try {
    writePending(readPending().filter(event => event.id !== id));
    applySaved(await Dropbox.mutate(data => { data.history = data.history.filter(event => event.id !== id); }));
    renderHistory(); showToast("History entry deleted.");
  } catch (error) { handleError(error); }
}

function exportHistory() {
  const blob = new Blob([JSON.stringify({ format: "meadowmount-practice-history", version: 1, exportedAt: new Date().toISOString(), history: state.history }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `meadowmount-history-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
}

async function importHistory(event) {
  const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const entries = Array.isArray(parsed) ? parsed : parsed.history;
    if (!Array.isArray(entries)) throw new Error("This file does not contain a Meadowmount history list.");
    const valid = entries.filter(item => item && typeof item === "object" && typeof item.sectionPath === "string" && typeof item.note === "string");
    if (!valid.length) throw new Error("No valid history entries were found.");
    applySaved(await Dropbox.mutate(data => {
      const existingIds = new Set(data.history.map(item => item.id));
      const pieceNames = new Map(data.pieces.map(piece => [piece.id, piece.name]));
      const cleaned = valid.map(item => ({ id: existingIds.has(item.id) ? uniqueId() : (item.id || uniqueId()), timestamp: item.timestamp || localTimestamp(), pieceId: item.pieceId || "", pieceName: pieceNames.get(item.pieceId) || item.pieceName || "Imported piece", sectionPath: item.sectionPath, sectionName: item.sectionName || item.sectionPath.split("/").pop(), note: item.note.slice(0, 10000) }));
      data.history = [...cleaned, ...data.history];
    }));
    renderHistory(); showToast(`${valid.length} history entr${valid.length === 1 ? "y" : "ies"} imported.`);
  } catch (error) { handleError(error); }
}

function openNoteEditor() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  if (!selected) return;
  $("#note-context").textContent = `${state.library.find(piece => piece.id === state.selectedSection.pieceId)?.name || "Piece"} · ${selected.name}`;
  $("#note-editor").classList.remove("hidden");
  $("#note-text").focus();
  $("#note-editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Saves a practice entry on this device first, then sends it (with anything else waiting) to Dropbox.
// Returns false if it is waiting to sync because the device is offline.
async function recordPractice(pieceId, section, note) {
  const piece = state.library.find(item => item.id === pieceId);
  const entry = { id: uniqueId(), timestamp: localTimestamp(), pieceId, pieceName: piece?.name || "Unknown piece", sectionPath: section.path, sectionName: section.name, note: note.slice(0, 10000) };
  writePending([...readPending(), entry]);
  state.history = mergeHistory(state.history, [entry]);
  updateSyncStatus();
  try {
    await syncPending();
    return true;
  } catch (error) {
    if (error.offline) return false;
    throw error;
  }
}

const OFFLINE_SAVED = " Saved on this device — it will sync to Dropbox when you’re back online.";

async function saveNote() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  if (!selected) return;
  const button = $("#save-note"); button.disabled = true; button.textContent = "Saving…";
  try {
    const synced = await recordPractice(state.selectedSection.pieceId, selected, $("#note-text").value);
    $("#note-editor").classList.add("hidden"); $("#note-text").value = "";
    updateSectionCounter();
    const piece = state.library.find(item => item.id === state.selectedSection.pieceId);
    showToast((roundProgress(piece).done.size === 0
      ? `Practice saved. Round complete — you’ve practised all ${piece.sections.length} sections of ${piece.name}.`
      : "Practice session saved to your history.") + (synced ? "" : OFFLINE_SAVED));
  } catch (error) { handleError(error); }
  finally { button.disabled = false; button.textContent = "Save practice note"; }
}

async function logAndPracticeNext() {
  const current = state.selectedSection && { ...state.selectedSection };
  const selected = current && sectionFor(current.pieceId, current.path);
  const piece = current && state.library.find(item => item.id === current.pieceId);
  if (!selected || !piece?.sections.length) return;
  const button = $("#log-and-next");
  button.disabled = true;
  button.textContent = "Saving practice…";
  try {
    const lastOneLeft = roundProgress(piece).remaining.length === 1;
    const synced = await recordPractice(current.pieceId, selected, "");
    const roundComplete = roundProgress(piece).done.size === 0;
    // Only one section was left and this log didn't complete the round, so start a new one.
    const restart = lastOneLeft && !roundComplete && piece.sections.length > 1;
    if (restart) restartRound(piece);
    chooseRandomSection(piece);
    showToast((roundComplete
      ? `Round complete — you’ve practised all ${piece.sections.length} sections of ${piece.name}. Starting a new round.`
      : restart ? `Passage logged. ${newRoundMessage(piece)}` : "Passage logged. Here’s another section to practice.") + (synced ? "" : OFFLINE_SAVED));
  } catch (error) {
    handleError(error);
  } finally {
    button.disabled = false;
    button.innerHTML = '✓ <span>Log passage and practice next</span>';
  }
}

async function connectDropbox() {
  try { await Dropbox.connect(); } catch (error) { handleError(error); }
}

function wireEvents() {
  $$(".nav-button").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $("#toast").addEventListener("click", () => $("#toast").classList.remove("show"));
  $("#toggle-pieces").addEventListener("click", () => setPiecesHidden(!document.body.classList.contains("pieces-hidden")));
  $("#fit-score").addEventListener("click", () => setScoreFilled(!$("#score-frame").classList.contains("fill")));
  document.addEventListener("visibilitychange", keepScreenAwake);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncInBackground(); });
  window.addEventListener("online", () => { setOffline(false); syncInBackground(); prefetchScores(); });
  window.addEventListener("offline", () => setOffline(true));
  setInterval(syncInBackground, 60_000);
  document.addEventListener("pointerdown", keepScreenAwake);
  $("#awake-status").addEventListener("click", keepScreenAwake);
  setInterval(keepScreenAwake, 20_000);
  $("#connect-dropbox").addEventListener("click", connectDropbox);
  $("#disconnect-dropbox").addEventListener("click", disconnectDropbox);
  $("#go-library").addEventListener("click", () => showView("library"));
  $("#add-piece-shortcut").addEventListener("click", () => { showView("library"); openPieceForm(); });
  $("#empty-add-piece").addEventListener("click", () => { showView("library"); openPieceForm(); });
  $("#new-piece").addEventListener("click", () => openPieceForm());
  $("#cancel-piece").addEventListener("click", closePieceForm);
  $("#cancel-piece-secondary").addEventListener("click", closePieceForm);
  $("#browse-folders").addEventListener("click", toggleFolderBrowser);
  $("#piece-form").addEventListener("submit", savePiece);
  $("#practice-next").addEventListener("click", () => nextSection(state.library.find(piece => piece.id === state.selectedPieceId)));
  $("#log-and-next").addEventListener("click", logAndPracticeNext);
  $("#passage-back").addEventListener("click", () => navigatePassage(state.passageIndex - 1));
  $("#passage-forward").addEventListener("click", () => navigatePassage(state.passageIndex + 1));
  $("#move-to-latest").addEventListener("click", () => navigatePassage(state.passageTrail.length - 1));
  $("#open-note").addEventListener("click", openNoteEditor);
  $("#close-note").addEventListener("click", () => $("#note-editor").classList.add("hidden"));
  $("#save-note").addEventListener("click", saveNote);
  $("#history-search").addEventListener("input", renderHistory);
  $("#export-history").addEventListener("click", exportHistory);
  $("#import-history").addEventListener("change", importHistory);
}

async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* app still works online */ });
  wireEvents();
  updateSyncStatus();
  setPiecesHidden(readFlag(PIECES_HIDDEN_KEY));
  setScoreFilled(readFlag(FILL_SCORE_KEY));
  keepScreenAwake();
  try {
    if (await Dropbox.finishConnect()) showToast("Dropbox connected.");
  } catch (error) { handleError(error); }
  if (!Dropbox.isConnected()) { showSignedOut(); return; }
  document.body.classList.remove("signed-out");
  showView("practice");
  try {
    await refreshLibrary();
    renderHistory();
  } catch (error) {
    handleError(error);
  }
}

document.addEventListener("DOMContentLoaded", start);
