import gzip
import html
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from html.parser import HTMLParser
from urllib.parse import urlparse
from xml.etree import ElementTree


SOURCE_BASE_URL = "https://art.icity.ly"
SOURCE_SITEMAP_URL = f"{SOURCE_BASE_URL}/sitemaps/sitemap.xml.gz"
EVENT_URL_PATTERN = re.compile(r"^https://art\.icity\.ly/events/([a-z0-9]+)$")
CHINESE_DATE_PATTERN = re.compile(r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日")
ISO_DATE_PATTERN = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
SPACE_PATTERN = re.compile(r"\s+")
VENUE_DETAIL_SUFFIX_PATTERN = re.compile(r"[（(].*?[）)]")


@dataclass
class HtmlNode:
    tag: str
    attrs: dict[str, str]
    parent: "HtmlNode | None" = None
    children: list["HtmlNode | str"] = field(default_factory=list)

    @property
    def classes(self) -> set[str]:
        return set(self.attrs.get("class", "").split())

    def text(self) -> str:
        parts: list[str] = []

        def collect(node: HtmlNode) -> None:
            for child in node.children:
                if isinstance(child, str):
                    parts.append(child)
                else:
                    collect(child)

        collect(self)
        return SPACE_PATTERN.sub(" ", html.unescape("".join(parts))).strip()

    def descendants(self) -> list["HtmlNode"]:
        result: list[HtmlNode] = []
        for child in self.children:
            if isinstance(child, HtmlNode):
                result.append(child)
                result.extend(child.descendants())
        return result

    def find_all(
        self,
        tag: str | None = None,
        *,
        class_name: str | None = None,
        attr_name: str | None = None,
        attr_value: str | None = None,
    ) -> list["HtmlNode"]:
        matches: list[HtmlNode] = []
        for node in self.descendants():
            if tag is not None and node.tag != tag:
                continue
            if class_name is not None and class_name not in node.classes:
                continue
            if attr_name is not None:
                if attr_name not in node.attrs:
                    continue
                if attr_value is not None and node.attrs[attr_name] != attr_value:
                    continue
            matches.append(node)
        return matches

    def find_first(
        self,
        tag: str | None = None,
        *,
        class_name: str | None = None,
        attr_name: str | None = None,
        attr_value: str | None = None,
    ) -> "HtmlNode | None":
        matches = self.find_all(
            tag,
            class_name=class_name,
            attr_name=attr_name,
            attr_value=attr_value,
        )
        return matches[0] if matches else None


class TreeParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = HtmlNode("document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = HtmlNode(
            tag=tag,
            attrs={key: value or "" for key, value in attrs},
            parent=self.stack[-1],
        )
        self.stack[-1].children.append(node)
        if tag not in self.VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID_TAGS:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


@dataclass(frozen=True)
class ParsedDateRange:
    start_date: date | None
    end_date: date | None
    opening_hours: str | None
    is_permanent: bool


@dataclass(frozen=True)
class ParsedExhibition:
    source_id: str
    source_url: str
    title: str
    region: str
    city: str
    city_slug: str
    museum_name: str | None
    venue: str | None
    address: str | None
    start_date: date | None
    end_date: date | None
    opening_hours: str | None
    fee: str | None
    summary: str | None
    description: str | None
    image_urls: list[str]
    cover_url: str | None
    source_time_text: str | None
    is_permanent: bool


def museum_name_from_source_fields(
    museum_name: str | None,
    venue: str | None,
) -> str | None:
    """Return the parent museum, using a lone venue as the source fallback."""
    primary = (museum_name or "").strip()
    if primary:
        return primary
    fallback = (venue or "").strip()
    if not fallback:
        return None
    # A lone venue such as “嘉德艺术中心（一层展厅）” names both the
    # institution and its room. The catalog needs the institution as its
    # museum label; retain the unmodified value in `venue` separately.
    return VENUE_DETAIL_SUFFIX_PATTERN.sub("", fallback).strip() or fallback


def parse_html(contents: str) -> HtmlNode:
    parser = TreeParser()
    parser.feed(contents)
    parser.close()
    return parser.root


def normalize_region_label(value: str) -> str:
    compact = SPACE_PATTERN.sub(" ", value).strip()
    mapping = {
        "中国城市": "中国大陆",
        "中国 · 港澳台": "中国港澳台",
        "亚洲 · Asia": "亚洲",
        "欧洲 · Europe": "欧洲",
        "美洲 · Americas": "美洲",
        "大洋洲 · Oceania": "大洋洲",
        "非洲 · Africa": "非洲",
    }
    return mapping.get(compact, compact.split(" · ", 1)[0])


def parse_city_regions(contents: str) -> dict[str, tuple[str, str]]:
    root = parse_html(contents)
    menu = root.find_first("div", class_name="imsm-cities-menu")
    if menu is None:
        return {}

    result: dict[str, tuple[str, str]] = {}
    current_region = "其他"
    for child in menu.children:
        if not isinstance(child, HtmlNode):
            continue
        if child.tag == "h4":
            current_region = normalize_region_label(child.text())
            continue
        if child.tag != "ul" or "cities" not in child.classes:
            continue
        for anchor in child.find_all("a"):
            href = anchor.attrs.get("href", "")
            slug = href.strip("/")
            if not slug or "/" in slug:
                continue
            result[slug] = (current_region, anchor.text())
    return result


def parse_sitemap_event_urls(contents: bytes) -> list[str]:
    if contents.startswith(b"\x1f\x8b"):
        contents = gzip.decompress(contents)
    root = ElementTree.fromstring(contents)
    urls: list[str] = []
    for element in root.iter():
        if not element.tag.endswith("loc") or not element.text:
            continue
        url = element.text.strip()
        if EVENT_URL_PATTERN.fullmatch(url):
            urls.append(url)
    return urls


def parse_date_range(value: str | None) -> ParsedDateRange:
    raw = SPACE_PATTERN.sub(" ", value or "").strip()
    if not raw:
        return ParsedDateRange(None, None, None, False)

    is_permanent = "常设" in raw
    matches = list(CHINESE_DATE_PATTERN.finditer(raw))
    parsed_dates: list[date] = []
    previous_year: int | None = None
    for match in matches[:2]:
        year_text, month_text, day_text = match.groups()
        year = int(year_text) if year_text else previous_year
        if year is None:
            continue
        # iMuseum occasionally contains OCR / editorial typos such as 2915.
        # Keeping those years makes the catalog rail unusable, while a missing
        # date can still be represented honestly as an undated exhibition.
        if year < 1900 or year > date.today().year + 1:
            continue
        month = int(month_text)
        day = int(day_text)
        if parsed_dates and not year_text:
            first = parsed_dates[0]
            if (month, day) < (first.month, first.day):
                year += 1
        try:
            parsed_dates.append(date(year, month, day))
            previous_year = year
        except ValueError:
            continue

    consumed_matches = matches[:2]
    if not parsed_dates:
        iso_matches = list(ISO_DATE_PATTERN.finditer(raw))
        consumed_matches = iso_matches[:2]
        for match in consumed_matches:
            try:
                parsed_dates.append(date(*(int(part) for part in match.groups())))
            except ValueError:
                continue

    date_free_parts: list[str] = []
    cursor = 0
    for match in consumed_matches:
        date_free_parts.append(raw[cursor : match.start()])
        date_free_parts.append(" ")
        cursor = match.end()
    date_free_parts.append(raw[cursor:])
    date_free = "".join(date_free_parts)
    date_free = re.sub(r"^\s*[-—–至到起]+\s*", "", date_free)
    date_free = SPACE_PATTERN.sub(" ", date_free).strip(" -—–至到")
    opening_hours = None if not date_free or date_free == "常设展" else date_free

    return ParsedDateRange(
        start_date=parsed_dates[0] if parsed_dates else None,
        end_date=parsed_dates[1] if len(parsed_dates) > 1 else None,
        opening_hours=opening_hours,
        is_permanent=is_permanent,
    )


def _meta_content(root: HtmlNode, property_name: str) -> str | None:
    node = root.find_first("meta", attr_name="property", attr_value=property_name)
    value = node.attrs.get("content", "").strip() if node else ""
    return value or None


def _table_fields(entry: HtmlNode) -> dict[str, str]:
    result: dict[str, str] = {}
    table = entry.find_first("table", class_name="info-fields")
    if table is None:
        return result
    for row in table.find_all("tr"):
        cells = [child for child in row.children if isinstance(child, HtmlNode) and child.tag == "td"]
        if len(cells) >= 2:
            result[cells[0].text()] = cells[1].text()
    return result


def _normalize_image_url(value: str) -> str | None:
    url = value.strip()
    if not url:
        return None
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"{SOURCE_BASE_URL}{url}"
    if url.startswith(("http://", "https://")):
        return url
    return None


def _content_text(content: HtmlNode | None) -> str | None:
    if content is None:
        return None

    blocks: list[str] = []
    current: list[str] = []

    def flush() -> None:
        value = SPACE_PATTERN.sub(" ", html.unescape("".join(current))).strip()
        if (
            value
            and (not blocks or blocks[-1] != value)
        ):
            blocks.append(value)
        current.clear()

    def collect(node: HtmlNode) -> None:
        for child in node.children:
            if isinstance(child, str):
                current.append(child)
                continue
            if child.tag in {"script", "style"} or "button_link" in child.classes:
                continue
            if child.tag == "br":
                flush()
                continue
            is_block = child.tag in {"p", "div", "h2", "h3", "h4", "h5", "h6", "li"}
            if is_block:
                flush()
            collect(child)
            if is_block:
                flush()

    collect(content)
    flush()
    return "\n\n".join(blocks) or None


def parse_exhibition_detail(
    contents: str,
    *,
    source_url: str,
    city_regions: dict[str, tuple[str, str]] | None = None,
) -> ParsedExhibition:
    match = EVENT_URL_PATTERN.fullmatch(source_url)
    if match is None:
        raise ValueError(f"Unsupported exhibition URL: {source_url}")
    source_id = match.group(1)
    root = parse_html(contents)
    entry = root.find_first("div", class_name="imsm-entry")
    if entry is None:
        raise ValueError("Exhibition detail container was not found")

    title_node = entry.find_first("h1", class_name="nm")
    title = title_node.text() if title_node else (_meta_content(root, "og:title") or "")
    if not title:
        raise ValueError("Exhibition title was not found")

    city_slug = ""
    city_name = ""
    breadcrumb = root.find_first("ol", class_name="breadcrumb")
    if breadcrumb is not None:
        for anchor in breadcrumb.find_all("a"):
            path = urlparse(anchor.attrs.get("href", "")).path.strip("/")
            if path and path not in {"world"} and "/" not in path:
                city_slug = path
                city_name = anchor.text()
    city_regions = city_regions or {}
    region, mapped_city = city_regions.get(city_slug, ("其他", city_name or city_slug))
    city_name = mapped_city or city_name or city_slug or "未知地域"

    fields = _table_fields(entry)
    source_time_text = fields.get("时间")
    parsed_range = parse_date_range(source_time_text)

    cover_url = None
    head_image = entry.find_first("img", class_name="fit-width")
    if head_image is not None:
        cover_url = head_image.attrs.get("src", "").strip() or None
    cover_url = cover_url or _meta_content(root, "og:image")
    cover_url = _normalize_image_url(cover_url or "")

    summary = _meta_content(root, "og:description")
    if summary:
        summary = summary.removesuffix("...").strip()

    content = entry.find_first("div", class_name="content")
    description = _content_text(content)
    if not summary and description:
        summary = description[:180].rstrip()

    image_urls: list[str] = []
    for candidate in [
        cover_url,
        *[
            _normalize_image_url(image.attrs.get("src", ""))
            for image in (content.find_all("img") if content is not None else [])
        ],
    ]:
        if candidate and candidate not in image_urls:
            image_urls.append(candidate)

    return ParsedExhibition(
        source_id=source_id,
        source_url=source_url,
        title=title,
        region=region,
        city=city_name,
        city_slug=city_slug or "unknown",
        # Some source pages only expose a `展厅` field for an independent
        # institution (for example 嘉德艺术中心). In that case it is the
        # exhibition's museum / venue, not a sub-gallery number. When `展馆`
        # exists it remains authoritative and `展厅` stays the room detail.
        museum_name=museum_name_from_source_fields(
            fields.get("展馆"), fields.get("展厅")
        ),
        venue=fields.get("展厅"),
        address=fields.get("地址"),
        start_date=parsed_range.start_date,
        end_date=parsed_range.end_date,
        opening_hours=parsed_range.opening_hours,
        fee=fields.get("费用"),
        summary=summary,
        description=description,
        image_urls=image_urls,
        cover_url=cover_url,
        source_time_text=source_time_text,
        is_permanent=parsed_range.is_permanent,
    )


def parse_source_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
