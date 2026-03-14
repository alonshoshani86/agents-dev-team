"""Agent runner: supports both CLI mode (no permissions) and SDK bridge mode (with UI permissions)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import AsyncGenerator, Callable, Coroutine, Dict, List, Optional

from routes.config import get_config

logger = logging.getLogger(__name__)

# Type for permission callback: receives request dict, returns response dict
PermissionCallback = Callable[[dict], Coroutine[None, None, dict]]


def _find_npx() -> Optional[str]:
    """Find npx binary."""
    for path in ["/usr/local/bin/npx", "/opt/homebrew/bin/npx"]:
        if os.path.isfile(path):
            return path
    return shutil.which("npx")


def _find_node() -> Optional[str]:
    """Find node binary."""
    for path in ["/usr/local/bin/node", "/opt/homebrew/bin/node"]:
        if os.path.isfile(path):
            return path
    return shutil.which("node")


def _get_node_env() -> dict:
    """Get environment with node/npx in PATH, safe for spawning Claude Code."""
    env = os.environ.copy()
    extra_paths = ["/usr/local/bin", "/opt/homebrew/bin", "/bin", "/usr/bin", "/usr/sbin", "/sbin"]
    current_path = env.get("PATH", "")
    env["PATH"] = ":".join(extra_paths) + ":" + current_path
    for var in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_AGENT_SDK_VERSION"]:
        env.pop(var, None)
    return env


def _get_model(override: Optional[str] = None) -> str:
    if override:
        return override
    config = get_config()
    return config.get("default_model", "claude-sonnet-4-6")


def _bridge_script_path() -> str:
    """Path to the agent-bridge.mjs script."""
    return str(Path(__file__).parent.parent / "agent-bridge.mjs")


class AgentRunner:
    """Runs any agent via Claude Code — supports CLI mode or SDK bridge with permissions."""

    def __init__(
        self,
        name: str,
        system_prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        cwd: Optional[str] = None,
    ):
        self.name = name
        self.system_prompt = system_prompt
        self.model = model
        self.max_tokens = max_tokens
        self.cwd = cwd
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._cancelled = False

    def cancel(self):
        """Cancel the running agent and kill its subprocess."""
        self._cancelled = True
        if self._proc and self._proc.returncode is None:
            self._proc.kill()

    async def stream(
        self,
        user_message: str,
        context: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> AsyncGenerator[str, None]:
        """Run the agent via Claude Code CLI (no permission UI) and yield response chunks."""
        npx = _find_npx()
        if not npx:
            yield "Error: npx not found. Install Node.js to run agents."
            return

        prompt = user_message
        if context:
            prompt = f"<context>\n{context}\n</context>\n\n{user_message}"

        cmd = [
            npx, "-y", "@anthropic-ai/claude-code",
            "--print",
            "--dangerously-skip-permissions",
            "--system-prompt", self.system_prompt,
            "--model", _get_model(self.model),
            prompt,
        ]

        logger.info(f"[AgentRunner:{self.name}] Starting CLI mode: cwd={self.cwd}, model={_get_model(self.model)}")

        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_get_node_env(),
            cwd=self.cwd,
        )
        proc = self._proc

        try:
            while True:
                if self._cancelled:
                    proc.kill()
                    return
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=300)
                except asyncio.TimeoutError:
                    logger.warning(f"[AgentRunner:{self.name}] Timed out after 5 minutes")
                    proc.kill()
                    yield "\n\nError: Agent timed out after 5 minutes."
                    return
                if not line:
                    break
                yield line.decode("utf-8", errors="replace")
        finally:
            await proc.wait()
            self._proc = None

        if proc.returncode != 0:
            stderr = await proc.stderr.read()
            err_text = stderr.decode("utf-8", errors="replace").strip()
            logger.error(f"[AgentRunner:{self.name}] Error (rc={proc.returncode}): {err_text[:500]}")
            if err_text:
                yield f"\n\nError: {err_text}"

    async def stream_with_permissions(
        self,
        user_message: str,
        on_permission: PermissionCallback,
        context: Optional[str] = None,
        auto_approve_read: bool = True,
        on_usage: Optional[Callable[[dict], Coroutine[None, None, None]]] = None,
        on_activity: Optional[Callable[[dict], Coroutine[None, None, None]]] = None,
    ) -> AsyncGenerator[str, None]:
        """Run the agent via SDK bridge with interactive permission handling.

        Args:
            user_message: The prompt to send to the agent.
            on_permission: Async callback that receives a permission request dict
                           and must return a response dict with {id, behavior, message?}.
            context: Optional context to prepend to the message.
            auto_approve_read: If True, auto-approve read-only operations (Read, Glob, Grep).
            on_activity: Optional callback for thinking/tool events from the agent.
        """
        node = _find_node()
        if not node:
            yield "Error: node not found. Install Node.js to run agents."
            return

        bridge_path = _bridge_script_path()
        if not os.path.isfile(bridge_path):
            yield f"Error: Bridge script not found at {bridge_path}"
            return

        prompt = user_message
        if context:
            prompt = f"<context>\n{context}\n</context>\n\n{user_message}"

        # Build config for the bridge
        config = {
            "systemPrompt": self.system_prompt,
            "model": _get_model(self.model),
            "userMessage": prompt,
            "cwd": self.cwd,
            "autoApproveRead": auto_approve_read,
        }

        cmd = [node, bridge_path, json.dumps(config)]

        logger.info(f"[AgentRunner:{self.name}] Starting bridge mode: cwd={self.cwd}, model={_get_model(self.model)}")

        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_get_node_env(),
            cwd=self.cwd,
        )
        proc = self._proc

        # Read stderr in background for debugging
        async def _read_stderr():
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if text:
                    logger.info(f"[AgentRunner:{self.name}] bridge stderr: {text[:300]}")

        stderr_task = asyncio.create_task(_read_stderr())

        try:
            while True:
                if self._cancelled:
                    proc.kill()
                    return

                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=300)
                except asyncio.TimeoutError:
                    logger.warning(f"[AgentRunner:{self.name}] Bridge timed out after 5 minutes")
                    proc.kill()
                    yield "\n\nError: Agent timed out after 5 minutes."
                    return

                if not line:
                    break

                line_str = line.decode("utf-8", errors="replace").strip()
                if not line_str:
                    continue

                try:
                    msg = json.loads(line_str)
                except json.JSONDecodeError:
                    # Not JSON — treat as plain text chunk
                    yield line_str + "\n"
                    continue

                msg_type = msg.get("type")

                if msg_type == "chunk":
                    yield msg.get("content", "")

                elif msg_type in ("thinking_start", "thinking_chunk", "tool_start", "tool_end", "tool_result"):
                    if on_activity:
                        await on_activity(msg)

                elif msg_type == "permission_request":
                    # Forward to the callback and send response back to bridge
                    logger.info(f"[AgentRunner:{self.name}] Permission request: {msg.get('toolName')} - {msg.get('summary')}")
                    try:
                        response = await on_permission(msg)
                        # Write response as JSON line to bridge's stdin
                        response_line = json.dumps(response) + "\n"
                        proc.stdin.write(response_line.encode("utf-8"))
                        await proc.stdin.drain()
                    except Exception as e:
                        logger.error(f"[AgentRunner:{self.name}] Permission callback error: {e}")
                        # Deny on error — but only if stdin is still open
                        try:
                            deny = json.dumps({"id": msg.get("id"), "behavior": "deny", "message": str(e)}) + "\n"
                            proc.stdin.write(deny.encode("utf-8"))
                            await proc.stdin.drain()
                        except Exception:
                            break  # Bridge process died

                elif msg_type == "usage":
                    if on_usage:
                        await on_usage(msg)

                elif msg_type == "done":
                    break

                elif msg_type == "error":
                    yield f"\n\nError: {msg.get('message', 'Unknown error')}"
                    break

        finally:
            if proc.stdin and not proc.stdin.is_closing():
                proc.stdin.close()
            await proc.wait()
            stderr_task.cancel()
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass
            self._proc = None

        if proc.returncode not in (0, None):
            logger.error(f"[AgentRunner:{self.name}] Bridge exited with code {proc.returncode}")

    async def run(
        self,
        user_message: str,
        context: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        """Run the agent and return the full response."""
        chunks = []
        async for chunk in self.stream(user_message, context, history):
            chunks.append(chunk)
        return "".join(chunks)
