import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.artifact_research.agent import (
    build_artifact_search_queries,
    request_qwen_web_research,
)
from app.artifact_research.schemas import ArtifactResearchQuery
from app.vision import (
    ARTIFACT_DESCRIPTION_SYSTEM_PROMPT,
    SearchHit,
    VisionProvider,
    build_artifact_description_payload,
    generate_artifact_descriptions_parallel,
)


class ArtifactDescriptionPromptTests(unittest.TestCase):
    def test_description_payload_uses_only_structured_fields(self) -> None:
        payload = build_artifact_description_payload(
            VisionProvider(
                name="qwen",
                base_url="https://example.invalid",
                api_key="test-key",
                model="test-model",
            ),
            image_urls=["data:image/jpeg;base64,should-not-be-sent"],
            data_dir=Path("."),
            artifact_name="测试文物",
            era="汉代",
            museum_name="测试博物馆",
            place_of_excavation="测试墓葬出土",
            research_summary="联网核验确认该文物由测试博物馆收藏。",
            search_hits=[
                SearchHit(
                    title="测试博物馆官方藏品页",
                    url="https://museum.example/artifact",
                    snippet="该文物于1982年出土。",
                    source="museum.example",
                )
            ],
        )

        user_content = payload["messages"][1]["content"]  # type: ignore[index]
        self.assertEqual(len(user_content), 1)
        self.assertEqual(user_content[0]["type"], "text")
        self.assertNotIn("image_url", str(user_content))
        self.assertIn("测试文物", user_content[0]["text"])
        self.assertIn("不包含图片", user_content[0]["text"])
        self.assertIn("[来源1] 测试博物馆官方藏品页", user_content[0]["text"])
        self.assertIn("https://museum.example/artifact", user_content[0]["text"])
        self.assertIn("联网核验确认该文物", user_content[0]["text"])
        self.assertEqual(payload["max_tokens"], 4096)
        self.assertIn("禁止 Markdown 标题", ARTIFACT_DESCRIPTION_SYSTEM_PROMPT)
        self.assertIn("350-700字", ARTIFACT_DESCRIPTION_SYSTEM_PROMPT)
        self.assertIn('"field": "artifact_name | era | museum_name | place_of_excavation"', ARTIFACT_DESCRIPTION_SYSTEM_PROMPT)
        self.assertIn('"verified_claims"', ARTIFACT_DESCRIPTION_SYSTEM_PROMPT)
        self.assertIn("description 不得重复这些事实", ARTIFACT_DESCRIPTION_SYSTEM_PROMPT)
        self.assertIn("不等于反证", ARTIFACT_DESCRIPTION_SYSTEM_PROMPT)
        self.assertIn("不得捏造来源编号", ARTIFACT_DESCRIPTION_SYSTEM_PROMPT)

    def test_description_search_queries_cover_identity_and_detail_checks(self) -> None:
        queries = build_artifact_search_queries(
            ArtifactResearchQuery(
                artifact_name="灰陶菩萨头像",
                era="辽代",
                museum_name="内蒙古博物院",
                place_of_excavation="呼和浩特市白塔遗址出土",
            )
        )

        self.assertTrue(any("灰陶菩萨头像" in query and "白塔遗址" in query for query in queries))
        self.assertTrue(any("尺寸" in query and "文物等级" in query for query in queries))
        self.assertTrue(any("内蒙古博物院" in query and "藏品" in query for query in queries))


class ArtifactResearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_qwen_research_enables_web_search(self) -> None:
        provider = VisionProvider(
            name="qwen",
            base_url="https://example.invalid",
            api_key="test-key",
            model="qwen3.7-plus",
        )
        response = {"choices": [{"message": {"content": "联网核验结果"}}]}

        with (
            patch(
                "app.artifact_research.agent.get_description_providers",
                return_value=([provider], []),
            ),
            patch(
                "app.artifact_research.agent.request_chat_completion",
                new=AsyncMock(return_value=response),
            ) as request,
        ):
            result = await request_qwen_web_research(
                ArtifactResearchQuery(
                    artifact_name="灰陶菩萨头像",
                    era="辽代",
                    museum_name="内蒙古博物院",
                    place_of_excavation="呼和浩特市白塔遗址出土",
                )
            )

        self.assertIn("## 身份与馆藏核验", result)
        self.assertIn("## 细节与出土信息核验", result)
        self.assertEqual(request.await_count, 2)
        for call in request.await_args_list:
            payload = call.args[1]
            self.assertIs(payload["enable_search"], True)
            self.assertEqual(payload["search_options"]["search_strategy"], "max")

    async def test_description_generation_consumes_agent_evidence(self) -> None:
        provider = VisionProvider(
            name="qwen",
            base_url="https://example.invalid",
            api_key="test-key",
            model="qwen3.7-plus",
        )
        source = SearchHit(
            title="Agent 来源",
            url="https://museum.example/item",
            snippet="可核验证据",
            source="museum.example",
        )
        generated = {
            "provider": provider,
            "result": {"description": "描述", "tags": []},
            "reasoning": "依据",
        }

        with (
            patch(
                "app.vision.get_description_providers",
                return_value=([provider], []),
            ),
            patch(
                "app.vision.generate_artifact_description_for_provider",
                new=AsyncMock(return_value=generated),
            ) as generate,
        ):
            results, unavailable = await generate_artifact_descriptions_parallel(
                image_urls=[],
                data_dir=Path("."),
                artifact_name="测试文物",
                search_hits=[source],
                research_summary="Agent 核验报告",
            )

        self.assertEqual(results, [generated])
        self.assertEqual(unavailable, [])
        self.assertEqual(generate.await_args.kwargs["search_hits"], [source])
        self.assertEqual(
            generate.await_args.kwargs["research_summary"],
            "Agent 核验报告",
        )


if __name__ == "__main__":
    unittest.main()
