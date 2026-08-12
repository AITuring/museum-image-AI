import unittest
from datetime import date

from app.exhibition_source import (
    institution_name_from_permanent_title,
    institution_name_from_room_label,
    is_probable_room_label,
    museum_name_from_source_fields,
    parse_city_regions,
    parse_date_range,
    parse_exhibition_detail,
    parse_sitemap_event_urls,
)


class ExhibitionSourceTests(unittest.TestCase):
    def test_room_labels_are_not_treated_as_museums(self) -> None:
        self.assertTrue(is_probable_room_label("二层临展厅"))
        self.assertTrue(is_probable_room_label("1933老场坊1号楼3楼"))
        self.assertTrue(is_probable_room_label("6、7号馆"))
        self.assertTrue(is_probable_room_label("A馆"))
        self.assertFalse(is_probable_room_label("山西青铜博物馆"))
        self.assertFalse(is_probable_room_label("北京展览馆"))
        self.assertIsNone(
            museum_name_from_source_fields(None, "二层临展厅")
        )
        self.assertEqual(
            museum_name_from_source_fields("二层临展厅", "山西青铜博物馆"),
            "山西青铜博物馆",
        )

    def test_composite_room_labels_recover_only_the_institution(self) -> None:
        self.assertEqual(
            institution_name_from_room_label("上海图书馆第一展厅"),
            "上海图书馆",
        )
        self.assertEqual(
            institution_name_from_room_label("上海图书馆徐家汇藏书楼一楼"),
            "上海图书馆徐家汇藏书楼",
        )
        self.assertEqual(
            museum_name_from_source_fields(None, "嘉德艺术中心（一层展厅）"),
            "嘉德艺术中心",
        )
        self.assertIsNone(
            institution_name_from_room_label("故宫博物院（北院区）")
        )
        self.assertEqual(
            museum_name_from_source_fields(None, "故宫博物院（北院区）"),
            "故宫博物院（北院区）",
        )

    def test_permanent_title_can_recover_a_legacy_missing_institution(self) -> None:
        self.assertEqual(
            institution_name_from_permanent_title(
                "「吉金光华」山西青铜博物馆常设展"
            ),
            "山西青铜博物馆",
        )
        self.assertIsNone(
            institution_name_from_permanent_title("故宫博物院藏器物特展")
        )

    def test_parse_cross_year_chinese_date_range(self) -> None:
        parsed = parse_date_range("2025年12月20日 - 2月8日 10:00 - 18:00")
        self.assertEqual(parsed.start_date, date(2025, 12, 20))
        self.assertEqual(parsed.end_date, date(2026, 2, 8))
        self.assertEqual(parsed.opening_hours, "10:00 - 18:00")

    def test_parse_permanent_exhibition(self) -> None:
        parsed = parse_date_range("常设展")
        self.assertTrue(parsed.is_permanent)
        self.assertIsNone(parsed.start_date)
        self.assertIsNone(parsed.end_date)

    def test_parse_date_range_rejects_implausible_year(self) -> None:
        parsed = parse_date_range("2915年4月15日 - 9月6日")
        self.assertIsNone(parsed.start_date)
        self.assertIsNone(parsed.end_date)

    def test_opening_hours_keep_additional_closure_dates(self) -> None:
        parsed = parse_date_range(
            "2026年10月17日 - 2027年1月24日 10:00 - 18:00 "
            "周一闭馆（10月26日及1月18日除外）12月31日闭馆"
        )
        self.assertEqual(parsed.start_date, date(2026, 10, 17))
        self.assertEqual(parsed.end_date, date(2027, 1, 24))
        self.assertIn("10月26日", parsed.opening_hours or "")
        self.assertIn("12月31日闭馆", parsed.opening_hours or "")

    def test_parse_sitemap_only_keeps_event_urls(self) -> None:
        payload = b"""<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://art.icity.ly/events/abc123</loc></url>
          <url><loc>https://art.icity.ly/museums/xyz789</loc></url>
        </urlset>"""
        self.assertEqual(
            parse_sitemap_event_urls(payload),
            ["https://art.icity.ly/events/abc123"],
        )

    def test_parse_city_region_and_detail(self) -> None:
        index_html = """
        <div class="imsm-cities-menu">
          <h4>中国城市</h4>
          <ul class="cities"><li><a href="/beijing">北京</a></li></ul>
        </div>
        """
        regions = parse_city_regions(index_html)
        self.assertEqual(regions["beijing"], ("中国大陆", "北京"))

        detail_html = """
        <html><head>
          <meta property="og:title" content="测试展览">
          <meta property="og:description" content="一段公开摘要...">
          <meta property="og:image" content="https://example.com/cover.jpg">
        </head><body>
          <ol class="breadcrumb">
            <li><a href="/">每日环球展览</a></li>
            <li><a href="/beijing">北京</a></li>
          </ol>
          <div class="imsm-entry">
            <h1 class="nm">测试展览</h1>
            <table class="info-fields">
              <tr><td class="title">时间</td><td>2026年4月15日 - 9月6日 11:00 - 19:00</td></tr>
              <tr><td class="title">地址</td><td>测试地址</td></tr>
              <tr><td class="title">展馆</td><td>测试美术馆</td></tr>
              <tr><td class="title">展厅</td><td>第一展览厅</td></tr>
              <tr><td class="title">费用</td><td>Free</td></tr>
            </table>
            <div class="content">
              <p>第一段展览简介。<br><br>
              <strong>重点作品</strong><br>
              第二段内容。<br>
              <img src="https://example.com/detail-1.jpg">
              <span class="button_link">预约观展</span>
              </p>
            </div>
          </div>
        </body></html>
        """
        parsed = parse_exhibition_detail(
            detail_html,
            source_url="https://art.icity.ly/events/abc123",
            city_regions=regions,
        )
        self.assertEqual(parsed.title, "测试展览")
        self.assertEqual(parsed.region, "中国大陆")
        self.assertEqual(parsed.city, "北京")
        self.assertEqual(parsed.museum_name, "测试美术馆")
        self.assertEqual(parsed.venue, "第一展览厅")
        self.assertEqual(parsed.start_date, date(2026, 4, 15))
        self.assertEqual(parsed.end_date, date(2026, 9, 6))
        self.assertEqual(parsed.summary, "一段公开摘要")
        self.assertEqual(
            parsed.description,
            "第一段展览简介。\n\n重点作品\n\n第二段内容。",
        )
        self.assertEqual(
            parsed.image_urls,
            ["https://example.com/cover.jpg", "https://example.com/detail-1.jpg"],
        )

    def test_parse_detail_uses_only_venue_as_museum_when_parent_is_missing(self) -> None:
        parsed = parse_exhibition_detail(
            """
            <div class=\"imsm-entry\">
              <h1 class=\"nm\">嘉德展览</h1>
              <table class=\"info-fields\">
                <tr><td class=\"title\">展厅</td><td>嘉德艺术中心（一层展厅）</td></tr>
              </table>
            </div>
            """,
            source_url="https://art.icity.ly/events/ibw8qfk",
            city_regions={},
        )
        self.assertEqual(parsed.museum_name, "嘉德艺术中心")
        self.assertEqual(parsed.venue, "嘉德艺术中心（一层展厅）")


if __name__ == "__main__":
    unittest.main()
