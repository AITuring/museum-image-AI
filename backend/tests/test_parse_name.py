import unittest

from app import main


class ParseArtifactNameTests(unittest.TestCase):
    def test_normalizes_museum_segment_with_trailing_cang(self) -> None:
        parsed = main.parse_artifact_compound_name("魏晋-白玉螭纹鸡心佩-故宫博物院藏-DSC08876.jpg")

        self.assertEqual(parsed.museum_name, "故宫博物院")

    def test_normalizes_museum_segment_with_guancang(self) -> None:
        parsed = main.parse_artifact_compound_name("隋-夫妇宴享行乐图-山东省博物馆藏-DSC03961.jpg")

        self.assertEqual(parsed.museum_name, "山东省博物馆")
        self.assertEqual(parsed.era, "隋")
        self.assertTrue(parsed.normalized_name.startswith("隋-"))

    def test_preserves_an_explicit_era_suffix(self) -> None:
        parsed = main.parse_artifact_compound_name("隋代-夫妇宴享行乐图-山东省博物馆藏.jpg")

        self.assertEqual(parsed.era, "隋代")
        self.assertTrue(parsed.normalized_name.startswith("隋代-"))

    def test_tomb_mural_title_is_not_mistaken_for_excavation_place(self) -> None:
        parsed = main.parse_artifact_compound_name(
            "唐-韩休墓北壁《山水图》-2013年线少陵原唐韩休墓出土-陕西历史博物馆藏-未标题-215.jpg"
        )

        self.assertEqual(parsed.era, "唐")
        self.assertEqual(parsed.artifact_name, "韩休墓北壁《山水图》")
        self.assertEqual(parsed.Place_of_Excavation, "2013年线少陵原唐韩休墓出土")
        self.assertEqual(parsed.museum_name, "陕西历史博物馆")


if __name__ == "__main__":
    unittest.main()
