"""Agent registry: loads agent configs and creates runners."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, List, Optional

import storage
from agents.base import AgentRunner

# File extensions to include when scanning project dirs
_CODE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt",
    ".yaml", ".yml", ".toml", ".cfg", ".ini", ".env.example",
    ".html", ".css", ".sql", ".sh", ".dockerfile",
}

_IGNORE_DIRS = {
    "node_modules", ".git", ".venv", "venv", "__pycache__", ".next",
    "dist", "build", ".cache", ".mypy_cache", ".pytest_cache",
    "coverage", ".tox", "egg-info",
}

_MAX_FILE_SIZE = 8000  # chars per file
_MAX_TOTAL_CONTEXT = 50000  # total chars for all file contents


def _scan_dir_tree(root: Path, prefix: str = "", depth: int = 0, max_depth: int = 4) -> List[str]:
    """Build a tree listing of a directory."""
    if depth > max_depth or not root.is_dir():
        return []
    lines = []
    try:
        items = sorted(root.iterdir(), key=lambda x: (not x.is_dir(), x.name))
    except PermissionError:
        return []
    for item in items:
        if item.name.startswith(".") and item.name not in (".env.example",):
            continue
        if item.is_dir() and item.name in _IGNORE_DIRS:
            continue
        if item.is_dir():
            lines.append(f"{prefix}{item.name}/")
            lines.extend(_scan_dir_tree(item, prefix + "  ", depth + 1, max_depth))
        else:
            lines.append(f"{prefix}{item.name}")
    return lines


def _read_key_files(root: Path) -> List[dict]:
    """Read important project files (specs, configs, READMEs)."""
    key_patterns = [
        "README.md", "SPEC.md", "SPECS.md", "package.json", "requirements.txt",
        "pyproject.toml", "tsconfig.json", "vite.config.ts", "vite.config.js",
    ]
    results = []
    for pattern in key_patterns:
        path = root / pattern
        if path.is_file():
            try:
                content = path.read_text(errors="replace")
                if len(content) > _MAX_FILE_SIZE:
                    content = content[:_MAX_FILE_SIZE] + "\n... (truncated)"
                results.append({"path": str(path.relative_to(root)), "content": content})
            except (PermissionError, OSError):
                pass
    return results


def _build_files_context(project_data: dict) -> str:
    """Build file context from all project paths."""
    proj_paths = project_data.get("paths", [])
    if not proj_paths and project_data.get("repo_path"):
        proj_paths = [{"label": "repo", "path": project_data["repo_path"]}]

    parts = []
    total_chars = 0

    for pp in proj_paths:
        dir_path = pp.get("path", "")
        if not dir_path or not os.path.isdir(dir_path):
            continue
        label = pp.get("label", "repo")
        root = Path(dir_path)

        # Directory tree
        tree = _scan_dir_tree(root)
        if tree:
            parts.append(f"<directory-tree label=\"{label}\" path=\"{dir_path}\">\n" + "\n".join(tree) + "\n</directory-tree>")

        # Key files
        key_files = _read_key_files(root)
        for kf in key_files:
            if total_chars + len(kf["content"]) > _MAX_TOTAL_CONTEXT:
                break
            parts.append(f"<file path=\"{label}/{kf['path']}\">\n{kf['content']}\n</file>")
            total_chars += len(kf["content"])

    return "\n\n".join(parts)

DEFAULTS_DIR = Path(__file__).parent / "defaults"

AGENT_NAMES = ["product", "architect", "dev", "test", "uxui"]


def _load_default_config(agent_name: str) -> dict:
    """Load the built-in default config for an agent. Prefers .md, falls back to .json."""
    import frontmatter  # lazy import — only needed here

    md_path = DEFAULTS_DIR / f"{agent_name}.md"
    if md_path.exists():
        post = frontmatter.load(str(md_path))
        return {
            "name": post.get("name", agent_name),
            "display_name": post.get("display_name", agent_name.title()),
            "model": post.get("model"),
            "system_prompt": post.content,
        }

    # Backward compat: fall back to .json
    json_path = DEFAULTS_DIR / f"{agent_name}.json"
    if json_path.exists():
        with open(json_path) as f:
            return json.load(f)

    return {"name": agent_name, "display_name": agent_name.title(), "system_prompt": "", "model": None}


def _load_project_config(project_id: str, agent_name: str) -> Optional[dict]:
    """Load project-specific agent config overrides. Prefers .md, falls back to .json."""
    import frontmatter  # lazy import

    agents_dir = storage.project_agents_dir(project_id)

    md_path = agents_dir / f"{agent_name}.md"
    if md_path.exists():
        post = frontmatter.load(str(md_path))
        return {
            "system_prompt": post.content or None,
            "model": post.get("model"),
            "display_name": post.get("display_name"),
        }

    # Backward compat: existing .json project overrides still work
    json_path = agents_dir / f"{agent_name}.json"
    return storage.read_json(json_path)


def get_agent_config(project_id: str, agent_name: str) -> dict:
    """Get merged agent config: defaults + project overrides."""
    config = _load_default_config(agent_name)

    project_config = _load_project_config(project_id, agent_name)
    if project_config:
        # Project config overrides specific fields
        if project_config.get("system_prompt"):
            config["system_prompt"] = project_config["system_prompt"]
        if project_config.get("model"):
            config["model"] = project_config["model"]
        if project_config.get("display_name"):
            config["display_name"] = project_config["display_name"]

    return config


def save_agent_config(project_id: str, agent_name: str, overrides: dict) -> None:
    """Save project-specific agent config overrides as .md with YAML frontmatter."""
    import frontmatter  # lazy import

    agents_dir = storage.project_agents_dir(project_id)
    path = agents_dir / f"{agent_name}.md"

    metadata = {k: v for k, v in overrides.items() if k != "system_prompt"}
    content = overrides.get("system_prompt", "")

    post = frontmatter.Post(content, **metadata)
    with open(path, "w") as f:
        f.write(frontmatter.dumps(post))


def create_runner(project_id: str, agent_name: str, cwd_override: Optional[str] = None) -> AgentRunner:
    """Create an AgentRunner from config. cwd_override (e.g. worktree path) takes precedence."""
    config = get_agent_config(project_id, agent_name)

    # Build context from project
    project_data = storage.read_json(storage.project_json_path(project_id))
    project_context = storage.read_json(storage.project_context_path(project_id))

    system_prompt = config["system_prompt"]

    # Inject project context into system prompt
    if project_data or project_context:
        context_parts = []
        if project_data:
            context_parts.append(f"Project: {project_data.get('name', 'Unknown')}")
            if project_data.get("description"):
                context_parts.append(f"Description: {project_data['description']}")
            if project_data.get("tech_stack"):
                context_parts.append(f"Tech Stack: {', '.join(project_data['tech_stack'])}")
            # Support both new "paths" list and old "repo_path" string
            paths = project_data.get("paths", [])
            if not paths and project_data.get("repo_path"):
                paths = [{"label": "repo", "path": project_data["repo_path"]}]
            if paths:
                path_lines = [f"  - {p.get('label', 'repo')}: {p['path']}" for p in paths if p.get("path")]
                if path_lines:
                    context_parts.append("Project paths:\n" + "\n".join(path_lines))
        if project_context:
            if project_context.get("conventions"):
                context_parts.append(f"Conventions: {', '.join(project_context['conventions'])}")
            if project_context.get("architecture_decisions"):
                context_parts.append(f"Architecture Decisions: {', '.join(project_context['architecture_decisions'])}")
            if project_context.get("tech_constraints"):
                context_parts.append(f"Tech Constraints: {', '.join(project_context['tech_constraints'])}")

        if context_parts:
            system_prompt += f"\n\n<project-info>\n" + "\n".join(context_parts) + "\n</project-info>"

    # Inject file context from project directories
    if project_data:
        files_context = _build_files_context(project_data)
        if files_context:
            system_prompt += "\n\n<project-files>\n" + files_context + "\n</project-files>"

    # Determine working directory: worktree override > project paths
    cwd = cwd_override
    if not cwd and project_data:
        proj_paths = project_data.get("paths", [])
        if not proj_paths and project_data.get("repo_path"):
            proj_paths = [{"path": project_data["repo_path"]}]
        for pp in proj_paths:
            if pp.get("path") and os.path.isdir(pp["path"]):
                cwd = pp["path"]
                break

    return AgentRunner(
        name=agent_name,
        system_prompt=system_prompt,
        model=config.get("model"),
        cwd=cwd,
    )


def list_agents(project_id: str) -> list:
    """List all agents with their status for a project."""
    agents = []
    for name in AGENT_NAMES:
        config = get_agent_config(project_id, name)
        agents.append({
            "name": name,
            "display_name": config.get("display_name", name.title()),
            "status": "idle",
            "current_task_id": None,
        })
    return agents
