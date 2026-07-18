from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from fractions import Fraction
from io import BytesIO
from typing import BinaryIO

from PIL import Image, ImageOps
from PIL.TiffImagePlugin import IFDRational

TAG_IMAGE_DESCRIPTION = 270
TAG_MODEL = 272
TAG_SOFTWARE = 305
TAG_EXIF_IFD = 34665
TAG_GPS_IFD = 34853
TAG_XP_TITLE = 40091
TAG_XP_COMMENT = 40092
TAG_XP_SUBJECT = 40095

EXIF_EXPOSURE_TIME = 33434
EXIF_FNUMBER = 33437
EXIF_ISO = 34855
EXIF_DATETIME_DIGITIZED = 36868
EXIF_DATETIME_ORIGINAL = 36867
EXIF_LENS_MODEL = 42036

GPS_LATITUDE_REF = 1
GPS_LATITUDE = 2
GPS_LONGITUDE_REF = 3
GPS_LONGITUDE = 4
GPS_VERSION_ID = 0


@dataclass
class ImageExifData:
    camera_model: str | None = None
    lens_model: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None
    shutter_speed: str | None = None
    aperture: str | None = None
    iso: int | None = None
    edit_method: str | None = None

    def as_dict(self) -> dict[str, object | None]:
        return asdict(self)


def image_content_fingerprint(image_bytes: bytes) -> str | None:
    """Return a perceptual fingerprint that stays stable across EXIF rewrites."""
    if not image_bytes:
        return None
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            normalized = ImageOps.exif_transpose(image).convert("L").resize(
                (17, 16), Image.Resampling.LANCZOS
            )
            pixels = list(normalized.getdata())
            bits = 0
            for row in range(16):
                offset = row * 17
                for column in range(16):
                    bits = (bits << 1) | int(
                        pixels[offset + column] > pixels[offset + column + 1]
                    )
            return f"{bits:064x}"
    except Exception:
        return None


def fingerprint_distance(left: str | None, right: str | None) -> int | None:
    if not left or not right or len(left) != len(right):
        return None
    try:
        return (int(left, 16) ^ int(right, 16)).bit_count()
    except ValueError:
        return None


def _clean_text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="ignore")
    text = str(value).strip()
    return text or None


def _to_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        pass
    if isinstance(value, (tuple, list)) and len(value) == 2:
        numerator, denominator = value
        try:
            denominator_value = float(denominator)
            if denominator_value == 0:
                return None
            return float(numerator) / denominator_value
        except (TypeError, ValueError, ZeroDivisionError):
            return None
    return None


def _format_shutter_speed(value: object) -> str | None:
    seconds = _to_float(value)
    if seconds is None or seconds <= 0:
        return None
    if seconds >= 1:
        rounded = round(seconds, 2)
        text = f"{rounded:.2f}".rstrip("0").rstrip(".")
        return f"{text}s"
    fraction = Fraction(seconds).limit_denominator(8000)
    if fraction.numerator == 1:
        return f"1/{fraction.denominator}s"
    return f"{fraction.numerator}/{fraction.denominator}s"


def _format_aperture(value: object) -> str | None:
    aperture_value = _to_float(value)
    if aperture_value is None or aperture_value <= 0:
        return None
    text = f"{aperture_value:.1f}".rstrip("0").rstrip(".")
    return f"f/{text}"


def _gps_to_decimal(coords: object, ref: object) -> float | None:
    if not isinstance(coords, (tuple, list)) or len(coords) != 3:
        return None
    degrees = _to_float(coords[0])
    minutes = _to_float(coords[1])
    seconds = _to_float(coords[2])
    if degrees is None or minutes is None or seconds is None:
        return None
    decimal = degrees + (minutes / 60.0) + (seconds / 3600.0)
    ref_text = (_clean_text(ref) or "").upper()
    if ref_text in {"S", "W"}:
        decimal *= -1
    return round(decimal, 6)


def _parse_exif_datetime(value: object) -> datetime | None:
    text = _clean_text(value)
    if not text:
        return None
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _encode_xp_text(value: str | None) -> bytes | None:
    text = _clean_text(value)
    if not text:
        return None
    return f"{text}\x00".encode("utf-16le")


def _decimal_to_gps_rational(value: float) -> tuple[IFDRational, IFDRational, IFDRational]:
    absolute = abs(float(value))
    degrees = int(absolute)
    minutes_float = (absolute - degrees) * 60
    minutes = int(minutes_float)
    seconds = round((minutes_float - minutes) * 60 * 1_000_000)
    # Pillow's EXIF writer requires IFDRational objects here. Plain (n, d)
    # tuples look valid but cause the whole save to fail, silently leaving the
    # source file untouched in our previous error-safe path.
    return (
        IFDRational(degrees, 1),
        IFDRational(minutes, 1),
        IFDRational(seconds, 1_000_000),
    )


def _compose_subject_text(
    *,
    era: str | None,
    museum_name: str | None,
    place_of_excavation: str | None,
) -> str | None:
    parts = [
        _clean_text(era),
        _clean_text(museum_name),
        _clean_text(place_of_excavation),
    ]
    merged = " | ".join(part for part in parts if part)
    return merged or None


def update_image_exif_metadata(
    image_bytes: bytes,
    *,
    artifact_name: str | None = None,
    description: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    museum_name: str | None = None,
    era: str | None = None,
    place_of_excavation: str | None = None,
    display_location_name: str | None = None,
    software_name: str = "museum-image-AI",
) -> bytes:
    if not image_bytes:
        return image_bytes

    try:
        with Image.open(BytesIO(image_bytes)) as image:
            exif = image.getexif()
            title_text = _clean_text(artifact_name)
            description_text = _clean_text(description)
            subject_text = _compose_subject_text(
                era=era,
                museum_name=museum_name,
                place_of_excavation=place_of_excavation,
            )

            if title_text:
                exif[TAG_IMAGE_DESCRIPTION] = title_text
                xp_title = _encode_xp_text(title_text)
                if xp_title is not None:
                    exif[TAG_XP_TITLE] = xp_title
            else:
                exif.pop(TAG_IMAGE_DESCRIPTION, None)
                exif.pop(TAG_XP_TITLE, None)

            # EXIF has no universal human-readable "exhibition location" field.
            # Keep it together with the catalogue description so exported photos
            # retain the operator-entered place in common photo viewers.
            location_text = _clean_text(display_location_name)
            comment_text = "\n".join(
                item for item in (description_text, f"展出地点：{location_text}" if location_text else None) if item
            ) or None
            if comment_text:
                xp_comment = _encode_xp_text(comment_text)
                if xp_comment is not None:
                    exif[TAG_XP_COMMENT] = xp_comment
            else:
                exif.pop(TAG_XP_COMMENT, None)

            if subject_text:
                xp_subject = _encode_xp_text(subject_text)
                if xp_subject is not None:
                    exif[TAG_XP_SUBJECT] = xp_subject
            else:
                exif.pop(TAG_XP_SUBJECT, None)

            exif[TAG_SOFTWARE] = software_name

            try:
                gps_ifd = dict(exif.get_ifd(TAG_GPS_IFD) or {})
            except Exception:
                gps_ifd = {}

            if latitude is not None and longitude is not None:
                gps_ifd[GPS_VERSION_ID] = b"\x02\x03\x00\x00"
                gps_ifd[GPS_LATITUDE_REF] = "N" if latitude >= 0 else "S"
                gps_ifd[GPS_LATITUDE] = _decimal_to_gps_rational(latitude)
                gps_ifd[GPS_LONGITUDE_REF] = "E" if longitude >= 0 else "W"
                gps_ifd[GPS_LONGITUDE] = _decimal_to_gps_rational(longitude)
                exif[TAG_GPS_IFD] = gps_ifd
            else:
                exif.pop(TAG_GPS_IFD, None)

            output = BytesIO()
            save_kwargs = {
                "format": image.format or "JPEG",
                "exif": exif.tobytes(),
            }
            if image.info.get("icc_profile"):
                save_kwargs["icc_profile"] = image.info["icc_profile"]

            try:
                if (image.format or "").upper() == "JPEG":
                    image.save(
                        output,
                        quality="keep",
                        subsampling="keep",
                        **save_kwargs,
                    )
                else:
                    image.save(output, **save_kwargs)
            except Exception:
                output = BytesIO()
                fallback_kwargs = dict(save_kwargs)
                if (image.format or "").upper() == "JPEG":
                    image.save(output, quality=95, subsampling=0, **fallback_kwargs)
                else:
                    image.save(output, **fallback_kwargs)

            return output.getvalue()
    except Exception:
        return image_bytes


def _extract_exif_metadata_from_image(image: Image.Image) -> ImageExifData:
    exif = image.getexif()
    if not exif:
        return ImageExifData()

    try:
        exif_ifd = exif.get_ifd(TAG_EXIF_IFD)
    except Exception:
        exif_ifd = {}

    try:
        gps_ifd = exif.get_ifd(TAG_GPS_IFD)
    except Exception:
        gps_ifd = {}

    iso_value = exif_ifd.get(EXIF_ISO) if isinstance(exif_ifd, dict) else None
    if iso_value is None:
        iso_value = exif.get(EXIF_ISO)

    return ImageExifData(
        camera_model=_clean_text(exif.get(TAG_MODEL)),
        lens_model=_clean_text(
            exif_ifd.get(EXIF_LENS_MODEL) if isinstance(exif_ifd, dict) else None
        ),
        latitude=_gps_to_decimal(
            gps_ifd.get(GPS_LATITUDE) if isinstance(gps_ifd, dict) else None,
            gps_ifd.get(GPS_LATITUDE_REF) if isinstance(gps_ifd, dict) else None,
        ),
        longitude=_gps_to_decimal(
            gps_ifd.get(GPS_LONGITUDE) if isinstance(gps_ifd, dict) else None,
            gps_ifd.get(GPS_LONGITUDE_REF) if isinstance(gps_ifd, dict) else None,
        ),
        captured_at=_parse_exif_datetime(
            (exif_ifd.get(EXIF_DATETIME_ORIGINAL) if isinstance(exif_ifd, dict) else None)
            or (exif_ifd.get(EXIF_DATETIME_DIGITIZED) if isinstance(exif_ifd, dict) else None)
            or exif.get(EXIF_DATETIME_ORIGINAL)
            or exif.get(EXIF_DATETIME_DIGITIZED)
        ),
        shutter_speed=_format_shutter_speed(
            exif_ifd.get(EXIF_EXPOSURE_TIME) if isinstance(exif_ifd, dict) else None
        ),
        aperture=_format_aperture(
            exif_ifd.get(EXIF_FNUMBER) if isinstance(exif_ifd, dict) else None
        ),
        iso=int(iso_value) if iso_value is not None else None,
    )


def extract_exif_metadata(image_bytes: bytes) -> ImageExifData:
    if not image_bytes:
        return ImageExifData()
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            return _extract_exif_metadata_from_image(image)
    except Exception:
        return ImageExifData()


def extract_exif_and_preview_from_file(
    image_file: BinaryIO,
    *,
    preview_max_edge: int = 640,
) -> tuple[ImageExifData, bytes | None]:
    """Read EXIF and a compact JPEG preview without copying the original file."""
    try:
        image_file.seek(0)
        with Image.open(image_file) as image:
            metadata = _extract_exif_metadata_from_image(image)
            preview = ImageOps.exif_transpose(image)
            preview.thumbnail((preview_max_edge, preview_max_edge), Image.Resampling.LANCZOS)
            if preview.mode not in {"RGB", "L"}:
                background = Image.new("RGB", preview.size, "white")
                if "A" in preview.getbands():
                    background.paste(preview, mask=preview.getchannel("A"))
                else:
                    background.paste(preview.convert("RGB"))
                preview = background
            elif preview.mode == "L":
                preview = preview.convert("RGB")
            output = BytesIO()
            preview.save(output, format="JPEG", quality=82, optimize=True)
            return metadata, output.getvalue()
    except Exception:
        return ImageExifData(), None
    finally:
        try:
            image_file.seek(0)
        except Exception:
            pass
