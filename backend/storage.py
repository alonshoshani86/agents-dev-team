"""File-based JSON storage layer. All file I/O goes through this module."""

from __future__ import annotations

import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, List

DATA_DIR = Path(__file__).parent / "data"


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def generate_id() -> str:
    return uuid.uuid4().hex[:12]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- JSON file operations ---


def read_json(path: Path) -> Any:
    """Read and parse a JSON file. Returns None if file doesn't exist."""
    if not path.exists():
        return None
    with open(path, "r") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    """Write data to a JSON file, creating parent dirs if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def delete_path(path: Path) -> bool:
    """Delete a file or directory. Returns True if something was deleted."""
    if path.is_dir():
        shutil.rmtree(path)
        return True
    elif path.is_file():
        path.unlink()
        return True
    return False


# --- Directory operations ---


def list_dirs(path: Path) -> List[str]:
    """List subdirectory names in a directory."""
    if not path.exists():
        return []
    return sorted([d.name for d in path.iterdir() if d.is_dir()])


def list_files_recursive(path: Path, base: Optional[Path] = None) -> List[dict]:
    """Return a tree structure of files and directories."""
    if not path.exists():
        return []
    if base is None:
        base = path

    result = []
    for item in sorted(path.iterdir()):
        rel = item.relative_to(base)
        if item.is_dir():
            result.append({
                "name": item.name,
                "path": str(rel),
                "type": "directory",
                "children": list_files_recursive(item, base),
            })
        else:
            result.append({
                "name": item.name,
                "path": str(rel),
                "type": "file",
                "size": item.stat().st_size,
            })
    return result


def read_text_file(path: Path) -> Optional[str]:
    """Read a text file. Returns None if it doesn't exist."""
    if not path.exists():
        return None
    return path.read_text()


def write_text_file(path: Path, content: str) -> None:
    """Write content to a text file, creating parent dirs if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


# --- Project-specific helpers ---


def projects_dir() -> Path:
    _ensure_data_dir()
    return DATA_DIR / "projects"


def project_dir(project_id: str) -> Path:
    return projects_dir() / project_id


def project_json_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def project_context_path(project_id: str) -> Path:
    return project_dir(project_id) / "context.json"


def project_tasks_dir(project_id: str) -> Path:
    return project_dir(project_id) / "tasks"


def project_agents_dir(project_id: str) -> Path:
    return project_dir(project_id) / "agents"


def project_pipelines_dir(project_id: str) -> Path:
    return project_dir(project_id) / "pipelines"


def project_files_dir(project_id: str) -> Path:
    """Return the primary files directory (first path, or internal fallback)."""
    project_data = read_json(project_json_path(project_id))
    if project_data:
        paths = project_data.get("paths", [])
        if paths and paths[0].get("path"):
            p = Path(paths[0]["path"])
            if p.is_dir():
                return p
    return project_dir(project_id) / "files"


def project_all_paths(project_id: str) -> List[dict]:
    """Return all configured paths for a project: [{label, path}]."""
    project_data = read_json(project_json_path(project_id))
    if not project_data:
        return []
    paths = project_data.get("paths", [])
    return [p for p in paths if p.get("path") and Path(p["path"]).is_dir()]


def config_path() -> Path:
    _ensure_data_dir()
    return DATA_DIR / "config.json"


def init_project_dirs(project_id: str) -> None:
    """Create all subdirectories for a new project."""
    for dir_fn in [
        project_tasks_dir,
        project_agents_dir,
        project_pipelines_dir,
        project_files_dir,
    ]:
        dir_fn(project_id).mkdir(parents=True, exist_ok=True)
