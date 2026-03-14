"""Task CRUD routes with pipeline execution controls."""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import storage
from orchestrator import engine
from orchestrator.pipelines import list_pipelines, get_pipeline
from routes.websocket import broadcast

router = APIRouter()


class CreateTaskRequest(BaseModel):
    name: str
    description: Optional[str] = ""
    priority: Optional[str] = "medium"
    pipeline_id: Optional[str] = None


class UpdateTaskRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None


def _task_path(project_id: str, task_id: str):
    return storage.project_tasks_dir(project_id) / task_id / "task.json"


def _get_task(project_id: str, task_id: str):
    task = storage.read_json(_task_path(project_id, task_id))
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/projects/{project_id}/tasks")
async def create_task(project_id: str, req: CreateTaskRequest):
    project = storage.read_json(storage.project_json_path(project_id))
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    base_slug = storage.slugify(req.name)
    if not base_slug:
        raise HTTPException(status_code=400, detail="Task name produces an empty slug")
    task_id = storage.unique_task_slug(project_id, base_slug)

    task = {
        "id": task_id,
        "project_id": project_id,
        "name": req.name,
        "title": req.name,
        "description": req.description,
        "priority": req.priority,
        "status": "pending",
        "pipeline_id": req.pipeline_id,
        "branch_name": f"task/{task_id}",
        "current_agent": None,
        "current_step": None,
        "paused": False,
        "created_at": storage.now_iso(),
        "updated_at": storage.now_iso(),
    }

    task_dir = storage.project_tasks_dir(project_id) / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    storage.write_json(_task_path(project_id, task_id), task)

    return task


@router.get("/projects/{project_id}/tasks")
async def list_tasks(project_id: str):
    tasks_dir = storage.project_tasks_dir(project_id)
    if not tasks_dir.exists():
        return []

    tasks = []
    for task_dir in sorted(tasks_dir.iterdir()):
        if task_dir.is_dir():
            task_file = task_dir / "task.json"
            task = storage.read_json(task_file)
            if task:
                tasks.append(task)

    return sorted(tasks, key=lambda t: t.get("created_at", ""), reverse=True)


@router.get("/projects/{project_id}/tasks/{task_id}")
async def get_task(project_id: str, task_id: str):
    return _get_task(project_id, task_id)


@router.put("/projects/{project_id}/tasks/{task_id}")
async def update_task(project_id: str, task_id: str, req: UpdateTaskRequest):
    task = _get_task(project_id, task_id)
    updates = req.model_dump(exclude_none=True)
    task.update(updates)
    task["updated_at"] = storage.now_iso()
    storage.write_json(_task_path(project_id, task_id), task)
    return task


@router.delete("/projects/{project_id}/tasks/{task_id}")
async def delete_task(project_id: str, task_id: str):
    task_dir = storage.project_tasks_dir(project_id) / task_id
    if not task_dir.exists():
        raise HTTPException(status_code=404, detail="Task not found")

    # Clean up git worktree if one was created for this task
    task = storage.read_json(task_dir / "task.json")
    if task and task.get("worktree_path"):
        import worktree as wt
        repo_path = storage.get_repo_path(project_id)
        if repo_path:
            await wt.remove_worktree(repo_path, task_id)

    storage.delete_path(task_dir)
    return {"deleted": True}


# --- Pipeline endpoints ---


@router.get("/projects/{project_id}/pipelines")
async def get_pipelines(project_id: str):
    return list_pipelines(project_id)


class RunPipelineRequest(BaseModel):
    pipeline_id: str


@router.post("/projects/{project_id}/tasks/{task_id}/run")
async def run_task_pipeline(project_id: str, task_id: str, req: RunPipelineRequest):
    """Start running a task through a pipeline."""
    task = _get_task(project_id, task_id)

    pipeline = get_pipeline(project_id, req.pipeline_id)
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")

    async def on_event(event: dict):
        await broadcast(project_id, event)

    # Run in background
    asyncio.create_task(engine.start_pipeline(project_id, task_id, req.pipeline_id, on_event))

    return {"status": "started", "pipeline": pipeline["name"]}


@router.post("/projects/{project_id}/tasks/{task_id}/pause")
async def pause_task(project_id: str, task_id: str):
    if not engine.pause_task(task_id):
        raise HTTPException(status_code=404, detail="Task not running")
    await broadcast(project_id, {"type": "task_paused", "task_id": task_id})
    return {"status": "paused"}


@router.post("/projects/{project_id}/tasks/{task_id}/resume")
async def resume_task(project_id: str, task_id: str):
    if not engine.resume_task(task_id):
        # Task not in memory (e.g. after server restart) — just update status on disk
        task = _get_task(project_id, task_id)
        task["status"] = "choosing_agent"
        task["paused"] = False
        task["updated_at"] = storage.now_iso()
        storage.write_json(storage.project_tasks_dir(project_id) / task_id / "task.json", task)
    await broadcast(project_id, {"type": "task_resumed", "task_id": task_id})
    return {"status": "running"}


@router.post("/projects/{project_id}/tasks/{task_id}/cancel")
async def cancel_task(project_id: str, task_id: str):
    # Try to cancel in-memory execution first
    engine.cancel_task(task_id)
    # Always update status on disk (handles stale tasks after server restart)
    task = _get_task(project_id, task_id)
    task["status"] = "cancelled"
    task["paused"] = False
    task["updated_at"] = storage.now_iso()
    storage.write_json(_task_path(project_id, task_id), task)
    await broadcast(project_id, {"type": "task_cancelled", "task_id": task_id})
    return {"status": "cancelled"}



class NextAgentRequest(BaseModel):
    agent: Optional[str] = None  # None means "done / finish pipeline"


@router.post("/projects/{project_id}/tasks/{task_id}/next-agent")
async def set_next_agent(project_id: str, task_id: str, req: NextAgentRequest):
    """User chooses which agent runs next, or None to finish."""
    if engine.set_next_agent(task_id, req.agent):
        # Task was in memory — pipeline loop continues
        await broadcast(project_id, {
            "type": "next_agent_chosen",
            "task_id": task_id,
            "agent": req.agent,
        })
        return {"status": "ok", "next_agent": req.agent}

    # Task not in memory (e.g. after server restart) — handle gracefully
    if req.agent is None:
        # User chose "Finish" — just mark as completed
        task = _get_task(project_id, task_id)
        task["status"] = "completed"
        task["paused"] = False
        task["updated_at"] = storage.now_iso()
        storage.write_json(storage.project_tasks_dir(project_id) / task_id / "task.json", task)
        await broadcast(project_id, {"type": "task_completed", "task_id": task_id})
        return {"status": "ok", "next_agent": None}

    # User chose an agent — start a fresh single-agent run
    async def on_event(event):
        await broadcast(project_id, event)

    asyncio.create_task(engine.run_single_agent(project_id, task_id, req.agent, on_event=on_event))
    await broadcast(project_id, {
        "type": "next_agent_chosen",
        "task_id": task_id,
        "agent": req.agent,
    })
    return {"status": "ok", "next_agent": req.agent}


class RunAgentRequest(BaseModel):
    agent: str
    context: Optional[str] = None


@router.post("/projects/{project_id}/tasks/{task_id}/run-agent")
async def run_agent(project_id: str, task_id: str, req: RunAgentRequest):
    """Run a specific agent on a task (works even on completed/cancelled tasks)."""
    _get_task(project_id, task_id)

    async def on_event(event: dict):
        await broadcast(project_id, event)

    asyncio.create_task(engine.run_single_agent(
        project_id, task_id, req.agent, req.context, on_event
    ))

    return {"status": "started", "agent": req.agent}


class AskAgentRequest(BaseModel):
    agent: str
    message: str


@router.post("/projects/{project_id}/tasks/{task_id}/ask-agent")
async def ask_agent(project_id: str, task_id: str, req: AskAgentRequest):
    """Ask an agent a question with full task context, without affecting pipeline state."""
    _get_task(project_id, task_id)

    async def on_event(event: dict):
        await broadcast(project_id, event)

    # Run in background so we return immediately; chunks stream via WebSocket
    asyncio.create_task(engine.ask_agent(project_id, task_id, req.agent, req.message, on_event))

    return {"status": "asking", "agent": req.agent}


class PermissionResponseRequest(BaseModel):
    permission_id: str
    behavior: str  # "allow" or "deny"
    message: Optional[str] = None


@router.post("/projects/{project_id}/tasks/{task_id}/permission-response")
async def permission_response(project_id: str, task_id: str, req: PermissionResponseRequest):
    """Respond to a permission request from an agent."""
    if not engine.resolve_permission(task_id, req.permission_id, req.behavior, req.message):
        raise HTTPException(status_code=404, detail="No pending permission with that ID")
    await broadcast(project_id, {
        "type": "permission_resolved",
        "task_id": task_id,
        "permission_id": req.permission_id,
        "behavior": req.behavior,
    })
    return {"status": "resolved", "behavior": req.behavior}


class InjectRequest(BaseModel):
    context: str


@router.post("/projects/{project_id}/tasks/{task_id}/inject")
async def inject_context(project_id: str, task_id: str, req: InjectRequest):
    """Inject extra instructions before the next step runs."""
    if not engine.inject_context(task_id, req.context):
        raise HTTPException(status_code=404, detail="Task not running")
    return {"status": "injected"}


@router.get("/projects/{project_id}/tasks/{task_id}/status")
async def task_execution_status(project_id: str, task_id: str):
    """Get live execution status of a running task."""
    status = engine.get_execution_status(task_id)
    if not status:
        task = _get_task(project_id, task_id)
        return {"task_id": task_id, "status": task.get("status", "unknown"), "running": False}
    return {**status, "running": True}


@router.get("/projects/{project_id}/tasks/{task_id}/history")
async def task_history(project_id: str, task_id: str):
    from orchestrator.models import get_history
    return get_history(project_id, task_id)


@router.get("/projects/{project_id}/tasks/{task_id}/artifacts")
async def task_artifacts(project_id: str, task_id: str):
    from orchestrator.models import list_artifacts
    return list_artifacts(project_id, task_id)


@router.get("/projects/{project_id}/tasks/{task_id}/artifacts/{artifact_type}/content")
async def get_artifact_content_route(
    project_id: str,
    task_id: str,
    artifact_type: str,
    run: Optional[str] = Query(default=None, description="Run selector: integer, 'latest', or omit for all"),
):
    """Get artifact content with optional run filter.

    ?run=latest  — latest run only
    ?run=1       — specific run number
    (omit)       — all runs (raw content)
    """
    from orchestrator.models import get_artifact_content

    run_param = None
    if run is not None:
        if run == "latest":
            run_param = "latest"
        else:
            try:
                run_param = int(run)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid run parameter")

    content = get_artifact_content(project_id, task_id, artifact_type, run=run_param)
    if content is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return {"artifact_type": artifact_type, "run": run, "content": content}


@router.get("/projects/{project_id}/tasks/{task_id}/artifacts/{artifact_type}/runs")
async def get_artifact_runs(project_id: str, task_id: str, artifact_type: str):
    """Return run metadata list parsed from artifact file delimiters."""
    from orchestrator.models import get_artifact_content, split_runs
    import storage as _storage

    artifacts_dir = _storage.project_tasks_dir(project_id) / task_id / "artifacts"
    content_path = artifacts_dir / f"{artifact_type}.md"
    if not content_path.exists():
        raise HTTPException(status_code=404, detail="Artifact not found")

    raw = _storage.read_text_file(content_path)
    runs = split_runs(raw)

    run_meta = [
        {"run": r["run"], "agent": r["agent"], "timestamp": r["timestamp"]}
        for r in runs
    ]
    return {
        "artifact_type": artifact_type,
        "run_count": len(runs),
        "runs": run_meta,
    }


class UpdateArtifactRequest(BaseModel):
    content: str


@router.put("/projects/{project_id}/tasks/{task_id}/artifacts/{artifact_type}")
async def update_artifact(
    project_id: str, task_id: str, artifact_type: str, req: UpdateArtifactRequest
):
    """Edit an artifact's content (human-in-the-loop editing before passing downstream)."""
    from orchestrator.models import update_artifact_content
    result = update_artifact_content(project_id, task_id, artifact_type, req.content)
    if not result:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return result


@router.get("/projects/{project_id}/tasks/{task_id}/terminals")
async def task_terminals(project_id: str, task_id: str):
    """Get saved terminal messages for a task."""
    from orchestrator.models import load_terminals
    return load_terminals(project_id, task_id)
