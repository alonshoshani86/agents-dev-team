"""Git worktree helpers — create/remove per-task worktrees."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


async def _run_git(args: list[str], cwd: str) -> Tuple[int, str, str]:
    """Run a git command and return (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode().strip(), stderr.decode().strip()


def is_git_repo(path: str) -> bool:
    """Check if path is inside a git repository."""
    return os.path.isdir(os.path.join(path, ".git"))


async def get_default_branch(repo_path: str) -> str:
    """Detect the default branch (main or master)."""
    rc, out, _ = await _run_git(
        ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], repo_path
    )
    if rc == 0 and out:
        return out.split("/")[-1]
    # Fallback: check master first, then main
    rc, _, _ = await _run_git(["rev-parse", "--verify", "master"], repo_path)
    if rc == 0:
        return "master"
    return "main"


def worktree_base_dir(repo_path: str) -> Path:
    return Path(repo_path) / ".worktrees"


def worktree_path_for_task(repo_path: str, task_id: str) -> Path:
    return worktree_base_dir(repo_path) / task_id


def branch_name_for_task(task_id: str) -> str:
    return f"task/{task_id}"


async def create_worktree(
    repo_path: str, task_id: str
) -> Tuple[bool, str, Optional[str]]:
    """Create a git worktree for a task.

    Returns (success, worktree_path_or_error, branch_name).
    """
    if not is_git_repo(repo_path):
        return False, f"Not a git repository: {repo_path}", None

    wt_path = worktree_path_for_task(repo_path, task_id)
    branch = branch_name_for_task(task_id)

    # Already exists (e.g. task restart)
    if wt_path.exists():
        return True, str(wt_path), branch

    # Ensure .worktrees/ is excluded from git tracking
    _ensure_excluded(repo_path)

    default_branch = await get_default_branch(repo_path)

    # Create worktree with new branch from default branch
    rc, out, err = await _run_git(
        ["worktree", "add", "-b", branch, str(wt_path), default_branch],
        repo_path,
    )
    if rc != 0:
        # Branch might already exist (task restarted after worktree removed)
        if "already exists" in err:
            rc2, _, err2 = await _run_git(
                ["worktree", "add", str(wt_path), branch], repo_path
            )
            if rc2 != 0:
                return False, f"Failed to create worktree: {err2}", None
        else:
            return False, f"Failed to create worktree: {err}", None

    logger.info("Created worktree for task %s: %s (branch: %s)", task_id, wt_path, branch)
    return True, str(wt_path), branch


async def remove_worktree(repo_path: str, task_id: str) -> bool:
    """Remove a worktree (keeps the branch)."""
    wt_path = worktree_path_for_task(repo_path, task_id)
    if not wt_path.exists():
        return True

    rc, _, err = await _run_git(
        ["worktree", "remove", str(wt_path), "--force"], repo_path
    )
    if rc != 0:
        logger.warning("Failed to remove worktree %s: %s", wt_path, err)
        return False

    logger.info("Removed worktree for task %s", task_id)
    return True


def _ensure_excluded(repo_path: str) -> None:
    """Add .worktrees/ to .git/info/exclude if not already there."""
    exclude = Path(repo_path) / ".git" / "info" / "exclude"
    if not exclude.exists():
        return
    try:
        content = exclude.read_text()
        if ".worktrees" not in content:
            with open(exclude, "a") as f:
                f.write("\n.worktrees/\n")
    except OSError:
        pass
