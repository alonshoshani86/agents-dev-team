"""Agent routes: list agents, ad-hoc chat with streaming."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import storage
from agents.registry import list_agents, create_runner, get_agent_config, save_agent_config, AGENT_NAMES

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    context: Optional[str] = None


class UpdateAgentConfigRequest(BaseModel):
    system_prompt: Optional[str] = None
    model: Optional[str] = None
    display_name: Optional[str] = None


@router.get("/projects/{project_id}/agents")
async def get_agents(project_id: str):
    project = storage.read_json(storage.project_json_path(project_id))
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return list_agents(project_id)


@router.get("/projects/{project_id}/agents/{agent_name}")
async def get_agent(project_id: str, agent_name: str):
    if agent_name not in AGENT_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name}")
    project = storage.read_json(storage.project_json_path(project_id))
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return get_agent_config(project_id, agent_name)


@router.put("/projects/{project_id}/agents/{agent_name}")
async def update_agent(project_id: str, agent_name: str, req: UpdateAgentConfigRequest):
    if agent_name not in AGENT_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name}")
    project = storage.read_json(storage.project_json_path(project_id))
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    overrides = req.model_dump(exclude_none=True)
    save_agent_config(project_id, agent_name, overrides)
    return get_agent_config(project_id, agent_name)


@router.post("/projects/{project_id}/agents/{agent_name}/chat")
async def chat_with_agent(project_id: str, agent_name: str, req: ChatRequest):
    if agent_name not in AGENT_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name}")
    project = storage.read_json(storage.project_json_path(project_id))
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    runner = create_runner(project_id, agent_name)

    async def generate():
        async for chunk in runner.stream(req.message, context=req.context):
            yield chunk

    return StreamingResponse(generate(), media_type="text/plain")
