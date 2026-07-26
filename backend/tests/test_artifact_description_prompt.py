import unittest
from pathlib import Path

from app.vision import VisionProvider, build_artifact_description_payload


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
        )

        user_content = payload["messages"][1]["content"]  # type: ignore[index]
        self.assertEqual(len(user_content), 1)
        self.assertEqual(user_content[0]["type"], "text")
        self.assertNotIn("image_url", str(user_content))
        self.assertIn("测试文物", user_content[0]["text"])
        self.assertIn("不包含图片", user_content[0]["text"])
        self.assertEqual(payload["max_tokens"], 4096)


if __name__ == "__main__":
    unittest.main()
