from typing import Protocol

from app.artifact_research.schemas import (
    ArtifactResearchQuery,
    ArtifactResearchSourceRead,
)


class KnowledgeProvider(Protocol):
    """Extension point for a future PDF/vector knowledge-base implementation."""

    async def search(
        self,
        query: ArtifactResearchQuery,
        *,
        top_k: int,
    ) -> list[ArtifactResearchSourceRead]: ...

    def revision(self) -> str: ...

    def enabled(self) -> bool: ...


class DisabledKnowledgeProvider:
    """Current no-op provider. Keeps the Agent contract stable until KB development."""

    async def search(
        self,
        query: ArtifactResearchQuery,
        *,
        top_k: int,
    ) -> list[ArtifactResearchSourceRead]:
        return []

    def revision(self) -> str:
        return "knowledge-disabled"

    def enabled(self) -> bool:
        return False


knowledge_provider: KnowledgeProvider = DisabledKnowledgeProvider()
