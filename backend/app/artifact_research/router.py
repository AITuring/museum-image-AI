from fastapi import APIRouter, HTTPException

from app.artifact_research.agent import (
    get_artifact_research,
    run_artifact_research,
)
from app.artifact_research.knowledge import knowledge_provider
from app.artifact_research.schemas import (
    ArtifactResearchRead,
    ArtifactResearchRequest,
)
from app.config import settings

router = APIRouter(prefix="/artifact-research", tags=["artifact-research"])


@router.get("/status")
def artifact_research_status() -> dict[str, object]:
    return {
        "status": "ready",
        "agent_version": settings.artifact_research_agent_version,
        "knowledge_provider": knowledge_provider.revision(),
        "knowledge_base_enabled": knowledge_provider.enabled(),
    }


@router.post("/run", response_model=ArtifactResearchRead)
async def run_artifact_research_api(
    request: ArtifactResearchRequest,
) -> ArtifactResearchRead:
    return await run_artifact_research(request)


@router.get("/{research_id}", response_model=ArtifactResearchRead)
def get_artifact_research_api(research_id: str) -> ArtifactResearchRead:
    result = get_artifact_research(research_id)
    if result is None:
        raise HTTPException(status_code=404, detail="未找到对应的文物研究记录。")
    return result
