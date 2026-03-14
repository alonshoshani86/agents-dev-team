from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.projects import router as projects_router
from routes.config import router as config_router
from routes.agents import router as agents_router
from routes.tasks import router as tasks_router
from routes.files import router as files_router
from routes.websocket import router as ws_router

app = FastAPI(title="DevTeam Agent Platform", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_router, prefix="/projects", tags=["projects"])
app.include_router(config_router, prefix="/config", tags=["config"])
app.include_router(agents_router, tags=["agents"])
app.include_router(tasks_router, tags=["tasks"])  # routes have /projects/{id}/tasks prefix built-in
app.include_router(files_router, tags=["files"])
app.include_router(ws_router, tags=["websocket"])


@app.on_event("startup")
async def cleanup_stale_tasks():
    """Reset tasks stuck in 'running' status from a previous server session."""
    import storage
    projects_dir = storage.projects_dir()
    if not projects_dir.exists():
        return
    for proj_dir in projects_dir.iterdir():
        if not proj_dir.is_dir():
            continue
        tasks_dir = proj_dir / "tasks"
        if not tasks_dir.exists():
            continue
        for task_dir in tasks_dir.iterdir():
            task_file = task_dir / "task.json"
            task = storage.read_json(task_file)
            if task and task.get("status") == "running":
                task["status"] = "error"
                task["updated_at"] = storage.now_iso()
                storage.write_json(task_file, task)


@app.get("/health")
async def health():
    return {"status": "ok"}
