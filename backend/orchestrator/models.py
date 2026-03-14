"""Data models for tasks, artifacts, and pipelines."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Union

import storage


# --- Artifacts ---

# Delimiter format used to separate runs within a single artifact file.
# Format: \n\n---\n<!-- run:{N} agent:{agent_name} timestamp:{ISO_8601} -->\n---\n\n
_DELIMITER_RE = re.compile(
    r"\n\n---\n<!-- run:(\d+) agent:([^\s]+) timestamp:([^\s]+) -->\n---\n\n"
)


def _build_delimiter(run: int, agent: str, timestamp: str) -> str:
    """Build the run separator delimiter string."""
    return f"\n\n---\n<!-- run:{run} agent:{agent} timestamp:{timestamp} -->\n---\n\n"


def split_runs(content: str) -> List[dict]:
    """Parse run delimiters in content and return list of run dicts.

    Each dict has keys: run (int), agent (str), timestamp (str), content (str).
    If no delimiters are found, returns a single run with all content (run=1).
    Backward-compatible: existing artifacts without delimiters are treated as run 1.
    """
    parts = _DELIMITER_RE.split(content)
    # No delimiters found — backward-compat: single run with all content
    if len(parts) == 1:
        return [{"run": 1, "agent": "unknown", "timestamp": "", "content": parts[0]}]

    runs = []
    # First segment is the content of run 1 (before any delimiter)
    runs.append({"run": 1, "agent": "unknown", "timestamp": "", "content": parts[0]})

    # Remaining parts come in groups of 4: (run_num, agent, timestamp, content)
    idx = 1
    while idx + 3 < len(parts):
        runs.append({
            "run": int(parts[idx]),
            "agent": parts[idx + 1],
            "timestamp": parts[idx + 2],
            "content": parts[idx + 3],
        })
        idx += 4

    return runs


def get_artifact_content(
    project_id: str,
    task_id: str,
    artifact_type: str,
    run: Optional[Union[int, str]] = None,
) -> Optional[str]:
    """Get artifact content, optionally filtered to a specific run.

    run=None: returns full raw content (all runs)
    run='latest' or run=-1: returns only last run's content
    run=N (int >= 1): returns only that run's content slice
    """
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    content_path = artifacts_dir / f"{artifact_type}.md"
    if not content_path.exists():
        return None

    raw = storage.read_text_file(content_path)

    if run is None:
        return raw

    runs = split_runs(raw)

    if run == "latest" or run == -1:
        return runs[-1]["content"] if runs else raw

    if isinstance(run, int) and run >= 1:
        for r in runs:
            if r["run"] == run:
                return r["content"]
        return None

    return raw


def create_artifact(
    project_id: str,
    task_id: str,
    artifact_type: str,
    content: str,
    agent: str,
) -> dict:
    """Create or append to an artifact.

    If the artifact already exists, the new content is appended with a run
    delimiter rather than overwriting.  If it does not exist, the content is
    written as-is with run_count=1.
    """
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    content_path = artifacts_dir / f"{artifact_type}.md"
    meta_path = artifacts_dir / f"{artifact_type}.json"

    # Load existing metadata to preserve the original id, or generate new
    existing_meta = storage.read_json(meta_path)
    artifact_id = existing_meta["id"] if existing_meta else storage.generate_id()

    now = storage.now_iso()

    if content_path.exists() and existing_meta:
        # Artifact already exists — append with delimiter
        existing_run_count = existing_meta.get("run_count", 1)
        new_run = existing_run_count + 1
        existing_content = storage.read_text_file(content_path)
        delimiter = _build_delimiter(new_run, agent, now)
        combined_content = existing_content + delimiter + content
        storage.write_text_file(content_path, combined_content)
        final_content = combined_content
    else:
        # New artifact — write as-is
        new_run = 1
        storage.write_text_file(content_path, content)
        final_content = content

    artifact = {
        "id": artifact_id,
        "type": artifact_type,
        "agent": agent,
        "run_count": new_run,
        "updated_at": now,
    }
    if existing_meta and existing_meta.get("created_at"):
        artifact["created_at"] = existing_meta["created_at"]
        # Preserve first_agent so the /runs endpoint can back-fill Run 1 metadata
        artifact["first_agent"] = existing_meta.get("first_agent", existing_meta.get("agent", agent))
    else:
        artifact["created_at"] = now
        artifact["first_agent"] = agent  # this IS the first agent

    storage.write_json(meta_path, artifact)

    artifact["content"] = final_content
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
    """Update an artifact's content (for human-in-the-loop editing).

    Treated as a new run appended with agent:human delimiter so prior work is preserved.
    """
    artifacts_dir = storage.project_tasks_dir(project_id) / task_id / "artifacts"
    content_path = artifacts_dir / f"{artifact_type}.md"

    if not content_path.exists():
        return None

    meta_path = artifacts_dir / f"{artifact_type}.json"
    meta = storage.read_json(meta_path) or {}
    now = storage.now_iso()

    existing_run_count = meta.get("run_count", 1)
    new_run = existing_run_count + 1
    existing_content = storage.read_text_file(content_path)
    delimiter = _build_delimiter(new_run, "human", now)
    combined_content = existing_content + delimiter + content
    storage.write_text_file(content_path, combined_content)

    meta["run_count"] = new_run
    meta["updated_at"] = now
    meta["agent"] = "human"
    storage.write_json(meta_path, meta)
    meta["content"] = combined_content
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
    project_id: str, task_id: str, agent: str, role: str, content: str,
    run: Optional[int] = None,
) -> None:
    """Append a single message to an agent's terminal log.

    The optional `run` field tags the message with which run it belongs to,
    allowing the UI to filter messages by run.
    """
    terminals = load_terminals(project_id, task_id)
    if agent not in terminals:
        terminals[agent] = []
    msg: dict = {"role": role, "content": content}
    if run is not None:
        msg["run"] = run
    terminals[agent].append(msg)
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
