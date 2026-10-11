#!/usr/bin/env python3
"""Local-only Meadowmount Practice App server (Python standard library)."""
from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

APP_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = APP_DIR / "app-settings.json"
DATA_DIR = APP_DIR
DATA_FILE = DATA_DIR / "app-data.json"
STATIC_FILES = {
    "/": (APP_DIR / "index.html", "text/html; charset=utf-8"),
    "/app.js": (APP_DIR / "app.js", "text/javascript; charset=utf-8"),
    "/styles.css": (APP_DIR / "styles.css", "text/css; charset=utf-8"),
    "/data-settings.css": (APP_DIR / "data-settings.css", "text/css; charset=utf-8"),
}
ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
MAX_PIECES = 500
MAX_HISTORY = 5000
MAX_NOTE_LENGTH = 10000
MAX_SCANNED_DIRECTORIES = 10000
MAX_SCANNED_FILES = 100000
MAX_SECTIONS_PER_PIECE = 5000
DATA_LOCK = threading.RLock()
SCAN_LOCK = threading.Lock()
MEDIA_INDEX: dict[str, tuple[Path, Path]] = {}
CSRF_TOKEN = secrets.token_urlsafe(32)


def read_data() -> dict:
    with DATA_LOCK:
        if not DATA_FILE.exists():
            return {"pieces": [], "history": []}
        try:
            data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("The data file must contain a JSON object.")
            data.setdefault("pieces", [])
            data.setdefault("history", [])
            if not isinstance(data["pieces"], list) or not isinstance(data["history"], list):
                raise ValueError("The data file has an invalid structure.")
            return data
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            raise RuntimeError(f"Could not read {DATA_FILE.name}: {exc}") from exc


def write_data(data: dict) -> None:
    with DATA_LOCK:
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=DATA_DIR, prefix=".app-data-", suffix=".tmp", delete=False
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            try:
                temporary_path.chmod(0o600)
            except OSError:
                pass
            os.replace(temporary_path, DATA_FILE)
            try:
                DATA_FILE.chmod(0o600)
            except OSError:
                pass
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)


def save_data_directory(folder: Path) -> None:
    """Persist the data location outside the movable data file itself."""
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=APP_DIR, prefix=".app-settings-", suffix=".tmp", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(json.dumps({"dataDirectory": str(folder)}, indent=2) + "\n")
        try:
            temporary_path.chmod(0o600)
        except OSError:
            pass
        os.replace(temporary_path, SETTINGS_FILE)
        try:
            SETTINGS_FILE.chmod(0o600)
        except OSError:
            pass
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def load_data_directory() -> None:
    global DATA_DIR, DATA_FILE
    if not SETTINGS_FILE.exists():
        DATA_DIR = APP_DIR
        DATA_FILE = DATA_DIR / "app-data.json"
        return
    try:
        settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        folder = Path(settings["dataDirectory"]).expanduser().resolve(strict=True)
        if not folder.is_dir():
            raise ValueError("Configured app data location is not a folder.")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not load the configured app data folder: {exc}") from exc
    DATA_DIR = folder
    DATA_FILE = DATA_DIR / "app-data.json"


def configure_data_directory(raw_path: str) -> tuple[Path, bool, bool]:
    """Switch folders, copying current data or adopting an existing moved data file."""
    global DATA_DIR, DATA_FILE
    if not raw_path:
        raise ValueError("Enter an existing folder path for app data.")
    folder = Path(raw_path).expanduser().resolve(strict=True)
    if not folder.is_dir():
        raise ValueError("The app data location must be an existing folder.")
    with DATA_LOCK:
        if folder == DATA_DIR:
            return folder, False, False
        destination = folder / "app-data.json"
        source_exists = DATA_FILE.exists()
        adopted_existing = destination.exists()
        if destination.exists() and source_exists:
            raise ValueError("Both folders contain app-data.json. Keep one copy only, or choose another empty folder.")
        if destination.exists():
            try:
                moved_data = json.loads(destination.read_text(encoding="utf-8"))
                if not isinstance(moved_data, dict) or not isinstance(moved_data.get("pieces", []), list) or not isinstance(moved_data.get("history", []), list):
                    raise ValueError("The existing app-data.json has an invalid structure.")
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError(f"Could not use the existing app-data.json: {exc}") from exc
            except ValueError as exc:
                raise ValueError(f"Could not use the existing app-data.json: {exc}") from exc
        elif source_exists:
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(dir=folder, prefix=".app-data-", suffix=".tmp", delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    temporary.write(DATA_FILE.read_bytes())
                try:
                    temporary_path.chmod(0o600)
                except OSError:
                    pass
                os.replace(temporary_path, destination)
                try:
                    destination.chmod(0o600)
                except OSError:
                    pass
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)
        save_data_directory(folder)
        DATA_DIR = folder
        DATA_FILE = destination
        return folder, source_exists, adopted_existing


def valid_piece_folder(raw_path: str) -> Path:
    folder = Path(raw_path).expanduser().resolve(strict=True)
    if not folder.is_dir():
        raise ValueError("Each piece path must point to an existing folder.")
    return folder


def build_library() -> list[dict]:
    """Index only supported files directly or recursively beneath configured roots."""
    global MEDIA_INDEX
    data = read_data()
    next_index: dict[str, tuple[Path, Path]] = {}
    result = []
    for piece in data["pieces"]:
        piece_id = str(piece.get("id", ""))
        name = str(piece.get("name", "Untitled piece"))
        raw_path = str(piece.get("path", ""))
        entry = {"id": piece_id, "name": name, "sections": [], "error": None}
        try:
            root = valid_piece_folder(raw_path)
            candidates = []
            scanned_directories = 0
            scanned_files = 0
            for current, dirs, files in os.walk(root, followlinks=False):
                scanned_directories += 1
                scanned_files += len(files)
                if scanned_directories > MAX_SCANNED_DIRECTORIES or scanned_files > MAX_SCANNED_FILES:
                    raise ValueError("Folder contains too many directories or files to scan safely.")
                dirs[:] = sorted(
                    d for d in dirs
                    if not d.startswith(".")
                    and not (Path(current) / d).is_symlink()
                    and not (hasattr(Path(current) / d, "is_junction") and (Path(current) / d).is_junction())
                )
                current_path = Path(current)
                for filename in files:
                    if filename.startswith(".") or Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
                        continue
                    candidate = current_path / filename
                    if candidate.is_symlink():
                        continue
                    try:
                        resolved = candidate.resolve(strict=True)
                        resolved.relative_to(root)
                        if resolved.is_file():
                            candidates.append((candidate, resolved))
                    except (OSError, ValueError):
                        continue
                    if len(candidates) > MAX_SECTIONS_PER_PIECE:
                        raise ValueError(f"A piece folder may contain no more than {MAX_SECTIONS_PER_PIECE} supported files.")
            for candidate, resolved in sorted(candidates, key=lambda pair: str(pair[0]).casefold()):
                media_id = secrets.token_urlsafe(18)
                relative = candidate.relative_to(root).as_posix()
                next_index[media_id] = (resolved, root)
                extension = resolved.suffix.lower()
                mime = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}[extension]
                entry["sections"].append({
                    "path": relative,
                    "name": candidate.name,
                    "type": "pdf" if extension == ".pdf" else "image",
                    "mediaUrl": f"/media/{media_id}",
                    "mime": mime,
                })
        except (OSError, ValueError) as exc:
            entry["error"] = f"Folder unavailable: {exc}"
        result.append(entry)
    MEDIA_INDEX = next_index
    return result


class PracticeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    max_workers = threading.BoundedSemaphore(16)

    def process_request(self, request, client_address):
        if not self.max_workers.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.max_workers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.max_workers.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "MeadowmountPractice/1.0"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt: str, *args) -> None:
        # Avoid logging folder paths, notes, or media filenames.
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def _send_bytes(self, status: int, payload: bytes, content_type: str = "application/json; charset=utf-8", headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _json(self, status: int, value) -> None:
        self._send_bytes(status, json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def _check_host(self) -> bool:
        expected = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host", "").lower() != expected:
            self._json(403, {"error": "Requests must use the local app address."})
            return False
        return True

    def _check_write_origin(self) -> bool:
        origin = self.headers.get("Origin")
        expected = f"http://127.0.0.1:{self.server.server_port}"
        if origin != expected or self.headers.get("X-App-Token") != CSRF_TOKEN:
            self._json(403, {"error": "Request rejected. Reload the app and try again."})
            return False
        fetch_site = self.headers.get("Sec-Fetch-Site")
        if fetch_site and fetch_site not in ("same-origin", "none"):
            self._json(403, {"error": "Cross-site requests are not allowed."})
            return False
        return True

    def _check_api_read(self, path: str) -> bool:
        if path == "/api/session":
            return True
        origin = self.headers.get("Origin")
        expected = f"http://127.0.0.1:{self.server.server_port}"
        fetch_site = self.headers.get("Sec-Fetch-Site")
        if (origin and origin != expected) or fetch_site not in (None, "same-origin", "none"):
            self._json(403, {"error": "Cross-site requests are not allowed."})
            return False
        if self.headers.get("X-App-Token") != CSRF_TOKEN:
            self._json(403, {"error": "Request rejected. Reload the app and try again."})
            return False
        return True

    def _read_json(self, limit: int = 1_000_000):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid request length.")
        if length < 1 or length > limit:
            raise ValueError("Request body is empty or too large.")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Request body must be valid JSON.") from exc

    def do_GET(self) -> None:
        if not self._check_host():
            return
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/") and not self._check_api_read(path):
            return
        if path in STATIC_FILES:
            target, mime = STATIC_FILES[path]
            try:
                body = target.read_bytes()
            except OSError:
                self._json(500, {"error": "App file could not be read."})
                return
            self._send_bytes(200, body, mime, {"Cache-Control": "no-cache"})
        elif path == "/api/session":
            self._json(200, {"token": CSRF_TOKEN})
        elif path == "/api/config":
            self._json(200, {"pieces": read_data()["pieces"]})
        elif path == "/api/data-location":
            self._json(200, {"directory": str(DATA_DIR)})
        elif path == "/api/library":
            try:
                with SCAN_LOCK:
                    self._json(200, {"pieces": build_library()})
            except RuntimeError as exc:
                self._json(500, {"error": str(exc)})
        elif path == "/api/history":
            self._json(200, {"history": read_data()["history"]})
        elif path.startswith("/media/"):
            self._serve_media(path[len("/media/"):])
        else:
            self._json(404, {"error": "Not found."})

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_PUT(self) -> None:
        if not self._check_host() or not self._check_write_origin():
            return
        request_path = urlsplit(self.path).path
        if request_path == "/api/data-location":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Provide a folder path for app data.")
                folder, copied_existing, adopted_existing = configure_data_directory(str(payload.get("directory", "")).strip())
                self._json(200, {"directory": str(folder), "copiedExisting": copied_existing, "adoptedExisting": adopted_existing})
            except (ValueError, OSError, RuntimeError) as exc:
                self._json(400, {"error": str(exc)})
            return
        if request_path != "/api/config":
            self._json(404, {"error": "Not found."})
            return
        try:
            payload = self._read_json()
            pieces = payload.get("pieces") if isinstance(payload, dict) else None
            if not isinstance(pieces, list) or len(pieces) > MAX_PIECES:
                raise ValueError(f"Provide no more than {MAX_PIECES} piece entries.")
            clean = []
            seen_ids = set()
            for piece in pieces:
                if not isinstance(piece, dict):
                    raise ValueError("Each piece must have a name and folder path.")
                piece_id = str(piece.get("id") or secrets.token_urlsafe(12))[:80]
                name = str(piece.get("name", "")).strip()
                path = str(piece.get("path", "")).strip()
                if not name or len(name) > 120:
                    raise ValueError("Piece names must be 1–120 characters.")
                if not path or len(path) > 4096:
                    raise ValueError("Enter a valid folder path (up to 4096 characters).")
                if piece_id in seen_ids:
                    raise ValueError("Piece IDs must be unique.")
                folder = valid_piece_folder(path)
                seen_ids.add(piece_id)
                clean.append({"id": piece_id, "name": name, "path": str(folder)})
            with DATA_LOCK:
                data = read_data()
                data["pieces"] = clean
                write_data(data)
            self._json(200, {"pieces": clean})
        except (ValueError, OSError, RuntimeError) as exc:
            self._json(400, {"error": str(exc)})

    def do_POST(self) -> None:
        if not self._check_host() or not self._check_write_origin():
            return
        request_path = urlsplit(self.path).path
        if request_path == "/api/history/import":
            self._import_history()
            return
        if request_path != "/api/history":
            self._json(404, {"error": "Not found."})
            return
        try:
            payload = self._read_json(100_000)
            if not isinstance(payload, dict):
                raise ValueError("Invalid history entry.")
            piece_id = str(payload.get("pieceId", ""))
            section_path = str(payload.get("sectionPath", ""))
            note = str(payload.get("note", ""))
            if len(note) > MAX_NOTE_LENGTH:
                raise ValueError(f"Notes must be {MAX_NOTE_LENGTH} characters or fewer.")
            data = read_data()
            piece = next((item for item in data["pieces"] if item["id"] == piece_id), None)
            if piece is None:
                raise ValueError("That piece is no longer configured.")
            root = valid_piece_folder(piece["path"])
            target = (root / section_path).resolve(strict=True)
            target.relative_to(root)
            if target.suffix.lower() not in ALLOWED_EXTENSIONS or not target.is_file():
                raise ValueError("That score section is no longer available.")
            event = {
                "id": secrets.token_urlsafe(12),
                "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
                "pieceId": piece_id,
                "pieceName": piece["name"],
                "sectionPath": section_path,
                "sectionName": target.name,
                "note": note,
            }
            with DATA_LOCK:
                current = read_data()
                current["history"].insert(0, event)
                current["history"] = current["history"][:MAX_HISTORY]
                write_data(current)
            self._json(201, {"entry": event})
        except (ValueError, OSError, RuntimeError) as exc:
            self._json(400, {"error": str(exc)})

    def _import_history(self) -> None:
        try:
            payload = self._read_json(10_000_000)
            entries = payload.get("history") if isinstance(payload, dict) else None
            if not isinstance(entries, list):
                raise ValueError("History import must contain a list of entries.")
            if len(entries) > MAX_HISTORY:
                raise ValueError(f"History can contain no more than {MAX_HISTORY} entries.")
            cleaned = []
            seen_ids = set()
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                section_path = str(entry.get("sectionPath", ""))[:4096]
                note = str(entry.get("note", ""))[:MAX_NOTE_LENGTH]
                if not section_path:
                    continue
                entry_id = str(entry.get("id") or secrets.token_urlsafe(12))[:80]
                if entry_id in seen_ids:
                    entry_id = secrets.token_urlsafe(12)
                seen_ids.add(entry_id)
                cleaned.append({
                    "id": entry_id,
                    "timestamp": str(entry.get("timestamp") or "")[:100],
                    "pieceId": str(entry.get("pieceId") or "")[:80],
                    "pieceName": str(entry.get("pieceName") or "Imported piece")[:120],
                    "sectionPath": section_path,
                    "sectionName": str(entry.get("sectionName") or Path(section_path).name)[:255],
                    "note": note,
                })
            with DATA_LOCK:
                data = read_data()
                data["history"] = cleaned
                write_data(data)
            self._json(200, {"count": len(cleaned)})
        except (ValueError, OSError, RuntimeError) as exc:
            self._json(400, {"error": str(exc)})

    def do_DELETE(self) -> None:
        if not self._check_host() or not self._check_write_origin():
            return
        entry_id = urlsplit(self.path).path.removeprefix("/api/history/")
        if not entry_id or "/" in entry_id:
            self._json(404, {"error": "Not found."})
            return
        with DATA_LOCK:
            data = read_data()
            old_len = len(data["history"])
            data["history"] = [event for event in data["history"] if event.get("id") != entry_id]
            if len(data["history"]) == old_len:
                self._json(404, {"error": "History entry not found."})
                return
            write_data(data)
        self._json(200, {"ok": True})

    def _serve_media(self, media_id: str) -> None:
        record = MEDIA_INDEX.get(media_id)
        if not record:
            self._json(404, {"error": "Score file not found. Reload the library and try again."})
            return
        path, root = record
        try:
            path = path.resolve(strict=True)
            path.relative_to(root)
            if not path.is_file() or path.suffix.lower() not in ALLOWED_EXTENSIONS:
                raise ValueError("Unsupported file.")
            size = path.stat().st_size
            start, end = 0, size - 1
            status = 200
            range_header = self.headers.get("Range")
            if range_header:
                if not range_header.startswith("bytes=") or "," in range_header:
                    self._send_bytes(416, b"", headers={"Content-Range": f"bytes */{size}"})
                    return
                bounds = range_header[6:].split("-", 1)
                try:
                    if bounds[0]:
                        start = int(bounds[0])
                        end = min(int(bounds[1]), size - 1) if bounds[1] else size - 1
                    else:
                        suffix_length = int(bounds[1])
                        start = max(0, size - suffix_length)
                    if start < 0 or start >= size or end < start:
                        raise ValueError
                except (ValueError, IndexError):
                    self._send_bytes(416, b"", headers={"Content-Range": f"bytes */{size}"})
                    return
                status = 206
            content_length = max(0, end - start + 1)
            mime = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}[path.suffix.lower()]
            headers = {
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
                "Content-Disposition": f"inline; filename*=UTF-8''{quote(path.name)}",
                "Cache-Control": "no-store",
            }
            if status == 206:
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'")
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                with path.open("rb") as media:
                    media.seek(start)
                    remaining = content_length
                    while remaining:
                        chunk = media.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except (OSError, ValueError):
            self._json(404, {"error": "Score file is no longer available."})


def main() -> None:
    try:
        load_data_directory()
    except RuntimeError as exc:
        raise SystemExit(f"{exc}\nCorrect app-settings.json or restore the configured data folder, then relaunch.") from exc
    try:
        server = PracticeServer(("127.0.0.1", 8765), Handler)
    except OSError as exc:
        raise SystemExit(f"Could not start Meadowmount Practice App on port 8765: {exc}. Close another app instance and try again.") from exc
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Meadowmount Practice App is running at {url}")
    print("Keep this window open while practicing. Press Ctrl+C to stop.")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nMeadowmount Practice App stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
