"""Data models for tasks, artifacts, and pipelines."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import storage


# --- Artifacts ---


def create_artifact(
    project_id: str,
    task_id: str,
    artifact_type: str,
    content: str,
    agent: str,
) -> dict:
    """Create and save a new artifact."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    # Determine version (increment from existing)
    existing = list(artifacts_dir.glob(f"{artifact_type}-v*.md"))
    version = len(existing) + 1

    artifact = {
        "id": storage.generate_id(),
        "type": artifact_type,
        "version": version,
        "agent": agent,
        "created_at": storage.now_iso(),
    }

    # Save content as markdown file
    content_path = artifacts_dir / f"{artifact_type}-v{version}.md"
    storage.write_text_file(content_path, content)

    # Save metadata
    meta_path = artifacts_dir / f"{artifact_type}-v{version}.json"
    storage.write_json(meta_path, artifact)

    artifact["content"] = content
    return artifact


def get_artifact(project_id: str, task_id: str, artifact_type: str, version: Optional[int] = None) -> Optional[dict]:
    """Get an artifact. If no version specified, get latest."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"

    if version is None:
        # Find latest version
        existing = sorted(artifacts_dir.glob(f"{artifact_type}-v*.md"))
        if not existing:
            return None
        content_path = existing[-1]
        version = len(existing)
    else:
        content_path = artifacts_dir / f"{artifact_type}-v{version}.md"

    if not content_path.exists():
        return None

    meta_path = artifacts_dir / f"{artifact_type}-v{version}.json"
    meta = storage.read_json(meta_path) or {}

    content = storage.read_text_file(content_path)
    return {**meta, "content": content}


def list_artifacts(project_id: str, task_id: str) -> List[dict]:
    """List all artifacts for a task."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    if not artifacts_dir.exists():
        return []

    artifacts = []
    for meta_file in sorted(artifacts_dir.glob("*.json")):
        meta = storage.read_json(meta_file)
        if meta:
            # Read content
            content_file = meta_file.with_suffix(".md")
            if content_file.exists():
                meta["content"] = storage.read_text_file(content_file)
            artifacts.append(meta)

    return artifacts


def update_artifact_content(project_id: str, task_id: str, artifact_type: str, version: int, content: str) -> Optional[dict]:
    """Update an artifact's content (for human-in-the-loop editing)."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    content_path = artifacts_dir / f"{artifact_type}-v{version}.md"

    if not content_path.exists():
        return None

    storage.write_text_file(content_path, content)

    meta_path = artifacts_dir / f"{artifact_type}-v{version}.json"
    meta = storage.read_json(meta_path) or {}
    meta["content"] = content
    return meta


# --- Task History ---


def append_history(project_id: str, task_id: str, entry: dict) -> None:
    """Append an entry to task history."""
    task_dir = storage.project_tasks_dir(project_id) / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    history_path = task_dir / "history.json"

    history = storage.read_json(history_path) or []
    entry["timestamp"] = storage.now_iso()
    history.append(entry)
    storage.write_json(history_path, history)


def get_history(project_id: str, task_id: str) -> List[dict]:
    """Get full task history."""
    history_path = storage.project_tasks_dir(project_id) / task_id / "history.json"
    return storage.read_json(history_path) or []


# --- Terminal Log ---


def _terminals_path(project_id: str, task_id: str):
    return storage.project_tasks_dir(project_id) / task_id / "terminals.json"


def save_terminals(project_id: str, task_id: str, terminals: Dict[str, List[dict]]) -> None:
    """Save terminal messages to disk."""
    storage.write_json(_terminals_path(project_id, task_id), terminals)


def load_terminals(project_id: str, task_id: str) -> Dict[str, List[dict]]:
    """Load terminal messages from disk."""
    return storage.read_json(_terminals_path(project_id, task_id)) or {}


def append_terminal_message(
    project_id: str, task_id: str, agent: str, role: str, content: str
) -> None:
    """Append a single message to an agent's terminal log."""
    terminals = load_terminals(project_id, task_id)
    if agent not in terminals:
        terminals[agent] = []
    terminals[agent].append({"role": role, "content": content})
    save_terminals(project_id, task_id, terminals)


def update_last_terminal_message(
    project_id: str, task_id: str, agent: str, content: str
) -> None:
    """Update the last assistant message for an agent (used after streaming completes)."""
    terminals = load_terminals(project_id, task_id)
    if agent not in terminals:
        terminals[agent] = []
    msgs = terminals[agent]
    if msgs and msgs[-1]["role"] == "assistant":
        msgs[-1]["content"] = content
    else:
        msgs.append({"role": "assistant", "content": content})
    save_terminals(project_id, task_id, terminals)
