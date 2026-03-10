"""File browsing routes."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query

router = APIRouter()


@router.get("/browse")
async def browse_directories(path: Optional[str] = Query(None)):
    """List directories at a given path for folder picker UI."""
    if not path:
        path = str(Path.home())

    p = Path(path)
    if not p.is_dir():
        return {"path": path, "dirs": [], "error": "Not a directory"}

    dirs = []
    try:
        for item in sorted(p.iterdir()):
            if item.name.startswith("."):
                continue
            if item.is_dir():
                dirs.append({
                    "name": item.name,
                    "path": str(item),
                })
    except PermissionError:
        return {"path": path, "dirs": [], "error": "Permission denied"}

    parent = str(p.parent) if p.parent != p else None

    return {
        "path": str(p),
        "parent": parent,
        "dirs": dirs,
    }
