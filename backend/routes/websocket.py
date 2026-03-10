"""WebSocket routes for real-time agent streaming and events."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Dict, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import storage
from agents.registry import create_runner, AGENT_NAMES

router = APIRouter()

# Track active connections per project
connections: Dict[str, Set[WebSocket]] = {}


async def broadcast(project_id: str, event: dict):
    """Broadcast an event to all connections for a project."""
    if project_id in connections:
        dead = set()
        for ws in connections[project_id]:
            try:
                await ws.send_json(event)
            except Exception:
                dead.add(ws)
        connections[project_id] -= dead


def extract_tool_calls(text: str):
    """Extract tool call blocks from agent response.

    Agents can propose actions using XML-like tags:
    <tool type="write_file" path="src/main.py">content</tool>
    <tool type="run_command">npm install</tool>
    <tool type="edit_file" path="src/app.tsx">diff content</tool>
    <tool type="delete_file" path="old_file.py" />
    """
    tools = []
    pattern = r'<tool\s+type="([^"]+)"(?:\s+path="([^"]*)")?(?:\s*/>|>(.*?)</tool>)'
    for match in re.finditer(pattern, text, re.DOTALL):
        action_type = match.group(1)
        path = match.group(2) or ""
        content = (match.group(3) or "").strip()

        tool_id = storage.generate_id()
        details = {}
        description = ""

        if action_type == "write_file":
            details = {"path": path, "content": content}
            description = f"Create file: {path}"
        elif action_type == "edit_file":
            details = {"path": path, "diff": content}
            description = f"Edit file: {path}"
        elif action_type == "run_command":
            details = {"command": content}
            description = f"Run: {content}"
        elif action_type == "delete_file":
            details = {"path": path}
            description = f"Delete: {path}"

        tools.append({
            "id": tool_id,
            "action_type": action_type,
            "description": description,
            "details": details,
            "raw": match.group(0),
        })

    return tools


def strip_tool_tags(text: str) -> str:
    """Remove tool XML tags from text to show clean output."""
    return re.sub(r'<tool\s+[^>]*(?:/>|>.*?</tool>)', '', text, flags=re.DOTALL).strip()


async def execute_tool(project_id: str, tool: dict) -> dict:
    """Execute an approved tool action."""
    action_type = tool["action_type"]
    details = tool["details"]

    try:
        if action_type == "write_file":
            file_path = storage.project_files_dir(project_id) / details["path"]
            storage.write_text_file(file_path, details["content"])
            return {"success": True, "output": f"Created {details['path']}"}

        elif action_type == "edit_file":
            file_path = storage.project_files_dir(project_id) / details["path"]
            # For now, overwrite with the diff content (could do proper patching later)
            if file_path.exists():
                storage.write_text_file(file_path, details.get("diff", ""))
                return {"success": True, "output": f"Updated {details['path']}"}
            return {"success": False, "output": f"File not found: {details['path']}"}

        elif action_type == "run_command":
            proc = await asyncio.create_subprocess_shell(
                details["command"],
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(storage.project_files_dir(project_id)),
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            output = stdout.decode() + stderr.decode()
            return {
                "success": proc.returncode == 0,
                "output": output[:2000] if output else f"Exit code: {proc.returncode}",
            }

        elif action_type == "delete_file":
            file_path = storage.project_files_dir(project_id) / details["path"]
            if file_path.exists():
                storage.delete_path(file_path)
                return {"success": True, "output": f"Deleted {details['path']}"}
            return {"success": False, "output": f"File not found: {details['path']}"}

        return {"success": False, "output": f"Unknown action: {action_type}"}

    except Exception as e:
        return {"success": False, "output": str(e)}


@router.websocket("/projects/{project_id}/events")
async def project_events(websocket: WebSocket, project_id: str):
    """Global event stream for a project."""
    await websocket.accept()

    if project_id not in connections:
        connections[project_id] = set()
    connections[project_id].add(websocket)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connections[project_id].discard(websocket)


@router.websocket("/projects/{project_id}/agents/{agent_name}/stream")
async def agent_stream(websocket: WebSocket, project_id: str, agent_name: str):
    """Stream agent responses via WebSocket with tool approval flow."""
    await websocket.accept()

    if agent_name not in AGENT_NAMES:
        await websocket.send_json({"type": "error", "content": f"Unknown agent: {agent_name}"})
        await websocket.close()
        return

    project = storage.read_json(storage.project_json_path(project_id))
    if not project:
        await websocket.send_json({"type": "error", "content": "Project not found"})
        await websocket.close()
        return

    # Pending tool calls waiting for approval
    pending_tools: Dict[str, dict] = {}

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type", "message")

            # Handle tool approval/denial
            if msg_type == "tool_approve":
                tool_id = msg.get("id")
                if tool_id in pending_tools:
                    tool = pending_tools.pop(tool_id)
                    result = await execute_tool(project_id, tool)
                    await websocket.send_json({
                        "type": "tool_result",
                        "action_type": tool["action_type"],
                        **result,
                    })
                continue

            if msg_type == "tool_deny":
                tool_id = msg.get("id")
                pending_tools.pop(tool_id, None)
                await websocket.send_json({
                    "type": "tool_result",
                    "action_type": "denied",
                    "success": False,
                    "output": "Action denied by user.",
                })
                continue

            # Handle chat message
            user_message = msg.get("message", "")
            if not user_message:
                await websocket.send_json({"type": "error", "content": "No message provided"})
                continue

            await websocket.send_json({"type": "start", "agent": agent_name})

            await broadcast(project_id, {
                "type": "agent_status",
                "agent": agent_name,
                "status": "working",
            })

            try:
                runner = create_runner(project_id, agent_name)
                full_response = ""

                async for chunk in runner.stream(user_message):
                    full_response += chunk
                    await websocket.send_json({"type": "chunk", "content": chunk})

                # Check for tool calls in the response
                tools = extract_tool_calls(full_response)
                if tools:
                    # Send the clean text first, then each tool for approval
                    for tool in tools:
                        pending_tools[tool["id"]] = tool
                        await websocket.send_json({
                            "type": "tool_request",
                            "id": tool["id"],
                            "action_type": tool["action_type"],
                            "description": tool["description"],
                            "details": tool["details"],
                        })

                await websocket.send_json({
                    "type": "done",
                    "agent": agent_name,
                    "content": full_response,
                })

            except Exception as e:
                await websocket.send_json({
                    "type": "error",
                    "content": str(e),
                })

            await broadcast(project_id, {
                "type": "agent_status",
                "agent": agent_name,
                "status": "idle",
            })

    except WebSocketDisconnect:
        pass
