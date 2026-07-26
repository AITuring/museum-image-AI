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

    async def test_quick_entry_returns_locatable_field_warning(self) -> None:
        from app import main

        warnings = main.normalize_artifact_field_warnings(
            [{
                "field": "place_of_excavation",
                "label": "出土地点",
                "input_value": "白塔遗址出土",
                "suggested_value": "万部华严经塔遗址出土",
                "reason": "官方资料使用更规范的遗址名称。",
                "source_refs": ["来源1"],
            }],
            artifact_name="测试文物",
            era="辽代",
            museum_name="测试博物馆",
            place_of_excavation="白塔遗址出土",
        )

        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0].field, "place_of_excavation")
        self.assertEqual(warnings[0].input_value, "白塔遗址出土")
        self.assertEqual(warnings[0].suggested_value, "万部华严经塔遗址出土")
        self.assertEqual(warnings[0].source_refs, ["来源1"])

    async def test_legacy_web_verification_markers_become_reviewable_claims(self) -> None:
        from app import main

        description, claims = main.normalize_verified_claims(
            [],
            "灰陶菩萨头像为辽代佛教造像。仅存头部，颈部以下残缺[联网核验]。面容丰润。",
        )

        self.assertEqual(description, "灰陶菩萨头像为辽代佛教造像。面容丰润。")
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0].text, "仅存头部，颈部以下残缺。")
        self.assertEqual(claims[0].source_refs, ["联网核验"])


if __name__ == "__main__":
    unittest.main()
