const state = { pieces: [], library: [], history: [], folders: [], selectedPieceId: "", selectedSection: null, passageTrail: [], passageIndex: -1, toastTimer: null, wakeLock: null };
const PIECES_HIDDEN_KEY = "meadowmount.piecesHidden";
const FILL_SCORE_KEY = "meadowmount.fillScore";
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

// Keep the screen on while the app is open; the browser releases the lock whenever the page is hidden.
async function keepScreenAwake() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch { /* not allowed until the next tap */ }
}

// Same format the Python server wrote: local time with offset, whole seconds.
function localTimestamp(date = new Date()) {
  const pad = number => String(Math.abs(number)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function sectionFor(pieceId, sectionPath) {
  const piece = state.library.find(item => item.id === pieceId);
  return piece?.sections.find(section => section.path === sectionPath) || null;
}

function buildLibrary(pieces, listing) {
  return pieces.map(piece => {
    const folder = String(piece.path || "").replace(/^\/+|\/+$/g, "");
    const prefix = `/${folder.toLowerCase()}/`;
    const sections = listing.files
      .filter(file => file.pathLower.startsWith(prefix))
      .map(file => ({ path: file.pathDisplay.slice(prefix.length), name: file.name, type: /\.pdf$/i.test(file.name) ? "pdf" : "image", dropboxPath: file.pathDisplay }))
      .sort((a, b) => collator.compare(a.path, b.path));
    const error = folder && listing.folderPaths.has(`/${folder.toLowerCase()}`) ? null : `Folder “${folder}” was not found in your Dropbox app folder.`;
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
// section in the folder has been logged, and the next log starts a new one.
function roundProgress(piece) {
  const paths = new Set(piece.sections.map(section => section.path));
  let done = new Set();
  for (let i = state.history.length - 1; i >= 0; i--) {
    const event = state.history[i];
    if (event.pieceId !== piece.id || !paths.has(event.sectionPath)) continue;
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
  const pool = remaining.length > 1 ? remaining.filter(section => section.path !== current) : remaining;
  const section = pool[Math.floor(Math.random() * pool.length)];
  setPassage(piece.id, section.path, true, true);
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

function showMediaFallback(frame, element) {
  if (!element.isConnected) return;
  frame.innerHTML = '<div class="media-fallback">This score file could not be displayed. Check that it is still in Dropbox and is a valid PDF, PNG or JPEG.</div>';
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
  Dropbox.mediaUrl(selected.dropboxPath)
    .then(url => { if (element.isConnected) element.src = url; })
    .catch(error => { showMediaFallback(frame, element); if (error.signedOut) handleError(error); });
  $("#note-editor").classList.add("hidden");
  $("#note-text").value = "";
}

function applyData(data) {
  state.pieces = data.pieces;
  state.history = data.history;
}

async function refreshLibrary() {
  const [{ data }, listing] = await Promise.all([Dropbox.readData(), Dropbox.listLibrary()]);
  applyData(data);
  state.library = buildLibrary(state.pieces, listing);
  state.folders = folderSummaries(listing);
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
  if (!confirm("Disconnect Dropbox on this device? Your files and history stay in Dropbox; you can connect again at any time.")) return;
  await Dropbox.disconnect();
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
    const { data } = await Dropbox.readData(); applyData(data); renderHistory();
  } catch (error) { handleError(error); }
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
    applyData(await Dropbox.mutate(data => { data.history = data.history.filter(event => event.id !== id); }));
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
    applyData(await Dropbox.mutate(data => {
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

// Adds a practice entry for the given passage, re-checking the piece against the latest saved data.
function recordPractice(pieceId, section, note) {
  return Dropbox.mutate(data => {
    const piece = data.pieces.find(item => item.id === pieceId);
    if (!piece) throw new Error("That piece is no longer configured.");
    data.history.unshift({ id: uniqueId(), timestamp: localTimestamp(), pieceId, pieceName: piece.name, sectionPath: section.path, sectionName: section.name, note: note.slice(0, 10000) });
  });
}

async function saveNote() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  if (!selected) return;
  const button = $("#save-note"); button.disabled = true; button.textContent = "Saving…";
  try {
    applyData(await recordPractice(state.selectedSection.pieceId, selected, $("#note-text").value));
    $("#note-editor").classList.add("hidden"); $("#note-text").value = "";
    updateSectionCounter();
    const piece = state.library.find(item => item.id === state.selectedSection.pieceId);
    showToast(roundProgress(piece).done.size === 0
      ? `Practice saved. Round complete — you’ve practised all ${piece.sections.length} sections of ${piece.name}.`
      : "Practice session saved to your history.");
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
    applyData(await recordPractice(current.pieceId, selected, ""));
    const roundComplete = roundProgress(piece).done.size === 0;
    chooseRandomSection(piece);
    showToast(roundComplete
      ? `Round complete — you’ve practised all ${piece.sections.length} sections of ${piece.name}. Starting a new round.`
      : "Passage logged. Here’s another section to practice.");
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
  document.addEventListener("pointerdown", keepScreenAwake);
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
  $("#practice-next").addEventListener("click", () => chooseRandomSection(state.library.find(piece => piece.id === state.selectedPieceId)));
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
  wireEvents();
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
