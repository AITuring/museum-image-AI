import unittest
from datetime import datetime
from io import BytesIO

from PIL import Image

from app.exif_utils import extract_exif_metadata, update_image_exif_metadata


def build_jpeg() -> bytes:
    output = BytesIO()
    Image.new("RGB", (32, 24), (180, 140, 90)).save(output, format="JPEG", quality=95)
    return output.getvalue()


class ExifWriteTests(unittest.TestCase):
    def test_writes_capture_fields_and_gps_into_final_image(self) -> None:
        captured_at = datetime(2026, 7, 19, 13, 32, 16)
        updated = update_image_exif_metadata(
            build_jpeg(),
            artifact_name="鎏金鸳鸯铜戈",
            description="测试描述",
            latitude=38.040616,
            longitude=114.522656,
            museum_name="河北博物院",
            era="西汉",
            display_location_name="河北博物院",
            camera_model="ILCE-7RM5",
            lens_model="FE 24-70mm F2.8 GM II",
            captured_at=captured_at,
            shutter_speed="1/125s",
            aperture="f/2.8",
            iso=400,
        )

        metadata = extract_exif_metadata(updated)
        self.assertEqual(metadata.camera_model, "ILCE-7RM5")
        self.assertEqual(metadata.lens_model, "FE 24-70mm F2.8 GM II")
        self.assertEqual(metadata.captured_at, captured_at)
        self.assertEqual(metadata.shutter_speed, "1/125s")
        self.assertEqual(metadata.aperture, "f/2.8")
        self.assertEqual(metadata.iso, 400)
        self.assertAlmostEqual(metadata.latitude or 0, 38.040616, places=5)
        self.assertAlmostEqual(metadata.longitude or 0, 114.522656, places=5)


if __name__ == "__main__":
    unittest.main()
