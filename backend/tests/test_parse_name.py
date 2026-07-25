import unittest

from app import main


class ParseArtifactNameTests(unittest.TestCase):
    def test_normalizes_museum_segment_with_trailing_cang(self) -> None:
        parsed = main.parse_artifact_compound_name("魏晋-白玉螭纹鸡心佩-故宫博物院藏-DSC08876.jpg")

        self.assertEqual(parsed.museum_name, "故宫博物院")

    def test_normalizes_museum_segment_with_guancang(self) -> None:
        parsed = main.parse_artifact_compound_name("隋-夫妇宴享行乐图-山东省博物馆藏-DSC03961.jpg")

        self.assertEqual(parsed.museum_name, "山东省博物馆")


if __name__ == "__main__":
    unittest.main()
