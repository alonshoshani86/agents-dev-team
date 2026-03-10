from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import storage

router = APIRouter()


class ProjectPath(BaseModel):
    label: str = ""
    path: str = ""


class CreateProjectRequest(BaseModel):
    name: str
    description: str = ""
    tech_stack: List[str] = []
    paths: List[ProjectPath] = []


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    tech_stack: Optional[List[str]] = None
    paths: Optional[List[ProjectPath]] = None
    status: Optional[str] = None


@router.post("")
async def create_project(req: CreateProjectRequest):
    project_id = storage.generate_id()
    project = {
        "id": project_id,
        "name": req.name,
        "description": req.description,
        "tech_stack": req.tech_stack,
        "paths": [p.model_dump() for p in req.paths],
        "status": "active",
        "created_at": storage.now_iso(),
    }

    storage.init_project_dirs(project_id)
    storage.write_json(storage.project_json_path(project_id), project)

    # Initialize empty project context
    context = {
        "conventions": [],
        "architecture_decisions": [],
        "known_patterns": [],
        "tech_constraints": [],
    }
    storage.write_json(storage.project_context_path(project_id), context)

    return project


@router.get("")
async def list_projects():
    projects = []
    for dir_name in storage.list_dirs(storage.projects_dir()):
        data = storage.read_json(storage.project_json_path(dir_name))
        if data:
            projects.append(data)
    return projects


@router.get("/{project_id}")
async def get_project(project_id: str):
    data = storage.read_json(storage.project_json_path(project_id))
    if not data:
        raise HTTPException(status_code=404, detail="Project not found")
    return data


@router.put("/{project_id}")
async def update_project(project_id: str, req: UpdateProjectRequest):
    data = storage.read_json(storage.project_json_path(project_id))
    if not data:
        raise HTTPException(status_code=404, detail="Project not found")

    updates = req.model_dump(exclude_none=True)
    if "paths" in updates:
        updates["paths"] = [p if isinstance(p, dict) else p.model_dump() for p in updates["paths"]]
    data.update(updates)
    storage.write_json(storage.project_json_path(project_id), data)
    return data


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    path = storage.project_dir(project_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    storage.delete_path(path)
    return {"deleted": True}
