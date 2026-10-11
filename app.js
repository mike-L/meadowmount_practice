const state = { token: "", pieces: [], library: [], history: [], selectedPieceId: "", selectedSection: null, toastTimer: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uniqueId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (path !== "/api/session" && state.token) headers.set("X-App-Token", state.token);
  const response = await fetch(path, { ...options, method, headers, cache: "no-store" });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function showView(name) {
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `${name}-view`));
  $$(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  if (name === "history") loadHistory();
  if (name === "library") loadLibrary();
}

function sectionFor(pieceId, sectionPath) {
  const piece = state.library.find(item => item.id === pieceId);
  return piece?.sections.find(section => section.path === sectionPath) || null;
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

function chooseRandomSection(piece) {
  if (!piece?.sections?.length) return;
  const section = piece.sections[Math.floor(Math.random() * piece.sections.length)];
  state.selectedPieceId = piece.id;
  state.selectedSection = { pieceId: piece.id, path: section.path };
  renderPractice();
}

function renderPractice() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  const validPieceCount = state.library.filter(piece => !piece.error && piece.sections.length).length;
  $("#score-empty").classList.toggle("hidden", !!selected || validPieceCount > 0);
  $("#score-workspace").classList.toggle("hidden", !selected);
  renderPieces();
  if (!selected) return;
  const piece = state.library.find(item => item.id === state.selectedSection.pieceId);
  $("#selected-piece-name").textContent = piece.name.toLocaleUpperCase();
  $("#section-name").textContent = selected.name;
  $("#section-path").textContent = state.selectedSection.path;
  $("#section-counter").textContent = `${piece.sections.indexOf(selected) + 1} of ${piece.sections.length}`;
  const frame = $("#score-frame");
  frame.replaceChildren();
  if (selected.type === "image") {
    const image = document.createElement("img");
    image.src = selected.mediaUrl; image.alt = `${piece.name} — ${selected.name}`;
    image.addEventListener("error", () => { frame.innerHTML = '<div class="media-fallback">This image could not be displayed. Check that the file still exists and is a valid PNG or JPEG.</div>'; });
    frame.append(image);
  } else {
    const iframe = document.createElement("iframe");
    iframe.src = selected.mediaUrl; iframe.title = `${piece.name} — ${selected.name}`;
    iframe.setAttribute("allow", "fullscreen");
    frame.append(iframe);
  }
  $("#note-editor").classList.add("hidden");
  $("#note-text").value = "";
}

async function refreshLibrary() {
  const [config, library] = await Promise.all([api("/api/config"), api("/api/library")]);
  state.pieces = config.pieces || [];
  state.library = library.pieces || [];
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
    const [config, library] = await Promise.all([api("/api/config"), api("/api/library")]);
    state.pieces = config.pieces || [];
    state.library = library.pieces || [];
    try {
      const location = await api("/api/data-location");
      $("#data-location-current").textContent = location.directory;
      $("#data-location-path").value = location.directory;
    } catch (error) {
      $("#data-location-current").textContent = "Unavailable — restart the app";
      $("#data-location-path").value = "";
      showToast(`Restart the local app to use data-folder settings: ${error.message}`, true);
    }
    renderLibrary();
    renderPractice();
  } catch (error) { showToast(error.message, true); }
}

async function saveDataLocation(event) {
  event.preventDefault();
  const nextDirectory = $("#data-location-path").value.trim();
  const currentDirectory = $("#data-location-current").textContent;
  if (nextDirectory === currentDirectory) { showToast("This is already the active app data folder."); return; }
  const accepted = confirm("Change the app data folder? If the current app-data.json exists, it will be copied to the new folder. The original will remain as a backup. The destination must not already contain app-data.json.");
  if (!accepted) return;
  const button = $("#save-data-location"); button.disabled = true; button.textContent = "Changing…";
  try {
    const result = await api("/api/data-location", { method: "PUT", body: JSON.stringify({ directory: nextDirectory }) });
    $("#data-location-current").textContent = result.directory;
    $("#data-location-path").value = result.directory;
    await refreshLibrary();
    renderLibrary();
    const message = result.copiedExisting
      ? "App data copied to the new folder. The original remains as a backup."
      : result.adoptedExisting
        ? "The app is now using the app-data.json you already moved."
        : "App data folder updated.";
    showToast(message);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; button.textContent = "Change folder"; }
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

function closePieceForm() { $("#piece-form-wrap").classList.add("hidden"); $("#piece-form").reset(); }

async function savePiece(event) {
  event.preventDefault();
  const id = $("#piece-id").value || uniqueId();
  const piece = { id, name: $("#piece-name").value.trim(), path: $("#piece-path").value.trim() };
  const pieces = [...state.pieces];
  const index = pieces.findIndex(item => item.id === id);
  if (index >= 0) pieces[index] = piece; else pieces.push(piece);
  try {
    await api("/api/config", { method: "PUT", body: JSON.stringify({ pieces }) });
    closePieceForm();
    await refreshLibrary();
    renderLibrary();
    showToast(index >= 0 ? "Piece settings updated." : "Piece added to your library.");
  } catch (error) { showToast(error.message, true); }
}

async function removePiece(id) {
  const piece = state.pieces.find(item => item.id === id);
  if (!piece || !confirm(`Remove “${piece.name}” from this app? Your files will not be deleted. Existing history entries will remain.`)) return;
  try {
    await api("/api/config", { method: "PUT", body: JSON.stringify({ pieces: state.pieces.filter(item => item.id !== id) }) });
    if (state.selectedPieceId === id) { state.selectedPieceId = ""; state.selectedSection = null; }
    await refreshLibrary(); renderLibrary();
    showToast("Piece removed. Your score files were not changed.");
  } catch (error) { showToast(error.message, true); }
}

async function loadHistory() {
  try {
    const result = await api("/api/history"); state.history = result.history || []; renderHistory();
  } catch (error) { showToast(error.message, true); }
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
  state.selectedPieceId = event.pieceId;
  state.selectedSection = { pieceId: event.pieceId, path: event.sectionPath };
  showView("practice"); renderPractice();
}

async function deleteHistory(id) {
  if (!confirm("Delete this practice history entry?")) return;
  try { await api(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE" }); await loadHistory(); showToast("History entry deleted."); }
  catch (error) { showToast(error.message, true); }
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
    const existingIds = new Set(state.history.map(item => item.id));
    const pieceNames = new Map(state.pieces.map(piece => [piece.id, piece.name]));
    const cleaned = entries.filter(item => item && typeof item === "object" && typeof item.sectionPath === "string" && typeof item.note === "string")
      .map(item => ({ id: existingIds.has(item.id) ? uniqueId() : (item.id || uniqueId()), timestamp: item.timestamp || new Date().toISOString(), pieceId: item.pieceId || "", pieceName: pieceNames.get(item.pieceId) || item.pieceName || "Imported piece", sectionPath: item.sectionPath, sectionName: item.sectionName || item.sectionPath.split("/").pop(), note: item.note.slice(0, 10000) }));
    if (!cleaned.length) throw new Error("No valid history entries were found.");
    const merged = [...cleaned, ...state.history].slice(0, 5000);
    await api("/api/history/import", { method: "POST", body: JSON.stringify({ history: merged }) });
    await loadHistory(); showToast(`${cleaned.length} history entr${cleaned.length === 1 ? "y" : "ies"} imported.`);
  } catch (error) { showToast(error.message, true); }
}

function openNoteEditor() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  if (!selected) return;
  $("#note-context").textContent = `${state.library.find(piece => piece.id === state.selectedSection.pieceId)?.name || "Piece"} · ${selected.name}`;
  $("#note-editor").classList.remove("hidden");
  $("#note-text").focus();
  $("#note-editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function saveNote() {
  const selected = state.selectedSection && sectionFor(state.selectedSection.pieceId, state.selectedSection.path);
  if (!selected) return;
  const button = $("#save-note"); button.disabled = true; button.textContent = "Saving…";
  try {
    await api("/api/history", { method: "POST", body: JSON.stringify({ pieceId: state.selectedSection.pieceId, sectionPath: selected.path, note: $("#note-text").value }) });
    $("#note-editor").classList.add("hidden"); $("#note-text").value = ""; showToast("Practice session saved to your history.");
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; button.textContent = "Save practice note"; }
}

function wireEvents() {
  $$(".nav-button").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $("#go-library").addEventListener("click", () => showView("library"));
  $("#add-piece-shortcut").addEventListener("click", () => { showView("library"); openPieceForm(); });
  $("#empty-add-piece").addEventListener("click", () => { showView("library"); openPieceForm(); });
  $("#new-piece").addEventListener("click", () => openPieceForm());
  $("#cancel-piece").addEventListener("click", closePieceForm);
  $("#cancel-piece-secondary").addEventListener("click", closePieceForm);
  $("#piece-form").addEventListener("submit", savePiece);
  $("#data-location-form").addEventListener("submit", saveDataLocation);
  $("#practice-next").addEventListener("click", () => chooseRandomSection(state.library.find(piece => piece.id === state.selectedPieceId)));
  $("#open-note").addEventListener("click", openNoteEditor);
  $("#close-note").addEventListener("click", () => $("#note-editor").classList.add("hidden"));
  $("#save-note").addEventListener("click", saveNote);
  $("#history-search").addEventListener("input", renderHistory);
  $("#export-history").addEventListener("click", exportHistory);
  $("#import-history").addEventListener("change", importHistory);
}

async function start() {
  wireEvents();
  try {
    const session = await api("/api/session"); state.token = session.token;
    await refreshLibrary();
    await loadHistory();
    if (state.selectedPieceId && !state.selectedSection) chooseRandomSection(state.library.find(piece => piece.id === state.selectedPieceId));
  } catch (error) {
    showToast(`Could not connect to the local app: ${error.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", start);
