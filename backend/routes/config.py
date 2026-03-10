from __future__ import annotations

import asyncio
import os
import shutil
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

import anthropic
import storage

router = APIRouter()

DEFAULT_CONFIG = {
    "anthropic_api_key": "",
    "default_model": "claude-sonnet-4-6",
    "complex_model": "claude-opus-4-6",
    "auth_mode": "",  # "cli" or "api_key"
}


class UpdateConfigRequest(BaseModel):
    anthropic_api_key: Optional[str] = None
    default_model: Optional[str] = None
    complex_model: Optional[str] = None
    auth_mode: Optional[str] = None


def get_config() -> dict:
    config = storage.read_json(storage.config_path())
    if config is None:
        config = DEFAULT_CONFIG.copy()
        env_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if env_key:
            config["anthropic_api_key"] = env_key
            config["auth_mode"] = "api_key"
        storage.write_json(storage.config_path(), config)
    return config


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) > 12:
        return key[:8] + "..." + key[-4:]
    return "***"


def _check_cli_available() -> bool:
    """Check if Claude Code CLI is available."""
    npx = shutil.which("npx")
    if not npx:
        for path in ["/usr/local/bin/npx", "/opt/homebrew/bin/npx"]:
            if os.path.isfile(path):
                return True
    return npx is not None


def _masked_config(config: dict) -> dict:
    masked = config.copy()
    masked["anthropic_api_key"] = _mask_key(masked.get("anthropic_api_key", ""))
    masked["has_api_key"] = bool(config.get("anthropic_api_key"))
    masked["cli_available"] = _check_cli_available()
    masked["authenticated"] = bool(config.get("auth_mode"))
    return masked


@router.get("")
async def read_config():
    config = get_config()
    return _masked_config(config)


@router.put("")
async def update_config(req: UpdateConfigRequest):
    config = get_config()
    updates = req.model_dump(exclude_none=True)
    config.update(updates)
    storage.write_json(storage.config_path(), config)
    return _masked_config(config)


@router.post("/validate-key")
async def validate_key(req: UpdateConfigRequest):
    """Validate an API key by making a test call to Anthropic."""
    key = req.anthropic_api_key
    if not key:
        return {"valid": False, "error": "No API key provided"}

    try:
        client = anthropic.Anthropic(api_key=key)
        client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=10,
            messages=[{"role": "user", "content": "hi"}],
        )
        config = get_config()
        config["anthropic_api_key"] = key
        config["auth_mode"] = "api_key"
        storage.write_json(storage.config_path(), config)
        return {"valid": True}
    except anthropic.AuthenticationError:
        return {"valid": False, "error": "Invalid API key"}
    except Exception as e:
        return {"valid": False, "error": str(e)}


def _get_node_env() -> dict:
    """Get environment with node/npx in PATH, safe for spawning Claude Code."""
    env = os.environ.copy()
    extra_paths = ["/usr/local/bin", "/opt/homebrew/bin"]
    current_path = env.get("PATH", "")
    env["PATH"] = ":".join(extra_paths) + ":" + current_path
    for var in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"]:
        env.pop(var, None)
    return env


def _find_npx() -> Optional[str]:
    for path in ["/usr/local/bin/npx", "/opt/homebrew/bin/npx"]:
        if os.path.isfile(path):
            return path
    return shutil.which("npx")


@router.post("/auth-cli")
async def auth_with_cli():
    """Authenticate using Claude Code CLI (existing subscription)."""
    npx = _find_npx()
    if not npx:
        return {"valid": False, "error": "npx not found. Install Node.js first."}

    try:
        proc = await asyncio.create_subprocess_exec(
            npx, "-y", "@anthropic-ai/claude-code",
            "--print", "say hi in 3 words",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_get_node_env(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

        if proc.returncode == 0:
            config = get_config()
            config["auth_mode"] = "cli"
            storage.write_json(storage.config_path(), config)
            return {"valid": True, "output": stdout.decode().strip()[:100]}
        else:
            err = stderr.decode().strip()
            return {"valid": False, "error": err[:200] or "Claude Code CLI failed"}

    except asyncio.TimeoutError:
        return {"valid": False, "error": "Timed out. Make sure you're logged into Claude Code."}
    except Exception as e:
        return {"valid": False, "error": str(e)}
