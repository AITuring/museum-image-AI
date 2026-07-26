import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from app.artifact_research.agent import prompt_sources
from app.artifact_research.knowledge import DisabledKnowledgeProvider
from app.artifact_research.schemas import (
    ArtifactResearchQuery,
    ArtifactResearchRead,
    ArtifactResearchSourceRead,
)
from app.vision import VisionProvider


class ArtifactResearchAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_knowledge_provider_preserves_extension_contract(self) -> None:
        provider = DisabledKnowledgeProvider()
        query = ArtifactResearchQuery(
            artifact_name="灰陶菩萨头像",
            era="辽代",
            museum_name="内蒙古博物院",
            place_of_excavation="呼和浩特市白塔遗址出土",
        )

        self.assertEqual(await provider.search(query, top_k=8), [])
        self.assertEqual(provider.revision(), "knowledge-disabled")
        self.assertFalse(provider.enabled())

    async def test_prompt_sources_merges_web_and_future_knowledge_evidence(self) -> None:
        result = ArtifactResearchRead(
            research_id="research-id",
            agent_version="artifact-research-v1",
            query=ArtifactResearchQuery(artifact_name="测试文物"),
            web_sources=[
                ArtifactResearchSourceRead(
                    title="博物馆官网",
                    url="https://museum.example/item",
                    snippet="网页证据",
                    source="museum.example",
                )
            ],
            knowledge_sources=[
                ArtifactResearchSourceRead(
                    title="未来专业图录",
                    url="/api/knowledge/document/page",
                    snippet="图录证据",
                    source="knowledge-base",
                    source_type="knowledge",
                    document_id="document-id",
                    page_start=12,
                    page_end=12,
                )
            ],
            research_summary="核验报告",
            created_at=datetime.now(timezone.utc),
        )

        sources = prompt_sources(result)

        self.assertEqual([source.title for source in sources], ["博物馆官网", "未来专业图录"])
        self.assertEqual(sources[1].source, "knowledge-base")

    async def test_quick_entry_uses_agent_record_and_returns_research_id(self) -> None:
        from app import main

        research = ArtifactResearchRead(
            research_id="research-id",
            agent_version="artifact-research-v1",
            query=ArtifactResearchQuery(artifact_name="测试文物"),
            research_summary="Agent 核验报告",
            created_at=datetime.now(timezone.utc),
        )
        provider = VisionProvider(
            name="qwen",
            base_url="https://example.invalid",
            api_key="test-key",
            model="qwen3.7-plus",
        )
        model_results = [
            {
                "provider": provider,
                "result": {
                    "description": "基于 Agent 证据生成的描述",
                    "tags": ["测试标签"],
                    "reasoning": "Agent 证据",
                    "field_warnings": [],
                },
                "research_summary": research.research_summary,
                "search_hits": [],
            }
        ]

        with (
            patch.object(
                main,
                "run_artifact_research",
                new=AsyncMock(return_value=research),
            ) as run_agent,
            patch.object(
                main,
                "generate_artifact_descriptions_parallel",
                new=AsyncMock(return_value=(model_results, [])),
            ) as generate,
        ):
            result = await main.generate_artifact_description_payload(
                image_urls=[],
                museum_name="测试博物馆",
                name="测试文物",
                era="汉代",
                Place_of_Excavation="测试遗址",
            )

        self.assertEqual(result.research_id, "research-id")
        self.assertEqual(result.description, "基于 Agent 证据生成的描述")
        self.assertEqual(run_agent.await_count, 1)
        self.assertEqual(
            generate.await_args.kwargs["research_summary"],
            "Agent 核验报告",
        )


if __name__ == "__main__":
    unittest.main()
