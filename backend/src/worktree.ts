/**
 * Git worktree helpers — create/remove per-task worktrees.
 * Port of backend/worktree.py to TypeScript.
 */

import { execFile } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error ? 1 : 0,
        stdout: (stdout ?? "").trim(),
        stderr: (stderr ?? "").trim(),
      });
    });
  });
}

export function isGitRepo(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, ".git"));
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  const { code, stdout } = await runGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    repoPath,
  );
  if (code === 0 && stdout) return stdout.split("/").pop()!;

  // Fallback: check master first, then main
  const { code: rc } = await runGit(["rev-parse", "--verify", "master"], repoPath);
  return rc === 0 ? "master" : "main";
}

export function worktreeBaseDir(repoPath: string): string {
  return path.join(repoPath, ".worktrees");
}

export function worktreePathForTask(repoPath: string, taskId: string): string {
  return path.join(worktreeBaseDir(repoPath), taskId);
}

export function branchNameForTask(taskId: string): string {
  return `task/${taskId}`;
}

/**
 * Create a git worktree for a task.
 * Returns [success, worktree_path_or_error, branch_name].
 */
export async function createWorktree(
  repoPath: string,
  taskId: string,
): Promise<[boolean, string, string | null]> {
  if (!isGitRepo(repoPath)) {
    return [false, `Not a git repository: ${repoPath}`, null];
  }

  const wtPath = worktreePathForTask(repoPath, taskId);
  const branch = branchNameForTask(taskId);

  // Already exists (e.g. task restart)
  if (fs.existsSync(wtPath)) {
    return [true, wtPath, branch];
  }

  // Ensure .worktrees/ is excluded from git tracking
  ensureExcluded(repoPath);

  const defaultBranch = await getDefaultBranch(repoPath);

  // Create worktree with new branch from default branch
  const { code, stderr } = await runGit(
    ["worktree", "add", "-b", branch, wtPath, defaultBranch],
    repoPath,
  );

  if (code !== 0) {
    // Branch might already exist (task restarted after worktree removed)
    if (stderr.includes("already exists")) {
      const { code: rc2, stderr: err2 } = await runGit(
        ["worktree", "add", wtPath, branch],
        repoPath,
      );
      if (rc2 !== 0) return [false, `Failed to create worktree: ${err2}`, null];
    } else {
      return [false, `Failed to create worktree: ${stderr}`, null];
    }
  }

  console.log(`[worktree] Created worktree for task ${taskId}: ${wtPath} (branch: ${branch})`);
  return [true, wtPath, branch];
}

export async function removeWorktree(repoPath: string, taskId: string): Promise<boolean> {
  const wtPath = worktreePathForTask(repoPath, taskId);
  if (!fs.existsSync(wtPath)) return true;

  const { code, stderr } = await runGit(
    ["worktree", "remove", wtPath, "--force"],
    repoPath,
  );
  if (code !== 0) {
    console.warn(`[worktree] Failed to remove worktree ${wtPath}: ${stderr}`);
    return false;
  }

  console.log(`[worktree] Removed worktree for task ${taskId}`);
  return true;
}

function ensureExcluded(repoPath: string): void {
  const exclude = path.join(repoPath, ".git", "info", "exclude");
  if (!fs.existsSync(exclude)) return;
  try {
    const content = fs.readFileSync(exclude, "utf-8");
    if (!content.includes(".worktrees")) {
      fs.appendFileSync(exclude, "\n.worktrees/\n");
    }
  } catch {
    // ignore
  }
}
