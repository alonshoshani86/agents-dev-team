"""Orchestrator engine: executes tasks through dynamic agent routing."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Callable, Coroutine, Dict, List, Optional

import storage
import worktree as wt
from agents.registry import create_runner

logger = logging.getLogger(__name__)
from orchestrator.models import (
    append_history, create_artifact, list_artifacts,
    append_terminal_message, update_last_terminal_message,
    clear_agent_terminal, get_artifact_content,
)
from orchestrator.pipelines import get_pipeline

MAX_ITERATIONS = 10

# In-memory state for running tasks
_running_tasks: Dict[str, "TaskExecution"] = {}


class TaskExecution:
    """Tracks state for a running task pipeline execution."""

    def __init__(self, project_id: str, task_id: str, pipeline: dict):
        self.project_id = project_id
        self.task_id = task_id
        self.pipeline = pipeline
        self.start_agent = pipeline.get("start_agent", "product")
        self.iteration = 0
        self.current_agent: Optional[str] = None
        self.paused = False
        self.cancelled = False
        self.extra_context: Optional[str] = None  # injected instructions
        self.next_agent_choice: Optional[str] = None  # user's choice for next agent
        self.worktree_path: Optional[str] = None  # git worktree directory for this task
        self._current_runner = None  # reference to active AgentRunner for cancellation
        self._pause_event = asyncio.Event()
        self._pause_event.set()  # not paused initially
        # Permission handling
        self.permissions_enabled = True  # use SDK bridge with permission UI
        self._pending_permissions: Dict[str, asyncio.Future] = {}  # id -> Future[response]
        # Per-agent run tracking (for terminal separator and artifact tagging)
        self._terminal_run_counts: Dict[str, int] = {}
        self._current_run_for_agent: Dict[str, int] = {}

    def resolve_permission(self, permission_id: str, response: dict) -> bool:
        """Resolve a pending permission request with a user response."""
        future = self._pending_permissions.pop(permission_id, None)
        if future and not future.done():
            future.set_result(response)
            return True
        return False

    def pause(self):
        self.paused = True
        self._pause_event.clear()

    def resume(self):
        self.paused = False
        self._pause_event.set()

    async def wait_if_paused(self):
        await self._pause_event.wait()


# Type for event callback
EventCallback = Callable[[dict], Coroutine[Any, Any, None]]


def _has_active_agent(project_id: str, exclude_task_id: Optional[str] = None) -> Optional[str]:
    """Check if any task in this project has an actively running agent (not just paused/choosing).
    Returns the blocking task_id, or None."""
    for tid, ex in _running_tasks.items():
        if tid == exclude_task_id:
            continue
        if ex.project_id == project_id and ex._current_runner is not None:
            return tid
    return None


async def _setup_worktree(project_id: str, task_id: str) -> tuple[Optional[str], Optional[str]]:
    """Create a git worktree for a task. Returns (worktree_path, branch_name)."""
    repo_path = storage.get_repo_path(project_id)
    if not repo_path or not wt.is_git_repo(repo_path):
        return None, None

    task = storage.read_json(
        storage.project_tasks_dir(project_id) / task_id / "task.json"
    )
    task_name = task.get("title", "") if task else ""
    success, result, branch = await wt.create_worktree(repo_path, task_id, task_name)
    if success:
        logger.info("Task %s worktree ready: %s (branch: %s)", task_id, result, branch)
        return result, branch
    else:
        logger.warning("Worktree creation failed for task %s: %s", task_id, result)
        return None, None


async def start_pipeline(
    project_id: str,
    task_id: str,
    pipeline_id: str,
    on_event: Optional[EventCallback] = None,
) -> None:
    """Start executing a task through a pipeline."""
    pipeline = get_pipeline(project_id, pipeline_id)
    if not pipeline:
        if on_event:
            await on_event({"type": "error", "task_id": task_id, "message": f"Pipeline not found: {pipeline_id}"})
        return

    execution = TaskExecution(project_id, task_id, pipeline)

    # Create git worktree for task isolation
    worktree_path, branch_name = await _setup_worktree(project_id, task_id)
    execution.worktree_path = worktree_path

    _running_tasks[task_id] = execution

    # Update task status (include worktree info)
    task_updates = {
        "status": "running",
        "pipeline_id": pipeline_id,
    }
    if worktree_path:
        task_updates["worktree_path"] = worktree_path
        task_updates["branch_name"] = branch_name
    _update_task(project_id, task_id, task_updates)

    if on_event:
        await on_event({
            "type": "task_started",
            "task_id": task_id,
            "pipeline": pipeline.get("name", pipeline_id),
        })

    try:
        await _execute_pipeline(execution, on_event)
    except Exception as e:
        _update_task(project_id, task_id, {"status": "error"})
        if on_event:
            await on_event({"type": "task_error", "task_id": task_id, "message": str(e)})
    finally:
        _running_tasks.pop(task_id, None)


async def _execute_pipeline(
    execution: TaskExecution,
    on_event: Optional[EventCallback],
) -> None:
    """Execute agents — after each agent, user chooses what runs next."""
    next_agent = execution.start_agent

    while next_agent and not execution.cancelled:
        if execution.iteration >= MAX_ITERATIONS:
            if on_event:
                await on_event({
                    "type": "pipeline_stopped",
                    "task_id": execution.task_id,
                    "agent": execution.current_agent or next_agent,
                    "message": f"Pipeline reached maximum iterations ({MAX_ITERATIONS}). Stopping.",
                })
            break

        # Wait if paused
        await execution.wait_if_paused()
        if execution.cancelled:
            break

        execution.current_agent = next_agent
        execution.iteration += 1

        signal, suggested_agent = await _execute_agent(execution, next_agent, on_event)

        if signal == "needs_input":
            # Pause and wait for user input, then re-run same agent
            await execution.wait_if_paused()
            if execution.cancelled:
                break
            continue

        # After agent completes, pause and ask user which agent to run next
        execution.next_agent_choice = None
        execution.pause()
        _update_task(execution.project_id, execution.task_id, {
            "status": "choosing_agent",
            "paused": True,
        })
        if on_event:
            await on_event({
                "type": "choose_next_agent",
                "task_id": execution.task_id,
                "agent": next_agent,
                "suggested_agent": suggested_agent,
            })

        # Wait for user to choose
        await execution.wait_if_paused()
        if execution.cancelled:
            break

        # User chose next agent (or "done")
        next_agent = execution.next_agent_choice

    if execution.cancelled:
        _update_task(execution.project_id, execution.task_id, {"status": "cancelled"})
        if on_event:
            await on_event({"type": "task_cancelled", "task_id": execution.task_id})
    else:
        _update_task(execution.project_id, execution.task_id, {"status": "completed"})
        if on_event:
            await on_event({"type": "task_completed", "task_id": execution.task_id})


async def _execute_agent(
    execution: TaskExecution,
    agent_name: str,
    on_event: Optional[EventCallback],
) -> tuple[Optional[str], Optional[str]]:
    """Execute a single agent. Returns (signal, next_agent)."""
    _update_task(execution.project_id, execution.task_id, {
        "current_agent": agent_name,
        "iteration": execution.iteration,
    })

    if on_event:
        await on_event({
            "type": "step_started",
            "task_id": execution.task_id,
            "agent": agent_name,
            "step_name": agent_name,
            "iteration": execution.iteration,
        })

    # Track per-agent run count — increment on each call, never clear the log
    agent_run = execution._terminal_run_counts.get(agent_name, 0) + 1
    execution._terminal_run_counts[agent_name] = agent_run
    execution._current_run_for_agent[agent_name] = agent_run

    agent_display = {"product": "Product", "architect": "Architect", "dev": "Dev", "test": "Test", "uxui": "UX/UI"}.get(agent_name, agent_name)

    if agent_run > 1:
        # Insert a visual separator before the new run's messages
        append_terminal_message(
            execution.project_id, execution.task_id, agent_name, "system",
            f"--- Re-run #{agent_run} ---",
        )

    # Save "starting" system message to terminal log
    append_terminal_message(execution.project_id, execution.task_id, agent_name, "system", f"Starting {agent_display} agent...")

    # Show which artifacts are being passed as context
    prev_artifacts = list_artifacts(execution.project_id, execution.task_id)
    if prev_artifacts:
        artifact_list = ", ".join(
            f"{a.get('type', '?')} (by {a.get('agent', '?')}, {len(a.get('content', ''))} chars)"
            for a in prev_artifacts
        )
        append_terminal_message(
            execution.project_id, execution.task_id, agent_name, "system",
            f"Context from previous steps: {artifact_list}"
        )
        if on_event:
            await on_event({
                "type": "step_chunk",
                "task_id": execution.task_id,
                "agent": agent_name,
                "content": "",  # empty chunk to trigger UI update
            })

    # Build context from task + previous artifacts
    task = storage.read_json(
        storage.project_tasks_dir(execution.project_id) / execution.task_id / "task.json"
    )
    context = _build_context(execution, task)

    # Build the user message
    user_message = f"Task: {task.get('title', '')}\n\n{task.get('description', '')}"

    # Add injected instructions if any
    if execution.extra_context:
        user_message += f"\n\nAdditional instructions:\n{execution.extra_context}"
        execution.extra_context = None  # consume once

    # Run the agent (use worktree as cwd if available)
    runner = create_runner(execution.project_id, agent_name, cwd_override=execution.worktree_path)
    execution._current_runner = runner
    full_response = ""

    if execution.permissions_enabled:
        # Use SDK bridge with permission UI
        async def _on_permission(request: dict) -> dict:
            """Forward permission request to UI and wait for response."""
            perm_id = request.get("id", "")
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            execution._pending_permissions[perm_id] = future

            # Broadcast permission request to frontend
            if on_event:
                await on_event({
                    "type": "permission_request",
                    "task_id": execution.task_id,
                    "agent": agent_name,
                    "id": perm_id,
                    "toolName": request.get("toolName", ""),
                    "toolInput": request.get("toolInput", {}),
                    "category": request.get("category", "other"),
                    "summary": request.get("summary", ""),
                })

            # Wait for user response (timeout handled by the bridge)
            try:
                response = await asyncio.wait_for(future, timeout=130)
                return response
            except asyncio.TimeoutError:
                execution._pending_permissions.pop(perm_id, None)
                return {"id": perm_id, "behavior": "deny", "message": "Timed out waiting for user"}

        async def _on_usage(usage: dict) -> None:
            """Forward usage/token info to frontend."""
            is_final = usage.get("final", False)
            cost_usd = usage.get("costUSD")

            # When an agent finishes, accumulate cost into the task's total
            total_cost_usd = None
            if is_final and cost_usd is not None:
                task_path = storage.project_tasks_dir(execution.project_id) / execution.task_id / "task.json"
                task_data = storage.read_json(task_path)
                if task_data is not None:
                    existing_total = task_data.get("total_cost_usd") or 0.0
                    total_cost_usd = existing_total + cost_usd
                    task_data["total_cost_usd"] = total_cost_usd
                    storage.write_json(task_path, task_data)

            if on_event:
                event: dict = {
                    "type": "usage_update",
                    "task_id": execution.task_id,
                    "agent": agent_name,
                    "inputTokens": usage.get("inputTokens", 0),
                    "outputTokens": usage.get("outputTokens", 0),
                    "cacheRead": usage.get("cacheRead", 0),
                    "cacheCreation": usage.get("cacheCreation", 0),
                    "contextWindow": usage.get("contextWindow"),
                    "costUSD": cost_usd,
                    "numTurns": usage.get("numTurns"),
                    "final": is_final,
                }
                if total_cost_usd is not None:
                    event["totalCostUSD"] = total_cost_usd
                await on_event(event)

        async def _on_activity(activity: dict) -> None:
            """Forward thinking/tool activity events to frontend."""
            if on_event:
                await on_event({
                    **activity,
                    "task_id": execution.task_id,
                    "agent": agent_name,
                })

        async for chunk in runner.stream_with_permissions(
            user_message, on_permission=_on_permission, context=context,
            on_usage=_on_usage, on_activity=_on_activity,
        ):
            if execution.cancelled:
                break
            full_response += chunk
            if on_event:
                await on_event({
                    "type": "step_chunk",
                    "task_id": execution.task_id,
                    "agent": agent_name,
                    "content": chunk,
                })
    else:
        # Use CLI mode (no permission UI)
        async for chunk in runner.stream(user_message, context=context):
            if execution.cancelled:
                break
            full_response += chunk
            if on_event:
                await on_event({
                    "type": "step_chunk",
                    "task_id": execution.task_id,
                    "agent": agent_name,
                    "content": chunk,
                })

    execution._current_runner = None

    # If cancelled during streaming, return immediately
    if execution.cancelled:
        return None, None

    # Save full agent output to terminal log
    update_last_terminal_message(execution.project_id, execution.task_id, agent_name, full_response)

    # Detect signals
    signal = _detect_signal(full_response)
    next_agent = _detect_next_agent(full_response)

    # Save artifact
    artifact_type = _agent_artifact_type(agent_name)
    create_artifact(
        execution.project_id,
        execution.task_id,
        artifact_type,
        full_response,
        agent_name,
    )

    # Log to history
    append_history(execution.project_id, execution.task_id, {
        "agent": agent_name,
        "iteration": execution.iteration,
        "input_summary": user_message[:200],
        "output_summary": full_response[:500],
        "artifact_type": artifact_type,
        "signal": signal,
        "next_agent": next_agent,
    })

    if signal == "needs_input":
        # Pause pipeline — agent needs user input
        execution.pause()
        _update_task(execution.project_id, execution.task_id, {
            "status": "waiting_input",
            "paused": True,
        })
        append_terminal_message(execution.project_id, execution.task_id, agent_name, "system",
            "Pipeline paused: agent needs your input before continuing. Use the input box below to respond, then the pipeline will resume.")
        if on_event:
            await on_event({
                "type": "pipeline_needs_input",
                "task_id": execution.task_id,
                "agent": agent_name,
                "message": "Agent has questions or needs clarification before the pipeline can continue.",
            })

    # Save completion message
    next_display = {"product": "Product", "architect": "Architect", "dev": "Dev", "test": "Test", "uxui": "UX/UI"}.get(next_agent or "", next_agent or "")
    completion_msg = f"{agent_display} completed. Routing to {next_display}..." if next_agent else f"{agent_display} agent completed."
    append_terminal_message(execution.project_id, execution.task_id, agent_name, "system", completion_msg)

    if on_event:
        await on_event({
            "type": "step_completed",
            "task_id": execution.task_id,
            "agent": agent_name,
            "step_name": agent_name,
            "signal": signal,
            "next_agent": next_agent,
        })

    return signal, next_agent


def _build_context(execution: TaskExecution, task: dict) -> str:
    """Build context for an agent from previous artifacts (latest run only)."""
    parts = []

    # Add previous artifacts as context — use only the latest run so downstream
    # agents are not confused by earlier re-run content.
    artifacts = list_artifacts(execution.project_id, execution.task_id)
    if artifacts:
        parts.append("Previous artifacts from this task:")
        for art in artifacts:
            artifact_type = art.get("type", "unknown")
            # Fetch only the latest run's content
            latest_content = get_artifact_content(
                execution.project_id, execution.task_id, artifact_type, run="latest"
            )
            content = latest_content if latest_content is not None else art.get("content", "")
            parts.append(f"\n--- {artifact_type} (by {art.get('agent', 'unknown')}) ---")
            if len(content) > 10000:
                content = content[:10000] + "\n... (truncated)"
            parts.append(content)

    return "\n".join(parts) if parts else ""


def _detect_signal(response: str) -> Optional[str]:
    """Detect pipeline control signals in agent output."""
    response_upper = response.upper()
    if "[PIPELINE:NEEDS_INPUT]" in response_upper:
        return "needs_input"
    return None


def _detect_next_agent(response: str) -> Optional[str]:
    """Detect [NEXT:agent_name] routing directive in agent output."""
    match = re.search(r'\[NEXT:(\w+)\]', response, re.IGNORECASE)
    if match:
        agent = match.group(1).lower()
        valid_agents = {"product", "architect", "dev", "test", "uxui"}
        if agent in valid_agents:
            return agent
    return None


def _agent_artifact_type(agent_name: str) -> str:
    """Map agent to its default artifact type."""
    return {
        "product": "spec",
        "architect": "architecture",
        "dev": "implementation",
        "test": "test-plan",
        "uxui": "ui-review",
    }.get(agent_name, agent_name)


def _update_task(project_id: str, task_id: str, updates: dict) -> None:
    """Update task fields on disk."""
    task_path = storage.project_tasks_dir(project_id) / task_id / "task.json"
    task = storage.read_json(task_path)
    if task:
        task.update(updates)
        task["updated_at"] = storage.now_iso()
        storage.write_json(task_path, task)


# --- Public API for controlling running tasks ---


def pause_task(task_id: str) -> bool:
    """Pause a running task."""
    execution = _running_tasks.get(task_id)
    if not execution:
        return False
    execution.pause()
    _update_task(execution.project_id, task_id, {"status": "paused", "paused": True})
    return True


def resume_task(task_id: str) -> bool:
    """Resume a paused task."""
    execution = _running_tasks.get(task_id)
    if not execution:
        return False
    execution.resume()
    _update_task(execution.project_id, task_id, {"status": "running", "paused": False})
    return True


def cancel_task(task_id: str) -> bool:
    """Cancel a running task and kill any active agent subprocess."""
    execution = _running_tasks.get(task_id)
    if not execution:
        return False
    execution.cancelled = True
    if execution._current_runner:
        execution._current_runner.cancel()
    execution.resume()  # unblock if paused
    return True


def set_next_agent(task_id: str, agent_name: Optional[str]) -> bool:
    """Set the next agent to run (user's choice). None means 'done'."""
    execution = _running_tasks.get(task_id)
    if not execution:
        return False
    execution.next_agent_choice = agent_name
    execution.resume()
    _update_task(execution.project_id, task_id, {"status": "running", "paused": False})
    return True


def resolve_permission(task_id: str, permission_id: str, behavior: str, message: Optional[str] = None) -> bool:
    """Resolve a pending permission request for a running task."""
    execution = _running_tasks.get(task_id)
    if not execution:
        return False
    response = {"id": permission_id, "behavior": behavior}
    if message:
        response["message"] = message
    return execution.resolve_permission(permission_id, response)


def inject_context(task_id: str, context: str) -> bool:
    """Inject extra instructions into the next step."""
    execution = _running_tasks.get(task_id)
    if not execution:
        return False
    execution.extra_context = context
    return True


async def ask_agent(
    project_id: str,
    task_id: str,
    agent_name: str,
    message: str,
    on_event: Optional[EventCallback] = None,
) -> None:
    """Ask an agent a question with full task context, without affecting pipeline state.

    Streams response chunks via on_event callback. Does NOT save artifacts,
    advance iterations, or detect pipeline signals.
    """
    import logging
    logger = logging.getLogger(__name__)

    try:
        task = storage.read_json(
            storage.project_tasks_dir(project_id) / task_id / "task.json"
        )
        if not task:
            if on_event:
                await on_event({"type": "ask_agent_error", "task_id": task_id, "agent": agent_name, "message": "Task not found"})
            return

        # Build context from existing artifacts (same as pipeline would)
        execution = _running_tasks.get(task_id)
        if execution:
            context = _build_context(execution, task)
        else:
            # Task not actively running — build context manually
            parts = []
            artifacts = list_artifacts(project_id, task_id)
            if artifacts:
                parts.append("Previous artifacts from this task:")
                for art in artifacts:
                    parts.append(f"\n--- {art.get('type', 'unknown')} (by {art.get('agent', 'unknown')}) ---")
                    content = art.get("content", "")
                    if len(content) > 3000:
                        content = content[:3000] + "\n... (truncated)"
                    parts.append(content)
            context = "\n".join(parts) if parts else ""

        # Build user message: task info + user's question
        user_message = (
            f"Task: {task.get('title', '')}\n{task.get('description', '')}\n\n"
            f"The user has a question for you:\n{message}"
        )

        # Save user question to terminal log
        append_terminal_message(project_id, task_id, agent_name, "user", message)

        if on_event:
            await on_event({
                "type": "ask_agent_started",
                "task_id": task_id,
                "agent": agent_name,
            })

        # Use worktree path if available
        cwd_override = task.get("worktree_path")
        if cwd_override and not os.path.isdir(cwd_override):
            cwd_override = None

        logger.info(f"[ask_agent] Running {agent_name} for task {task_id}")
        runner = create_runner(project_id, agent_name, cwd_override=cwd_override)
        full_response = ""

        async for chunk in runner.stream(user_message, context=context):
            full_response += chunk
            if on_event:
                await on_event({
                    "type": "ask_agent_chunk",
                    "task_id": task_id,
                    "agent": agent_name,
                    "content": chunk,
                })

        # Save full response to terminal log
        update_last_terminal_message(project_id, task_id, agent_name, full_response)

        logger.info(f"[ask_agent] Completed {agent_name} for task {task_id}")
        if on_event:
            await on_event({
                "type": "ask_agent_done",
                "task_id": task_id,
                "agent": agent_name,
            })

    except Exception as e:
        logger.error(f"[ask_agent] Error for {agent_name}/{task_id}: {e}", exc_info=True)
        if on_event:
            try:
                await on_event({
                    "type": "ask_agent_error",
                    "task_id": task_id,
                    "agent": agent_name,
                    "message": str(e),
                })
            except Exception:
                pass


async def run_single_agent(
    project_id: str,
    task_id: str,
    agent_name: str,
    extra_context: Optional[str] = None,
    on_event: Optional[EventCallback] = None,
) -> None:
    """Run a single agent on a task, then pause for user to choose next.

    Works even if the task is completed/cancelled — creates a fresh execution.
    """
    import logging
    logger = logging.getLogger(__name__)

    # Create a minimal pipeline execution
    pipeline = {"name": "manual", "start_agent": agent_name}
    execution = TaskExecution(project_id, task_id, pipeline)
    execution.extra_context = extra_context

    # Reuse existing worktree or create one
    task = storage.read_json(
        storage.project_tasks_dir(project_id) / task_id / "task.json"
    )
    if task and task.get("worktree_path") and os.path.isdir(task["worktree_path"]):
        execution.worktree_path = task["worktree_path"]
    else:
        worktree_path, branch_name = await _setup_worktree(project_id, task_id)
        execution.worktree_path = worktree_path
        if worktree_path:
            _update_task(project_id, task_id, {
                "worktree_path": worktree_path,
                "branch_name": branch_name,
            })

    _running_tasks[task_id] = execution

    _update_task(project_id, task_id, {
        "status": "running",
        "current_agent": agent_name,
    })

    if on_event:
        await on_event({"type": "task_started", "task_id": task_id, "pipeline": "manual"})

    try:
        signal, suggested_agent = await _execute_agent(execution, agent_name, on_event)

        if execution.cancelled:
            _update_task(project_id, task_id, {"status": "cancelled"})
            if on_event:
                await on_event({"type": "task_cancelled", "task_id": task_id})
            return

        if signal == "needs_input":
            # Already paused by _execute_agent
            return

        # Pause for user to choose next agent
        execution.pause()
        _update_task(project_id, task_id, {"status": "choosing_agent", "paused": True})
        if on_event:
            await on_event({
                "type": "choose_next_agent",
                "task_id": task_id,
                "agent": agent_name,
                "suggested_agent": suggested_agent,
            })

        # Wait for user choice
        await execution.wait_if_paused()
        if execution.cancelled:
            _update_task(project_id, task_id, {"status": "cancelled"})
            if on_event:
                await on_event({"type": "task_cancelled", "task_id": task_id})
            return

        next_agent = execution.next_agent_choice
        if next_agent:
            # User chose another agent — run it recursively via pipeline loop
            await _execute_pipeline_from(execution, next_agent, on_event)
        else:
            _update_task(project_id, task_id, {"status": "completed"})
            if on_event:
                await on_event({"type": "task_completed", "task_id": task_id})

    except Exception as e:
        logger.error(f"[run_single_agent] Error: {e}", exc_info=True)
        _update_task(project_id, task_id, {"status": "error"})
        if on_event:
            await on_event({"type": "task_error", "task_id": task_id, "message": str(e)})
    finally:
        _running_tasks.pop(task_id, None)


async def _execute_pipeline_from(
    execution: TaskExecution,
    start_agent: str,
    on_event: Optional[EventCallback],
) -> None:
    """Continue pipeline execution from a given agent (reuses _execute_pipeline logic)."""
    next_agent = start_agent

    while next_agent and not execution.cancelled:
        if execution.iteration >= MAX_ITERATIONS:
            if on_event:
                await on_event({
                    "type": "pipeline_stopped",
                    "task_id": execution.task_id,
                    "agent": execution.current_agent or next_agent,
                    "message": f"Pipeline reached maximum iterations ({MAX_ITERATIONS}). Stopping.",
                })
            break

        await execution.wait_if_paused()
        if execution.cancelled:
            break

        execution.current_agent = next_agent
        execution.iteration += 1

        signal, suggested_agent = await _execute_agent(execution, next_agent, on_event)

        if signal == "needs_input":
            await execution.wait_if_paused()
            if execution.cancelled:
                break
            continue

        execution.next_agent_choice = None
        execution.pause()
        _update_task(execution.project_id, execution.task_id, {"status": "choosing_agent", "paused": True})
        if on_event:
            await on_event({
                "type": "choose_next_agent",
                "task_id": execution.task_id,
                "agent": next_agent,
                "suggested_agent": suggested_agent,
            })

        await execution.wait_if_paused()
        if execution.cancelled:
            break

        next_agent = execution.next_agent_choice

    if execution.cancelled:
        _update_task(execution.project_id, execution.task_id, {"status": "cancelled"})
        if on_event:
            await on_event({"type": "task_cancelled", "task_id": execution.task_id})
    else:
        _update_task(execution.project_id, execution.task_id, {"status": "completed"})
        if on_event:
            await on_event({"type": "task_completed", "task_id": execution.task_id})


def get_execution_status(task_id: str) -> Optional[dict]:
    """Get the current execution status of a running task."""
    execution = _running_tasks.get(task_id)
    if not execution:
        return None
    return {
        "task_id": task_id,
        "pipeline": execution.pipeline.get("name"),
        "current_agent": execution.current_agent,
        "iteration": execution.iteration,
        "max_iterations": MAX_ITERATIONS,
        "paused": execution.paused,
        "cancelled": execution.cancelled,
    }
