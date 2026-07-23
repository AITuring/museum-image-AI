import unittest
from datetime import date

from app.exhibition_source import (
    parse_city_regions,
    parse_date_range,
    parse_exhibition_detail,
    parse_sitemap_event_urls,
)


class ExhibitionSourceTests(unittest.TestCase):
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
              <tr><td class="title">展厅</td><td>测试美术馆</td></tr>
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
        self.assertEqual(parsed.venue, "测试美术馆")
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


if __name__ == "__main__":
    unittest.main()
