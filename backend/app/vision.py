import asyncio
import base64
import hashlib
import json
import mimetypes
import re
from collections import OrderedDict
from dataclasses import dataclass
from html import unescape
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from app.config import settings
from app.schemas import VisionCandidateRead

VISION_ANALYSIS_SYSTEM_PROMPT = """
你是一名资深文物图像鉴定助手。看图后一次性完成「分析 + 提取检索线索」，只输出 JSON，不要输出额外解释。

观察优先级：
1. 器型、材质、颜色、纹饰、铭文、工艺、破损等视觉特征。
2. 展签、题签、背景文字、器物铭文等可读文字（OCR），这是最高价值证据。
3. 由特征推断器类、年代、用途、文化背景与可能对应的具体文物。
4. 没有证据时不要编造馆藏、出土地或藏品编号。
5. 文件名仅作弱提示；若像相机编号/流水号/截图名则忽略；与图像冲突时以图像为准。

输出 JSON，字段固定：
{
  "analysis": "150-300字自然中文分析，覆盖：总体判断、视觉证据、文字证据、不确定点",
  "artifact_type": "器类或通用定名",
  "material": "材质",
  "motifs": ["纹饰1", "纹饰2"],
  "visible_text": ["图中可见文字1", "图中可见文字2"],
  "era_hint": "时代线索",
  "museum_hint": "馆藏线索",
  "candidates": [
    {"name": "可能的具体文物名", "confidence": 0.0, "evidence": "支持该名称的关键证据"}
  ],
  "search_queries": ["查询1", "查询2", "查询3"]
}

要求：
1. candidates 给出 1-3 个由高到低的判断，并附置信度与证据；证据不足时可只给稳妥器类名（如“鎏金花口盘”）。
2. visible_text 只保留真实看见的文字。
3. search_queries 最多 3 条，组合器类/材质/纹饰/时代/馆藏中的高价值线索，简洁且适合中文网页搜索；不要写入无语义的文件名。
4. 不要为迎合用户而编造事实。
""".strip()

VISION_MATCHING_SYSTEM_PROMPT = """
你是一名文物匹配与录入助手。你将同时看到：
1. 文物图片
2. 相似图检索（以图搜图）结果：直接拿图片像素比对得到的最佳猜测标签、相关实体与匹配网页
3. 第一阶段的图像分析/OCR结果
4. 基于线索检索到的文字网页摘要

你的目标是综合上述证据，判断最可能对应的文物，并输出数据库录入 JSON。

只输出 JSON，不要输出额外解释。字段格式固定为：
{
  "artifact_name": "文物名称",
  "era": "时代",
  "museum_name": "博物馆名称或收藏机构",
  "tags": ["标签1", "标签2"],
  "description": "120-500字详细描述",
  "confidence": 0.0,
  "reasoning": "判断依据"
}

证据优先级（从高到低）：
1. 相似图检索结果（以图搜图命中的文物名/匹配网页）——这是最高优先级证据。当它与图片本身一致时，应优先采信，即使它与你第一眼对材质/年代的主观猜测相矛盾，也要以相似图检索为准来纠正自己的判断。
2. 图中可读文字（展签、铭文 OCR）。
3. 图像视觉特征。
4. 文字网页检索摘要（用于交叉验证与补充背景）。

要求：
1. 若相似图检索给出明确且一致的文物名/出土地/馆藏，请据此确定 artifact_name、era、museum_name，并用其他证据补全 description 与背景。
2. 只有当各类证据彼此支持时，才输出具体文物名称或馆藏单位；若相似图检索为空且其他证据不足，artifact_name 退回到稳妥器类名称。
3. 如果各来源彼此冲突且无法判断，宁可保守，不要编造馆藏、出土地或藏品编号。
4. museum_name、era、artifact_name 的确定性必须一致。
5. reasoning 需要明确说明：哪些来自相似图检索，哪些来自图像，哪些来自 OCR/文字，哪些来自文字检索。
6. tags 返回 3-8 个中文标签，优先输出器类、材质、纹饰、工艺、用途、题材、出土背景、墓葬/遗址背景等信息点；不要把 artifact_name、era、museum_name，或它们的近义改写/重复表达，放进 tags。
7. description 需尽量详细，优先整合以下可证实信息：器物形制、材质、纹饰、工艺、用途、时代背景、馆藏或出土地、出土情况、墓葬情况、遗址情况、流传与研究信息；证据不足的部分可以省略，但不要编造。
""".strip()

ARTIFACT_DESCRIPTION_SYSTEM_PROMPT = """
你是一名严谨的博物馆研究编目员。当前任务不会提供图片，也不要求图像识别。你会收到四项用户输入和一组实时网页检索资料：
- 文物名称
- 时代
- 馆藏单位
- 出土信息

四项输入是待核对的编目线索，不是不可质疑的绝对事实。请优先依据博物馆、政府、考古机构等一手来源进行交叉验证；网页资料不足时，才使用你掌握的稳定公共知识。只输出 JSON：
{
  "reasoning": "500-900字中文证据与核验摘要，使用[来源1]或[联网核验]标明依据",
  "description": "800-1600字中文研究型编目描述",
  "tags": ["10-20个具体中文标签"],
  "field_warnings": ["输入字段与可靠来源不一致时，在此写明原值、建议值和来源编号；没有冲突时返回空数组"]
}

要求：
1. 逐项核对名称、时代、馆藏单位和出土信息。若多个可靠来源与输入一致，可按确认信息使用；若可靠来源明确冲突，不得迁就输入，应在 field_warnings 中说明，但不要直接修改用户表单。
2. description 应使用清晰的分段或中文小标题，并在可靠信息允许的范围内尽量覆盖：
   - 第一段必须是“### 快速概览”，用2-4句话交代身份、时代、材质、出土地、馆藏单位和最值得注意的辨伪/混淆结论；
   - 基本身份、名称含义、文物类别与定名依据；
   - 时代断代、历史背景、文化区域及相关制度或社会语境；
   - 材质、尺寸或尺度特征、器形结构、构图、纹饰、铭文、工艺与制作方法；
   - 原始功能、使用场景、礼仪/宗教/日常用途及象征意义；
   - 出土时间和地点、遗址或墓葬背景、地层与伴出器物；输入不足时明确待核；
   - 收藏、入藏、流传、著录、修复、展览与研究情况；无法确认的具体编号或事件不得虚构；
   - 同类器比较、学术认识、历史价值以及仍存在的争议或待考问题。
3. 具体尺寸、文物等级、发现年份、墓葬编号、入藏编号、人名和文献名等细节，必须由所给网页来源或联网核验报告明确支持；在 description 和 reasoning 中紧邻事实标注[来源N]或[联网核验]。不得捏造来源编号，也不要引用未提供的网页。当“可直接访问的网页资料”为空时，绝对不得使用[来源N]，只能使用[联网核验]。严禁给出没有来源支持的尺寸、重量、年份或数值范围，即使标成“推测”也不可以。
4. 对同名或同出土地的不同藏品保持警惕。来源若指向不同藏馆、不同尺寸或不同文物，应明确说明可能存在同类器混淆，不得把两件文物的信息拼接成一件。
5. “某轮搜索未查到”只代表该轮没有新证据，不等于反证，也不构成字段冲突。若另一份核验报告已经给出正面来源或多来源印证，应保留已核实结论；只有来源明确给出互相排斥的事实时，才能写入 field_warnings。
6. field_warnings 只报告会影响入库字段的实质冲突，例如两个可靠来源分别给出不同馆藏单位、时代或出土地。不要把“缺少尺寸”“没有公开编号”“某轮未搜到”写成字段错误。
7. 不能仅为凑字数重复基础字段，不要使用“具有重要价值”“工艺精湛”等没有事实支撑的套话。优先写这件文物独有的可核验细节，通用时代背景应压缩。
8. reasoning 是展示给人工复核的证据摘要，不是内部思维链。它应逐项说明：哪些内容来自用户输入，哪些由哪条网页资料支持，哪些仅属通行知识或有限推定，哪些仍需查证；同时给出字段一致性结论和来源可靠性判断。
9. tags 返回 10-20 个中文标签，优先覆盖器类、材质、工艺、形制、纹样、题材、用途、文化区域、出土背景、墓葬/遗址背景和学术特征。不要重复文物名称、时代、馆藏单位，也不要生成“文物”“博物馆”“艺术品”等泛标签。
10. 信息完整性优先于文字华丽；有可靠资料时充分展开，没有把握时明确写“待核”或省略，不得把推测包装成事实。
""".strip()

@dataclass
class VisionProvider:
    name: str
    base_url: str
    api_key: str
    model: str


@dataclass
class SearchHit:
    title: str
    url: str
    snippet: str = ""
    source: str | None = None


def format_research_sources(search_hits: list[SearchHit]) -> str:
    if not search_hits:
        return "未检索到可用网页资料。只能使用稳定的公共知识，并应明确标注所有待核信息。"

    lines: list[str] = []
    for index, hit in enumerate(search_hits, start=1):
        lines.append(f"[来源{index}] {hit.title}")
        lines.append(f"[来源{index}] URL：{hit.url}")
        if hit.source:
            lines.append(f"[来源{index}] 网站：{hit.source}")
        if hit.snippet:
            lines.append(f"[来源{index}] 摘要：{hit.snippet}")
    return "\n".join(lines)


@dataclass
class ReverseImageResult:
    """Result of "相似图检索" (reverse image search) on the actual artifact photo."""

    best_guess_labels: list[str]
    web_entities: list[str]
    pages: list[SearchHit]


SEARCH_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/127.0.0.0 Safari/537.36"
)


def get_enabled_providers() -> tuple[list[VisionProvider], list[str]]:
    providers: list[VisionProvider] = []
    unavailable: list[str] = []

    if settings.dashscope_api_key:
        providers.append(
            VisionProvider(
                name="qwen",
                base_url=settings.dashscope_base_url.rstrip("/"),
                api_key=settings.dashscope_api_key,
                model=settings.qwen_vision_model,
            )
        )
    else:
        unavailable.append("qwen")

    if settings.volcengine_api_key:
        providers.append(
            VisionProvider(
                name="doubao",
                base_url=settings.volcengine_base_url.rstrip("/"),
                api_key=settings.volcengine_api_key,
                model=settings.doubao_vision_model,
            )
        )
    else:
        unavailable.append("doubao")

    return providers, unavailable


def get_preferred_text_provider() -> VisionProvider | None:
    if settings.dashscope_api_key:
        return VisionProvider(
            name="qwen",
            base_url=settings.dashscope_base_url.rstrip("/"),
            api_key=settings.dashscope_api_key,
            model=settings.web_structuring_model,
        )

    providers, _ = get_enabled_providers()
    return providers[0] if providers else None


def get_description_providers() -> tuple[list[VisionProvider], list[str]]:
    providers: list[VisionProvider] = []
    unavailable: list[str] = []

    if settings.dashscope_api_key:
        providers.append(
            VisionProvider(
                name="qwen",
                base_url=settings.dashscope_base_url.rstrip("/"),
                api_key=settings.dashscope_api_key,
                model=settings.web_structuring_model,
            )
        )
    else:
        unavailable.append("qwen")

    if settings.volcengine_api_key:
        providers.append(
            VisionProvider(
                name="doubao",
                base_url=settings.volcengine_base_url.rstrip("/"),
                api_key=settings.volcengine_api_key,
                model=settings.doubao_vision_model,
            )
        )
    else:
        unavailable.append("doubao")

    return providers, unavailable


def build_image_payloads(image_urls: list[str], data_dir: Path) -> list[dict[str, object]]:
    payloads: list[dict[str, object]] = []

    for image_url in image_urls:
        payloads.append({"type": "image_url", "image_url": {"url": normalize_image_url(image_url, data_dir)}})

    return payloads


def normalize_image_url(image_url: str, data_dir: Path) -> str:
    if image_url.startswith("http://") or image_url.startswith("https://") or image_url.startswith("data:"):
        return image_url

    if image_url.startswith("/files/"):
        relative_path = image_url.removeprefix("/files/").lstrip("/")
        target_path = data_dir / relative_path
        return file_to_data_url(target_path)

    raise ValueError(f"Unsupported image url: {image_url}")


def file_to_data_url(file_path: Path) -> str:
    downscaled = downscale_image_bytes(file_path)
    if downscaled is not None:
        encoded = base64.b64encode(downscaled).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"

    mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(file_path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def downscale_image_bytes(file_path: Path) -> bytes | None:
    """Downscale a local image to cut image tokens and upload latency.

    Returns JPEG bytes, or None if downscaling is disabled or fails (caller falls
    back to the original file).
    """
    max_dimension = settings.vision_max_image_dimension
    if max_dimension <= 0:
        return None

    try:
        from io import BytesIO

        from PIL import Image

        with Image.open(file_path) as image:
            image = image.convert("RGB")
            longest_side = max(image.size)
            if longest_side > max_dimension:
                scale = max_dimension / longest_side
                new_size = (round(image.size[0] * scale), round(image.size[1] * scale))
                image = image.resize(new_size, Image.LANCZOS)

            buffer = BytesIO()
            image.save(
                buffer,
                format="JPEG",
                quality=settings.vision_image_jpeg_quality,
                optimize=True,
            )
            return buffer.getvalue()
    except Exception:
        return None


def image_url_to_base64(image_url: str, data_dir: Path) -> str | None:
    """Return raw base64 image content for a local/data image, or None for remote URLs."""
    if image_url.startswith("data:"):
        return image_url.split(",", 1)[1] if "," in image_url else None

    if image_url.startswith("http://") or image_url.startswith("https://"):
        return None

    if image_url.startswith("/files/"):
        relative_path = image_url.removeprefix("/files/").lstrip("/")
        target_path = data_dir / relative_path
        downscaled = downscale_image_bytes(target_path)
        if downscaled is not None:
            return base64.b64encode(downscaled).decode("ascii")
        return base64.b64encode(target_path.read_bytes()).decode("ascii")

    return None


def normalize_filename_hint(image_name: str | None) -> str | None:
    if not image_name:
        return None

    stem = Path(image_name).stem.strip()
    if not stem:
        return None

    normalized = stem.lower().replace("-", "").replace("_", "").replace(" ", "")
    camera_prefixes = ("img", "dsc", "pxl", "mvimg", "wechat", "screenshot", "scan", "image")
    if normalized.isalnum() and any(normalized.startswith(prefix) for prefix in camera_prefixes):
        suffix = normalized[3:] if normalized.startswith(("img", "dsc", "pxl")) else normalized
        if suffix.isdigit() or len(suffix) <= 10:
            return None

    digit_ratio = sum(ch.isdigit() for ch in stem) / max(len(stem), 1)
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in stem)
    if not has_cjk and digit_ratio > 0.4:
        return None

    if len(stem) < 4:
        return None

    return stem


def strip_html_tags(content: str) -> str:
    content = re.sub(r"(?is)<script.*?>.*?</script>", " ", content)
    content = re.sub(r"(?is)<style.*?>.*?</style>", " ", content)
    content = re.sub(r"(?s)<[^>]+>", " ", content)
    return " ".join(unescape(content).split())


def extract_meta_content(html_text: str, attr_name: str, attr_value: str) -> str:
    patterns = [
        rf'<meta[^>]+{attr_name}=["\']{re.escape(attr_value)}["\'][^>]+content=["\'](.*?)["\']',
        rf'<meta[^>]+content=["\'](.*?)["\'][^>]+{attr_name}=["\']{re.escape(attr_value)}["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, html_text, flags=re.IGNORECASE | re.DOTALL)
        if match:
            return strip_html_tags(match.group(1))
    return ""


def decode_duckduckgo_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if "duckduckgo.com" not in parsed.netloc:
        return raw_url

    query = parse_qs(parsed.query)
    if "uddg" in query and query["uddg"]:
        return unquote(query["uddg"][0])
    return raw_url


def truncate_text(value: str, limit: int = 320) -> str:
    compact = " ".join(value.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def clean_search_term(value: str) -> str:
    cleaned = re.sub(r"（.*?）|\(.*?\)", "", value)
    cleaned = re.sub(r"[，。、“”‘’：；!！?？/·,]+", " ", cleaned)
    cleaned = cleaned.replace("待验证", "").replace("不详", "").replace("未知", "")
    cleaned = cleaned.replace("可能", "").replace("疑似", "").replace("推测", "")
    cleaned = cleaned.replace("或", " ").replace("至", " ")
    return " ".join(cleaned.split())


def expand_search_queries(search_queries: list[str]) -> list[str]:
    expanded: list[str] = []
    for raw_query in search_queries:
        query = clean_search_term(raw_query)
        if not query:
            continue
        tokens = [token for token in query.split() if token]
        variants = [query]
        if tokens:
            variants.append(" ".join(tokens[-3:]))
            variants.append(" ".join(tokens[-2:]))
            if len(tokens) >= 3:
                variants.append(" ".join([tokens[0], *tokens[-2:]]))
        for variant in variants:
            variant = variant.replace("如意云头纹", "如意云纹")
            variant = " ".join(dict.fromkeys(variant.split()))
            if variant and variant not in expanded:
                expanded.append(variant)
    return expanded[:8]


def dedupe_search_hits(hits: list[SearchHit], max_hits: int = 5) -> list[SearchHit]:
    results: list[SearchHit] = []
    seen: set[str] = set()
    for hit in hits:
        normalized_url = hit.url.strip()
        if not normalized_url or normalized_url in seen:
            continue
        seen.add(normalized_url)
        results.append(hit)
        if len(results) >= max_hits:
            break
    return results


def parse_duckduckgo_results(html_text: str) -> list[SearchHit]:
    hits: list[SearchHit] = []
    result_pattern = re.compile(
        r'<a[^>]+class="result__a"[^>]+href="(.*?)"[^>]*>(.*?)</a>.*?'
        r'(?:class="result__snippet"[^>]*>(.*?)</(?:a|div)>)?',
        flags=re.IGNORECASE | re.DOTALL,
    )

    for raw_url, raw_title, raw_snippet in result_pattern.findall(html_text):
        url = decode_duckduckgo_url(unescape(raw_url))
        title = truncate_text(strip_html_tags(raw_title), 180)
        snippet = truncate_text(strip_html_tags(raw_snippet), 260) if raw_snippet else ""
        if title and url.startswith("http"):
            hits.append(SearchHit(title=title, url=url, snippet=snippet, source="duckduckgo"))

    return dedupe_search_hits(hits)


async def fetch_search_page_summary(client: httpx.AsyncClient, hit: SearchHit) -> SearchHit:
    try:
        response = await client.get(hit.url, follow_redirects=True)
        response.raise_for_status()
    except Exception:
        return hit

    html_text = response.text
    title = extract_meta_content(html_text, "property", "og:title") or extract_meta_content(
        html_text, "name", "twitter:title"
    )
    if not title:
        title_match = re.search(r"<title>(.*?)</title>", html_text, flags=re.IGNORECASE | re.DOTALL)
        title = strip_html_tags(title_match.group(1)) if title_match else hit.title

    description = (
        extract_meta_content(html_text, "name", "description")
        or extract_meta_content(html_text, "property", "og:description")
        or hit.snippet
    )
    body_preview = truncate_text(strip_html_tags(html_text), 420)
    snippet = truncate_text(description or body_preview, 320)
    source = urlparse(str(response.url)).netloc or hit.source
    return SearchHit(title=truncate_text(title or hit.title, 180), url=hit.url, snippet=snippet, source=source)


def parse_json_response(content: str) -> dict[str, object]:
    content = content.strip()

    try:
        return json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(content[start : end + 1])


def extract_message_text(data: dict[str, object]) -> str:
    message_content = data["choices"][0]["message"]["content"]
    if isinstance(message_content, list):
        return "".join(
            part.get("text", "") for part in message_content if isinstance(part, dict)
        )
    return str(message_content)


def extract_message_reasoning(data: dict[str, object]) -> str:
    message = data.get("choices", [{}])[0].get("message", {})
    if not isinstance(message, dict):
        return ""

    reasoning_parts: list[str] = []
    reasoning_text = message.get("reasoning_content") or message.get("reasoning")
    if isinstance(reasoning_text, str) and reasoning_text.strip():
        reasoning_parts.append(reasoning_text.strip())

    message_content = message.get("content")
    if isinstance(message_content, list):
        for part in message_content:
            if not isinstance(part, dict):
                continue
            part_type = str(part.get("type", "")).lower()
            if part_type in {"reasoning", "thinking"}:
                text = str(part.get("text", "")).strip()
                if text:
                    reasoning_parts.append(text)

    return "\n".join(part for part in reasoning_parts if part).strip()


def _normalize_tag_value(value: str) -> str:
    return re.sub(r"[\s,，。；;：:、/（）()\[\]【】《》“”\"'·-]+", "", value).lower()


def sanitize_generated_tags(
    tags: list[str],
    artifact_name: str | None,
    era: str | None,
    museum_name: str | None,
) -> list[str]:
    blocked_values = [
        artifact_name or "",
        era or "",
        museum_name or "",
    ]
    blocked_values.extend(
        [
            value.removesuffix("馆藏")
            for value in blocked_values
            if value.endswith("馆藏")
        ]
    )
    blocked_values.extend(
        [
            value.removesuffix("收藏")
            for value in blocked_values
            if value.endswith("收藏")
        ]
    )
    blocked_values.extend(
        [
            value.removesuffix("博物馆")
            for value in blocked_values
            if value.endswith("博物馆")
        ]
    )
    blocked_values.extend(
        [
            value.removesuffix(" museum")
            for value in blocked_values
            if value.lower().endswith(" museum")
        ]
    )
    blocked_normalized = {
        normalized
        for value in blocked_values
        if (normalized := _normalize_tag_value(value))
    }

    cleaned_tags: list[str] = []
    for raw_tag in tags:
        tag = str(raw_tag).strip()
        if not tag:
            continue
        normalized_tag = _normalize_tag_value(tag)
        if not normalized_tag or normalized_tag in blocked_normalized:
            continue
        if tag not in cleaned_tags:
            cleaned_tags.append(tag)
    return cleaned_tags


def build_artifact_description_payload(
    provider: VisionProvider,
    *,
    image_urls: list[str],
    data_dir: Path,
    artifact_name: str,
    era: str | None = None,
    museum_name: str | None = None,
    place_of_excavation: str | None = None,
    search_hits: list[SearchHit] | None = None,
    research_summary: str | None = None,
) -> dict[str, object]:
    facts = {
        "artifact_name": artifact_name.strip(),
        "era": (era or "").strip(),
        "museum_name": (museum_name or "").strip(),
        "Place_of_Excavation": (place_of_excavation or "").strip(),
    }
    content_parts: list[dict[str, object]] = [
        {
            "type": "text",
            "text": (
                "本次任务不包含图片。请先核对四项输入，再根据来源证据生成尽可能完整的研究依据摘要、编目描述、标签和字段冲突提示；不要假装观察过图片。\n\n"
                f"用户输入：\n{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n"
                f"千问联网核验报告：\n{research_summary or '联网核验未返回可用报告。'}\n\n"
                f"可直接访问的网页资料：\n{format_research_sources(search_hits or [])}"
            ),
        }
    ]

    payload = {
        "model": provider.model,
        "messages": [
            {"role": "system", "content": ARTIFACT_DESCRIPTION_SYSTEM_PROMPT},
            {"role": "user", "content": content_parts},
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
    }
    # Some Ark/Doubao endpoints reject OpenAI-compatible JSON mode with HTTP 400.
    # The system prompt still mandates JSON and the parser accepts fenced JSON.
    if provider.name != "doubao":
        payload["response_format"] = {"type": "json_object"}
    return payload


async def generate_artifact_description_for_provider(
    provider: VisionProvider,
    *,
    image_urls: list[str],
    data_dir: Path,
    artifact_name: str,
    era: str | None = None,
    museum_name: str | None = None,
    place_of_excavation: str | None = None,
    search_hits: list[SearchHit] | None = None,
    research_summary: str | None = None,
) -> dict[str, object]:
    payload = build_artifact_description_payload(
        provider,
        image_urls=image_urls,
        data_dir=data_dir,
        artifact_name=artifact_name,
        era=era,
        museum_name=museum_name,
        place_of_excavation=place_of_excavation,
        search_hits=search_hits,
        research_summary=research_summary,
    )
    data = await request_chat_completion(provider, payload)
    result = parse_json_response(extract_message_text(data))
    reasoning = (
        str(result.get("reasoning", "")).strip()
        or extract_message_reasoning(data)
    )
    return {
        "provider": provider,
        "result": result,
        "reasoning": reasoning,
        "search_hits": serialize_search_hits(search_hits or []),
        "research_summary": research_summary or "",
    }


async def generate_artifact_descriptions_parallel(
    *,
    image_urls: list[str],
    data_dir: Path,
    artifact_name: str,
    era: str | None = None,
    museum_name: str | None = None,
    place_of_excavation: str | None = None,
    search_hits: list[SearchHit] | None = None,
    research_summary: str | None = None,
) -> tuple[list[dict[str, object]], list[str]]:
    providers, unavailable = get_description_providers()
    if not providers:
        raise RuntimeError("未配置可用的大模型，无法生成描述。")

    tasks = [
        generate_artifact_description_for_provider(
            provider,
            image_urls=image_urls,
            data_dir=data_dir,
            artifact_name=artifact_name,
            era=era,
            museum_name=museum_name,
            place_of_excavation=place_of_excavation,
            search_hits=search_hits or [],
            research_summary=research_summary,
        )
        for provider in providers
    ]
    settled = await asyncio.gather(*tasks, return_exceptions=True)

    results: list[dict[str, object]] = []
    for provider, outcome in zip(providers, settled, strict=True):
        if isinstance(outcome, Exception):
            results.append(
                {
                    "provider": provider,
                    "error": str(outcome),
                }
            )
            continue
        results.append(outcome)

    return results, unavailable


async def generate_artifact_description(
    *,
    image_urls: list[str],
    data_dir: Path,
    artifact_name: str,
    era: str | None = None,
    museum_name: str | None = None,
    place_of_excavation: str | None = None,
) -> tuple[VisionProvider, dict[str, object]]:
    results, _ = await generate_artifact_descriptions_parallel(
        image_urls=image_urls,
        data_dir=data_dir,
        artifact_name=artifact_name,
        era=era,
        museum_name=museum_name,
        place_of_excavation=place_of_excavation,
    )
    for item in results:
        provider = item.get("provider")
        result = item.get("result")
        if isinstance(provider, VisionProvider) and isinstance(result, dict):
            return provider, result
    raise RuntimeError("未获取到有效的描述生成结果。")


async def request_chat_completion(
    provider: VisionProvider,
    payload: dict[str, object],
) -> dict[str, object]:
    timeout = httpx.Timeout(180.0, connect=30.0)
    last_error: Exception | None = None
    for _ in range(2):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    f"{provider.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {provider.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                if not response.is_success:
                    detail = response.text.strip().replace("\n", " ")[:800]
                    raise RuntimeError(
                        f"{provider.name} 请求失败（HTTP {response.status_code}）：{detail or '服务未返回错误详情'}"
                    )
                response.raise_for_status()
                return response.json()
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.RemoteProtocolError) as exc:
            last_error = exc
            continue

    if last_error is not None:
        raise last_error
    raise RuntimeError("Chat completion request failed without a captured exception")


async def request_visual_analysis(
    provider: VisionProvider,
    image_urls: list[str],
    data_dir: Path,
    image_name: str | None = None,
) -> dict[str, object]:
    """One image call that returns both natural-language analysis and the search plan."""
    filename_hint = normalize_filename_hint(image_name)
    prompt_text = "请分析这张文物图片，并按系统要求一次性输出 JSON（分析 + 检索线索）。"
    if filename_hint:
        prompt_text += (
            "\n补充信息：图片原文件名为《"
            f"{filename_hint}"
            "》。该文件名可能包含文物名称、时代、出土地或馆藏单位，也可能不可靠；你只能在图像证据支持时参考它。"
        )

    content_parts: list[dict[str, object]] = [
        {
            "type": "text",
            "text": prompt_text,
        }
    ]
    content_parts.extend(build_image_payloads(image_urls, data_dir))

    payload = {
        "model": provider.model,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": VISION_ANALYSIS_SYSTEM_PROMPT},
            {"role": "user", "content": content_parts},
        ],
        "temperature": 0.2,
    }

    data = await request_chat_completion(provider, payload)
    return parse_json_response(extract_message_text(data))


async def fetch_duckduckgo_query(client: httpx.AsyncClient, query: str) -> list[SearchHit]:
    try:
        response = await client.get(
            "https://duckduckgo.com/html/",
            params={"q": query, "kl": "cn-zh", "kp": "-2"},
            follow_redirects=True,
        )
        response.raise_for_status()
    except Exception:
        return []
    return parse_duckduckgo_results(response.text)


async def search_candidate_artifacts(
    search_queries: list[str],
    deadline_seconds: float = 25.0,
    *,
    expand_queries: bool = True,
) -> list[SearchHit]:
    backend = (settings.vision_search_backend or "duckduckgo").strip().lower()
    if backend == "none":
        return []

    cleaned_queries = [query.strip() for query in search_queries if query.strip()]
    queries = expand_search_queries(cleaned_queries) if expand_queries else cleaned_queries[:8]
    if not queries:
        return []

    if backend == "bing":
        if not settings.bing_search_api_key:
            return []
        runner = _run_bing_search(queries[:6])
    else:
        runner = _run_duckduckgo_search(queries[:6])

    try:
        return await asyncio.wait_for(runner, timeout=deadline_seconds)
    except Exception:
        return []


async def bing_search_query(client: httpx.AsyncClient, query: str) -> list[SearchHit]:
    try:
        response = await client.get(
            settings.bing_search_endpoint,
            params={"q": query, "mkt": "zh-CN", "count": 5, "setLang": "zh-hans"},
            headers={"Ocp-Apim-Subscription-Key": settings.bing_search_api_key},
        )
        response.raise_for_status()
        data = response.json()
    except Exception:
        return []

    hits: list[SearchHit] = []
    for item in data.get("webPages", {}).get("value", []):
        title = truncate_text(strip_html_tags(str(item.get("name", ""))), 180)
        url = str(item.get("url", "")).strip()
        snippet = truncate_text(strip_html_tags(str(item.get("snippet", ""))), 320)
        source = urlparse(url).netloc or None
        if title and url.startswith("http"):
            hits.append(SearchHit(title=title, url=url, snippet=snippet, source=source))
    return hits


async def _run_bing_search(queries: list[str]) -> list[SearchHit]:
    # Bing returns rich snippets directly, so we skip per-page fetching.
    async with httpx.AsyncClient(timeout=8) as client:
        query_results = await asyncio.gather(
            *(bing_search_query(client, query) for query in queries),
            return_exceptions=True,
        )

    search_hits: list[SearchHit] = []
    for result in query_results:
        if isinstance(result, list):
            search_hits.extend(result)
    return dedupe_search_hits(search_hits, max_hits=5)


async def _run_duckduckgo_search(queries: list[str]) -> list[SearchHit]:
    headers = {"User-Agent": SEARCH_USER_AGENT}
    async with httpx.AsyncClient(timeout=8, headers=headers) as client:
        query_results = await asyncio.gather(
            *(fetch_duckduckgo_query(client, query) for query in queries),
            return_exceptions=True,
        )

        search_hits: list[SearchHit] = []
        for result in query_results:
            if isinstance(result, list):
                search_hits.extend(result)

        deduped_hits = dedupe_search_hits(search_hits, max_hits=5)
        if not deduped_hits:
            return []

        enriched_hits = await asyncio.gather(
            *(fetch_search_page_summary(client, hit) for hit in deduped_hits[:4]),
            return_exceptions=True,
        )

    results: list[SearchHit] = []
    for fallback_hit, enriched_hit in zip(deduped_hits[:4], enriched_hits, strict=False):
        if isinstance(enriched_hit, Exception):
            results.append(fallback_hit)
        else:
            results.append(enriched_hit)
    return results


def parse_google_vision_web_detection(data: dict[str, object]) -> ReverseImageResult | None:
    responses = data.get("responses", [])
    if not isinstance(responses, list) or not responses:
        return None
    web_detection = responses[0].get("webDetection", {}) if isinstance(responses[0], dict) else {}
    if not isinstance(web_detection, dict) or not web_detection:
        return None

    best_guess_labels: list[str] = []
    for item in web_detection.get("bestGuessLabels", []):
        if isinstance(item, dict):
            label = str(item.get("label", "")).strip()
            if label and label not in best_guess_labels:
                best_guess_labels.append(label)

    sorted_entities = sorted(
        (item for item in web_detection.get("webEntities", []) if isinstance(item, dict)),
        key=lambda item: item.get("score", 0) or 0,
        reverse=True,
    )
    web_entities: list[str] = []
    for item in sorted_entities:
        description = str(item.get("description", "")).strip()
        if description and description not in web_entities:
            web_entities.append(description)

    pages: list[SearchHit] = []
    for item in web_detection.get("pagesWithMatchingImages", []):
        if not isinstance(item, dict):
            continue
        title = truncate_text(strip_html_tags(str(item.get("pageTitle", ""))), 180)
        url = str(item.get("url", "")).strip()
        if title and url.startswith("http"):
            pages.append(
                SearchHit(
                    title=title,
                    url=url,
                    snippet="",
                    source=urlparse(url).netloc or "google-vision",
                )
            )
    pages = dedupe_search_hits(pages, max_hits=5)

    if not (best_guess_labels or web_entities or pages):
        return None

    return ReverseImageResult(
        best_guess_labels=best_guess_labels[:3],
        web_entities=web_entities[:6],
        pages=pages,
    )


async def _run_google_vision_web_detection(
    image_url: str, data_dir: Path
) -> ReverseImageResult | None:
    base64_content = image_url_to_base64(image_url, data_dir)
    if base64_content:
        image_field: dict[str, object] = {"content": base64_content}
    elif image_url.startswith("http://") or image_url.startswith("https://"):
        image_field = {"source": {"imageUri": image_url}}
    else:
        return None

    payload = {
        "requests": [
            {
                "image": image_field,
                "features": [{"type": "WEB_DETECTION", "maxResults": 10}],
            }
        ]
    }

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            settings.google_vision_endpoint,
            params={"key": settings.google_vision_api_key},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    return parse_google_vision_web_detection(data)


async def reverse_image_search(
    image_urls: list[str],
    data_dir: Path,
    deadline_seconds: float = 20.0,
) -> ReverseImageResult | None:
    """Run "相似图检索" on the first image, mirroring Qwen 网页端的以图搜图能力。"""
    backend = (settings.vision_reverse_image_backend or "none").strip().lower()
    if backend == "none" or not image_urls:
        return None

    if backend == "google_vision":
        if not settings.google_vision_api_key:
            return None
        try:
            return await asyncio.wait_for(
                _run_google_vision_web_detection(image_urls[0], data_dir),
                timeout=deadline_seconds,
            )
        except Exception:
            return None

    return None


def build_reverse_image_queries(reverse_result: ReverseImageResult | None) -> list[str]:
    if reverse_result is None:
        return []

    queries: list[str] = []
    for label in reverse_result.best_guess_labels:
        cleaned = clean_search_term(label)
        if cleaned and cleaned not in queries:
            queries.append(cleaned)
    for entity in reverse_result.web_entities[:3]:
        cleaned = clean_search_term(entity)
        if cleaned and cleaned not in queries:
            queries.append(cleaned)
    return queries


def format_reverse_image_result(reverse_result: ReverseImageResult | None) -> str:
    if reverse_result is None:
        return "未进行相似图检索或无可用结果。"

    lines: list[str] = []
    if reverse_result.best_guess_labels:
        lines.append("最佳猜测标签：" + "；".join(reverse_result.best_guess_labels))
    if reverse_result.web_entities:
        lines.append("相关实体（按相似度由高到低）：" + "；".join(reverse_result.web_entities))
    if reverse_result.pages:
        lines.append("匹配网页：")
        for index, hit in enumerate(reverse_result.pages, start=1):
            lines.append(f"  [图{index}] 标题：{hit.title}")
            lines.append(f"  [图{index}] 链接：{hit.url}")
    return "\n".join(lines) if lines else "相似图检索无有效结果。"


def merge_search_hits(
    primary: list[SearchHit],
    secondary: list[SearchHit],
    max_hits: int = 8,
) -> list[SearchHit]:
    return dedupe_search_hits([*primary, *secondary], max_hits=max_hits)


def format_search_hits(search_hits: list[SearchHit]) -> str:
    if not search_hits:
        return "未检索到可靠候选网页。"

    lines: list[str] = []
    for index, hit in enumerate(search_hits, start=1):
        lines.append(f"[候选{index}] 标题：{hit.title}")
        lines.append(f"[候选{index}] 链接：{hit.url}")
        if hit.source:
            lines.append(f"[候选{index}] 来源：{hit.source}")
        if hit.snippet:
            lines.append(f"[候选{index}] 摘要：{hit.snippet}")
    return "\n".join(lines)


def build_fallback_search_queries(search_plan: dict[str, object]) -> list[str]:
    artifact_type = clean_search_term(str(search_plan.get("artifact_type", "")).strip())
    material = clean_search_term(str(search_plan.get("material", "")).strip())
    era_hint = clean_search_term(str(search_plan.get("era_hint", "")).strip())
    museum_hint = clean_search_term(str(search_plan.get("museum_hint", "")).strip())
    motifs = [
        clean_search_term(str(item).strip())
        for item in search_plan.get("motifs", [])
        if clean_search_term(str(item).strip())
    ]
    visible_text = [
        clean_search_term(str(item).strip())
        for item in search_plan.get("visible_text", [])
        if clean_search_term(str(item).strip())
    ]

    queries: list[str] = []
    if era_hint or artifact_type or motifs:
        queries.append(" ".join(part for part in [era_hint, motifs[0] if motifs else "", artifact_type] if part))
    if museum_hint or artifact_type:
        queries.append(" ".join(part for part in [museum_hint, artifact_type] if part))
    if material or artifact_type or motifs:
        queries.append(" ".join(part for part in [material, artifact_type, motifs[1] if len(motifs) > 1 else motifs[0] if motifs else ""] if part))
    if visible_text:
        queries.append(" ".join(part for part in [visible_text[0], artifact_type] if part))

    compact_queries = []
    for query in queries:
        query = " ".join(dict.fromkeys(query.split()))
        if query and query not in compact_queries:
            compact_queries.append(query)
    return compact_queries[:4]


async def request_final_candidate(
    provider: VisionProvider,
    image_urls: list[str],
    data_dir: Path,
    analysis_text: str,
    search_plan: dict[str, object],
    search_hits: list[SearchHit],
    reverse_result: ReverseImageResult | None = None,
    image_name: str | None = None,
) -> dict[str, object]:
    filename_hint_value = normalize_filename_hint(image_name)
    plan_for_prompt = {key: value for key, value in search_plan.items() if key != "analysis"}
    search_plan_text = json.dumps(plan_for_prompt, ensure_ascii=False, indent=2)
    content_parts: list[dict[str, object]] = [
        {
            "type": "text",
            "text": (
                "请结合图片、相似图检索、图像分析、OCR/关键词和网页候选结果，判断最可能对应的文物并输出数据库 JSON。\n\n"
                f"相似图检索结果（最高优先级证据）：\n{format_reverse_image_result(reverse_result)}\n\n"
                f"第一阶段图像分析：\n{analysis_text}\n\n"
                f"检索计划：\n{search_plan_text}\n\n"
                f"文字检索网页摘要：\n{format_search_hits(search_hits)}\n\n"
                f"文件名弱提示：{filename_hint_value or '无可靠文件名提示'}"
            ),
        }
    ]
    content_parts.extend(build_image_payloads(image_urls, data_dir))

    payload = {
        "model": provider.model,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": VISION_MATCHING_SYSTEM_PROMPT},
            {"role": "user", "content": content_parts},
        ],
        "temperature": 0.1,
    }

    data = await request_chat_completion(provider, payload)
    return parse_json_response(extract_message_text(data))


_ANALYSIS_CACHE: "OrderedDict[str, VisionCandidateRead]" = OrderedDict()
_ANALYSIS_CACHE_MAX = 256


def build_cache_key(provider: VisionProvider, image_urls: list[str], image_name: str | None) -> str:
    raw = json.dumps(
        {
            "model": provider.model,
            "images": image_urls,
            "image_name": image_name or "",
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def serialize_search_hits(search_hits: list[SearchHit]) -> list[dict[str, object]]:
    return [
        {
            "title": hit.title,
            "url": hit.url,
            "snippet": hit.snippet,
            "source": hit.source,
        }
        for hit in search_hits
    ]


def serialize_reverse_result(
    reverse_result: ReverseImageResult | None,
) -> dict[str, object] | None:
    if reverse_result is None:
        return None
    return {
        "best_guess_labels": reverse_result.best_guess_labels,
        "web_entities": reverse_result.web_entities,
        "pages": serialize_search_hits(reverse_result.pages),
    }


def build_vision_candidate(
    provider: VisionProvider,
    result: dict[str, object],
    analysis_text: str,
    search_hits: list[SearchHit],
) -> VisionCandidateRead:
    artifact_name = str(result.get("artifact_name", "")).strip() or "待确认文物"
    era = str(result.get("era", "")).strip() or None
    museum_name = str(result.get("museum_name", "")).strip() or None
    tags = sanitize_generated_tags(
        [str(tag).strip() for tag in result.get("tags", []) if str(tag).strip()],
        artifact_name,
        era,
        museum_name,
    )
    confidence_value = result.get("confidence")
    reasoning = str(result.get("reasoning", "")).strip()

    return VisionCandidateRead(
        provider=provider.name,
        model=provider.model,
        artifact_name=artifact_name,
        era=era,
        museum_name=museum_name,
        tags=tags,
        description=str(result.get("description", "")).strip(),
        confidence=float(confidence_value) if confidence_value is not None else None,
        analysis=analysis_text,
        reasoning=reasoning or analysis_text,
        search_hits=serialize_search_hits(search_hits),
    )


def store_candidate_in_cache(cache_key: str, candidate: VisionCandidateRead) -> None:
    _ANALYSIS_CACHE[cache_key] = candidate
    _ANALYSIS_CACHE.move_to_end(cache_key)
    while len(_ANALYSIS_CACHE) > _ANALYSIS_CACHE_MAX:
        _ANALYSIS_CACHE.popitem(last=False)


def resolve_search_queries(
    search_plan: dict[str, object],
    reverse_result: ReverseImageResult | None = None,
) -> list[str]:
    reverse_queries = build_reverse_image_queries(reverse_result)
    model_search_queries = [
        str(item).strip()
        for item in search_plan.get("search_queries", [])
        if str(item).strip()
    ]
    fallback_search_queries = build_fallback_search_queries(search_plan)
    # Reverse-image queries go first: they reflect the true visual match, so confirming
    # them with text search is far more reliable than the model's blind guesses.
    return list(
        dict.fromkeys(
            [*reverse_queries, *fallback_search_queries, *model_search_queries]
        )
    )[:5]


async def request_provider_analysis(
    provider: VisionProvider,
    image_urls: list[str],
    data_dir: Path,
    image_name: str | None = None,
) -> VisionCandidateRead:
    cache_key = build_cache_key(provider, image_urls, image_name)
    cached = _ANALYSIS_CACHE.get(cache_key)
    if cached is not None:
        _ANALYSIS_CACHE.move_to_end(cache_key)
        return cached

    search_plan = await request_visual_analysis(provider, image_urls, data_dir, image_name)
    analysis_text = str(search_plan.get("analysis", "")).strip()

    reverse_result = await reverse_image_search(image_urls, data_dir)
    search_queries = resolve_search_queries(search_plan, reverse_result)

    search_hits = await search_candidate_artifacts(search_queries)
    result = await request_final_candidate(
        provider,
        image_urls,
        data_dir,
        analysis_text,
        search_plan,
        search_hits,
        reverse_result,
        image_name,
    )

    reverse_pages = reverse_result.pages if reverse_result else []
    display_hits = merge_search_hits(reverse_pages, search_hits)
    candidate = build_vision_candidate(provider, result, analysis_text, display_hits)
    store_candidate_in_cache(cache_key, candidate)
    return candidate


async def stream_provider_analysis(
    provider: VisionProvider,
    image_urls: list[str],
    data_dir: Path,
    image_name: str | None,
    emit,
) -> None:
    """Run the pipeline for one provider, emitting progress events stage by stage.

    `emit` is an async callable receiving a dict event.
    """
    provider_meta = {"provider": provider.name, "model": provider.model}

    cache_key = build_cache_key(provider, image_urls, image_name)
    cached = _ANALYSIS_CACHE.get(cache_key)
    if cached is not None:
        _ANALYSIS_CACHE.move_to_end(cache_key)
        await emit({**provider_meta, "stage": "analysis", "analysis": cached.analysis or "", "candidates": [], "cached": True})
        if cached.search_hits:
            await emit({**provider_meta, "stage": "search", "hits": [hit.model_dump() for hit in cached.search_hits]})
        await emit({**provider_meta, "stage": "result", "candidate": cached.model_dump(), "cached": True})
        await emit({**provider_meta, "stage": "done"})
        return

    await emit({**provider_meta, "stage": "analyzing"})
    search_plan = await request_visual_analysis(provider, image_urls, data_dir, image_name)
    analysis_text = str(search_plan.get("analysis", "")).strip()
    preview_candidates = [
        item for item in search_plan.get("candidates", []) if isinstance(item, dict)
    ]
    await emit(
        {
            **provider_meta,
            "stage": "analysis",
            "analysis": analysis_text,
            "candidates": preview_candidates,
        }
    )

    await emit({**provider_meta, "stage": "reverse_searching"})
    reverse_result = await reverse_image_search(image_urls, data_dir)
    await emit(
        {
            **provider_meta,
            "stage": "reverse_image",
            "reverse": serialize_reverse_result(reverse_result),
        }
    )

    search_queries = resolve_search_queries(search_plan, reverse_result)
    await emit({**provider_meta, "stage": "searching", "queries": search_queries})
    search_hits = await search_candidate_artifacts(search_queries)
    reverse_pages = reverse_result.pages if reverse_result else []
    display_hits = merge_search_hits(reverse_pages, search_hits)
    await emit(
        {
            **provider_meta,
            "stage": "search",
            "hits": serialize_search_hits(display_hits),
        }
    )

    await emit({**provider_meta, "stage": "finalizing"})
    result = await request_final_candidate(
        provider,
        image_urls,
        data_dir,
        analysis_text,
        search_plan,
        search_hits,
        reverse_result,
        image_name,
    )
    candidate = build_vision_candidate(provider, result, analysis_text, display_hits)
    store_candidate_in_cache(cache_key, candidate)
    await emit({**provider_meta, "stage": "result", "candidate": candidate.model_dump()})
    await emit({**provider_meta, "stage": "done"})
