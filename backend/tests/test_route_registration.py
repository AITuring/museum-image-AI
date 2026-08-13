import unittest

from app.main import app


class RouteRegistrationTests(unittest.TestCase):
    def test_critical_routes_remain_registered_after_modularization(self) -> None:
        routes = {
            (method, route.path)
            for route in app.routes
            for method in getattr(route, "methods", set())
        }
        expected = {
            ("GET", "/api/health"),
            ("GET", "/api/map-tiles/{zoom}/{x}/{y}.png"),
            ("GET", "/api/web-bridge/status"),
            ("POST", "/api/vision/analyze"),
            ("POST", "/api/uploads/images"),
            ("POST", "/api/ingest/artifacts"),
            ("POST", "/api/artifacts/submit-cloud"),
            ("POST", "/api/artifacts/submit-cloud-file"),
            ("GET", "/api/artifacts/parse-name"),
            ("POST", "/api/artifacts/prepare-exif-file"),
            ("POST", "/api/artifacts/extract-exif-file"),
            ("POST", "/api/artifacts/exif-submit-file"),
            ("POST", "/api/batch/scan"),
            ("POST", "/api/batch/scan-files"),
            ("POST", "/api/batch/identify/stream"),
            ("GET", "/api/google-photos/status"),
            ("POST", "/api/google-photos/import"),
            ("GET", "/api/exhibition-catalog"),
            ("GET", "/api/museum-directory"),
            ("GET", "/api/museums"),
            ("GET", "/api/artifacts"),
            ("GET", "/api/artifact-images/by-source-hash"),
        }

        self.assertEqual(expected - routes, set())


if __name__ == "__main__":
    unittest.main()
