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
    """Create or update an artifact. Each type has a single file that gets overwritten."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    content_path = artifacts_dir / f"{artifact_type}.md"
    meta_path = artifacts_dir / f"{artifact_type}.json"

    # Load existing metadata to preserve the original id, or generate new
    existing_meta = storage.read_json(meta_path)
    artifact_id = existing_meta["id"] if existing_meta else storage.generate_id()

    artifact = {
        "id": artifact_id,
        "type": artifact_type,
        "agent": agent,
        "updated_at": storage.now_iso(),
    }
    if existing_meta and existing_meta.get("created_at"):
        artifact["created_at"] = existing_meta["created_at"]
    else:
        artifact["created_at"] = artifact["updated_at"]

    # Overwrite content and metadata
    storage.write_text_file(content_path, content)
    storage.write_json(meta_path, artifact)

    artifact["content"] = content
    return artifact


def get_artifact(project_id: str, task_id: str, artifact_type: str) -> Optional[dict]:
    """Get an artifact by type."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    content_path = artifacts_dir / f"{artifact_type}.md"

    if not content_path.exists():
        return None

    meta_path = artifacts_dir / f"{artifact_type}.json"
    meta = storage.read_json(meta_path) or {}

    content = storage.read_text_file(content_path)
    return {**meta, "content": content}


def list_artifacts(project_id: str, task_id: str) -> List[dict]:
    """List all artifacts for a task (one per type)."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    if not artifacts_dir.exists():
        return []

    artifacts = []
    for meta_file in sorted(artifacts_dir.glob("*.json")):
        meta = storage.read_json(meta_file)
        if meta:
            content_file = meta_file.with_suffix(".md")
            if content_file.exists():
                meta["content"] = storage.read_text_file(content_file)
            artifacts.append(meta)

    return artifacts


def update_artifact_content(project_id: str, task_id: str, artifact_type: str, content: str) -> Optional[dict]:
    """Update an artifact's content (for human-in-the-loop editing)."""
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    content_path = artifacts_dir / f"{artifact_type}.md"

    if not content_path.exists():
        return None

    storage.write_text_file(content_path, content)

    meta_path = artifacts_dir / f"{artifact_type}.json"
    meta = storage.read_json(meta_path) or {}
    meta["updated_at"] = storage.now_iso()
    storage.write_json(meta_path, meta)
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


def clear_agent_terminal(project_id: str, task_id: str, agent: str) -> None:
    """Clear all terminal messages for a specific agent."""
    terminals = load_terminals(project_id, task_id)
    terminals[agent] = []
    save_terminals(project_id, task_id, terminals)


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
