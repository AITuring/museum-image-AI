import unittest
from io import BytesIO
from unittest.mock import AsyncMock, patch

from app import main
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers


def uploaded_jpeg() -> UploadFile:
    return UploadFile(
        file=BytesIO(b"original-image"),
        filename="artifact.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )


async def submit_file(file: UploadFile):
    return await main.submit_artifact_with_exif_file(
        file=file,
        museum_name="测试博物馆",
        name="测试文物",
        era=None,
        Place_of_Excavation=None,
        description=None,
        tags="[]",
        display_location_name=None,
        exhibition_name="常设",
        catalog_exhibition_source_id=None,
        catalog_exhibition_id=None,
        latitude=31.2,
        longitude=121.5,
        camera_model=None,
        lens_model=None,
        captured_at=None,
        shutter_speed=None,
        aperture=None,
        iso=None,
        existing_artifact_id=None,
        skip_existing_match=False,
        exif_prepared=False,
        source_hash="a" * 64,
    )


class QuickEntryOrderTests(unittest.IsolatedAsyncioTestCase):
    async def test_exif_is_written_and_verified_before_cloud_upload(self) -> None:
        events: list[str] = []

        def write_exif(*args, **kwargs) -> bytes:
            events.append("write_exif")
            return b"edited-image"

        def verify_exif(*args, **kwargs) -> None:
            events.append("verify_exif")

        async def upload(*args, **kwargs):
            events.append("cloud_upload")
            return object()

        with (
            patch.object(main, "update_image_exif_metadata", side_effect=write_exif),
            patch.object(main, "verify_written_gps", side_effect=verify_exif),
            patch.object(
                main,
                "submit_artifact_to_cloud",
                new=AsyncMock(side_effect=upload),
            ),
        ):
            await submit_file(uploaded_jpeg())

        self.assertEqual(events, ["write_exif", "verify_exif", "cloud_upload"])

    async def test_failed_exif_verification_stops_cloud_upload(self) -> None:
        cloud_upload = AsyncMock()

        with (
            patch.object(
                main,
                "update_image_exif_metadata",
                return_value=b"edited-image",
            ),
            patch.object(
                main,
                "verify_written_gps",
                side_effect=HTTPException(status_code=500, detail="verify failed"),
            ),
            patch.object(main, "submit_artifact_to_cloud", new=cloud_upload),
        ):
            with self.assertRaises(HTTPException):
                await submit_file(uploaded_jpeg())

        cloud_upload.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
