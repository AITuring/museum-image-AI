import unittest
import warnings
from datetime import datetime
from io import BytesIO

from PIL import Image

from app.exif_utils import (
    ImageExifWriteError,
    MUSEUM_IMAGE_WARNING_PIXELS,
    extract_exif_metadata,
    update_image_exif_metadata,
)


def build_jpeg() -> bytes:
    output = BytesIO()
    Image.new("RGB", (32, 24), (180, 140, 90)).save(output, format="JPEG", quality=95)
    return output.getvalue()


class ExifWriteTests(unittest.TestCase):
    def test_allows_185_megapixel_museum_source_without_disabling_guard(self) -> None:
        self.assertEqual(MUSEUM_IMAGE_WARNING_PIXELS, 100_000_000)
        self.assertEqual(Image.MAX_IMAGE_PIXELS, MUSEUM_IMAGE_WARNING_PIXELS)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            Image._decompression_bomb_check((12_335, 14_999))

        with self.assertRaises(Image.DecompressionBombError):
            Image._decompression_bomb_check((20_001, 10_000))

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

    def test_clean_rewrite_rebuilds_exif_and_keeps_requested_fields(self) -> None:
        source = update_image_exif_metadata(
            build_jpeg(),
            artifact_name="旧名称",
            description="旧描述",
            latitude=31.2304,
            longitude=121.4737,
            camera_model="OLD-CAMERA",
        )

        updated = update_image_exif_metadata(
            source,
            artifact_name="散乐图壁画",
            description="兼容模式描述",
            latitude=40.841694,
            longitude=111.76568,
            museum_name="内蒙古博物院",
            era="辽代",
            display_location_name="内蒙古博物院",
            camera_model="ILCE-7RM5",
            reset_existing_exif=True,
            raise_on_error=True,
        )

        metadata = extract_exif_metadata(updated)
        self.assertEqual(metadata.camera_model, "ILCE-7RM5")
        self.assertAlmostEqual(metadata.latitude or 0, 40.841694, places=5)
        self.assertAlmostEqual(metadata.longitude or 0, 111.76568, places=5)

    def test_strict_write_surfaces_decoder_errors(self) -> None:
        with self.assertRaises(ImageExifWriteError):
            update_image_exif_metadata(
                b"not-an-image",
                artifact_name="测试",
                raise_on_error=True,
            )


if __name__ == "__main__":
    unittest.main()
