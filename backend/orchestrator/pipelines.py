"""Pipeline definitions: load, list, and manage pipeline templates."""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import storage

DEFAULTS_DIR = Path(__file__).parent / "defaults"


# Default pipeline templates
# Dynamic routing: agents decide who runs next via [NEXT:agent] signals.
# Pipelines just define which agent starts.
DEFAULT_PIPELINES = {
    "full-feature": {
        "id": "full-feature",
        "name": "Full Feature",
        "description": "Start with Product spec — agents route dynamically through architect, dev, test, uxui as needed",
        "start_agent": "product",
    },
    "quick-fix": {
        "id": "quick-fix",
        "name": "Quick Fix",
        "description": "Start with Dev — goes straight to implementation, then test verifies",
        "start_agent": "dev",
    },
    "spec-only": {
        "id": "spec-only",
        "name": "Spec Only",
        "description": "Start with Product spec — agent decides if architect is needed",
        "start_agent": "product",
    },
    "dev-test": {
        "id": "dev-test",
        "name": "Dev + Test",
        "description": "Start with Dev — implementation then testing",
        "start_agent": "dev",
    },
}


def get_pipeline(project_id: str, pipeline_id: str) -> Optional[dict]:
    """Get a pipeline by ID. Check project-specific first, then defaults."""
    # Check project-specific
    project_path = storage.project_pipelines_dir(project_id) / f"{pipeline_id}.json"
    pipeline = storage.read_json(project_path)
    if pipeline:
        return pipeline

    # Check defaults
    return DEFAULT_PIPELINES.get(pipeline_id)


def list_pipelines(project_id: str) -> List[dict]:
    """List all available pipelines (defaults + project-specific)."""
    pipelines = []

    # Add defaults
    for p in DEFAULT_PIPELINES.values():
        pipelines.append(p)

    # Add project-specific (may override defaults)
    pipelines_dir = storage.project_pipelines_dir(project_id)
    if pipelines_dir.exists():
        seen_ids = {p["id"] for p in pipelines}
        for f in pipelines_dir.glob("*.json"):
            p = storage.read_json(f)
            if p and p.get("id") not in seen_ids:
                pipelines.append(p)

    return pipelines


def save_pipeline(project_id: str, pipeline: dict) -> dict:
    """Save a custom pipeline for a project."""
    if "id" not in pipeline:
        pipeline["id"] = storage.generate_id()
    path = storage.project_pipelines_dir(project_id) / f"{pipeline['id']}.json"
    storage.write_json(path, pipeline)
    return pipeline
