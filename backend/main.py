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


@app.get("/health")
async def health():
    return {"status": "ok"}
