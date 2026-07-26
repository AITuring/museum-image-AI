import asyncio
import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import select

from app.artifact_research.knowledge import knowledge_provider
from app.artifact_research.models import ArtifactResearchRecord
from app.artifact_research.schemas import (
    ArtifactResearchQuery,
    ArtifactResearchRead,
    ArtifactResearchRequest,
    ArtifactResearchSourceRead,
)
from app.config import settings
from app.db import SessionLocal
from app.vision import (
    SearchHit,
    clean_search_term,
    extract_message_text,
    get_description_providers,
    request_chat_completion,
    search_candidate_artifacts,
)

ARTIFACT_RESEARCH_SYSTEM_PROMPT = """
你是一名博物馆藏品资料研究员。请使用联网搜索核验用户提供的文物名称、时代、馆藏单位和出土信息。

研究要求：
1. 优先查找博物馆官网、政府文博机构和考古机构；若官网没有公开完整藏品目录，可使用博物馆官方账号、正式展览介绍、权威媒体、公开出版物和多个相互印证的可靠二手来源。不要因为官网未收录就断言文物不存在或字段错误。
2. 特别检查是否存在名称相近、材质不同、同地点出土但分藏不同博物馆的文物，禁止把多件文物的尺寸、发现时间、文物等级和外观细节混在一起。
3. 尽可能查明：规范名称、材质、尺寸、发现/出土时间、准确地点、馆藏归属、文物等级、外观细节、工艺、保存状态和历史背景。
4. 明确列出支持每项关键事实的来源名称；能获得链接时一并给出链接。单一非官方来源只能作为线索，两个以上独立来源一致时可以标记为“多来源印证”。多个来源冲突时分别陈述，不要强行下结论。
5. 这是提供给后续编目模型的证据报告，不要写空泛鉴赏文字。未查到的项目直接标记“未查到可靠来源”。
""".strip()


def build_artifact_search_queries(query: ArtifactResearchQuery) -> list[str]:
    name = clean_search_term(query.artifact_name)
    era = clean_search_term(query.era or "")
    museum = clean_search_term(query.museum_name or "")
    excavation = clean_search_term(query.place_of_excavation or "")
    raw_queries = [
        " ".join(part for part in [name, excavation, museum, era] if part),
        " ".join(part for part in [name, excavation, "出土 馆藏"] if part),
        " ".join(part for part in [name, museum, "藏品"] if part),
        " ".join(part for part in [name, "尺寸 发现 文物等级"] if part),
        " ".join(part for part in [name, excavation, "考古"] if part),
        " ".join(part for part in [name, "博物院 博物馆"] if part),
    ]
    return list(dict.fromkeys(item for item in raw_queries if item))[:6]


async def request_qwen_web_research(
    query: ArtifactResearchQuery,
) -> str:
    providers, _ = get_description_providers()
    qwen_provider = next((provider for provider in providers if provider.name == "qwen"), None)
    if qwen_provider is None:
        return ""

    facts = {
        "artifact_name": query.artifact_name.strip(),
        "era": (query.era or "").strip(),
        "museum_name": (query.museum_name or "").strip(),
        "Place_of_Excavation": (query.place_of_excavation or "").strip(),
    }
    facts_text = json.dumps(facts, ensure_ascii=False, indent=2)
    research_questions = [
        (
            "请先用完整名称、出土地点和馆藏单位联网搜索，再拆分关键词继续搜索。"
            "重点回答：这组字段对应的是哪一件文物？是否存在同地点出土但材质不同、分藏不同博物馆的同名或近名文物？"
            "逐件列出材质、馆藏单位和可区分特征，判断用户字段是否自洽。不要把不同文物合并。\n\n"
            f"待核线索：\n{facts_text}"
        ),
        (
            "请联网搜索以下文物的详细资料。重点寻找尺寸、重量、发现或出土年份、出土经过、文物等级、"
            "面部与冠饰细节、制作工艺、残损状况、展览或著录信息。每项具体细节都写明来源名称；"
            "若搜索到近似文物，必须先核对材质与馆藏单位，不能把近似文物的细节移植过来。\n\n"
            f"待核线索：\n{facts_text}"
        ),
    ]

    async def run_research(question: str) -> str:
        payload: dict[str, object] = {
            "model": qwen_provider.model,
            "messages": [
                {"role": "system", "content": ARTIFACT_RESEARCH_SYSTEM_PROMPT},
                {"role": "user", "content": question},
            ],
            "enable_search": True,
            "search_options": {"search_strategy": "max"},
            "temperature": 0.1,
            "max_tokens": 2200,
        }
        data = await request_chat_completion(qwen_provider, payload)
        return extract_message_text(data).strip()

    outcomes = await asyncio.gather(
        *(run_research(question) for question in research_questions),
        return_exceptions=True,
    )
    sections: list[str] = []
    for label, outcome in zip(
        ["身份与馆藏核验", "细节与出土信息核验"],
        outcomes,
        strict=True,
    ):
        if isinstance(outcome, str) and outcome:
            sections.append(f"## {label}\n{outcome}")
    return "\n\n".join(sections)


def _query_hash(query: ArtifactResearchQuery) -> str:
    payload = {
        **query.model_dump(),
        "agent_version": settings.artifact_research_agent_version,
        "knowledge_revision": knowledge_provider.revision(),
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _web_source(hit: SearchHit) -> ArtifactResearchSourceRead:
    return ArtifactResearchSourceRead(
        title=hit.title,
        url=hit.url,
        snippet=hit.snippet,
        source=hit.source,
        source_type="web",
    )


def _knowledge_context(sources: list[ArtifactResearchSourceRead]) -> str:
    if not sources:
        return ""
    lines = ["## 专业知识库证据"]
    for index, source in enumerate(sources, start=1):
        page_label = ""
        if source.page_start is not None:
            page_label = (
                f"第{source.page_start}页"
                if source.page_end in {None, source.page_start}
                else f"第{source.page_start}-{source.page_end}页"
            )
        lines.append(
            f"[知识库{index}] {source.title}"
            f"{f'（{page_label}）' if page_label else ''}"
        )
        if source.snippet:
            lines.append(source.snippet)
        if source.url:
            lines.append(f"链接：{source.url}")
    return "\n".join(lines)


def _record_to_result(record: ArtifactResearchRecord, *, cached: bool) -> ArtifactResearchRead:
    payload = dict(record.result_json)
    payload.update(
        {
            "research_id": record.id,
            "cached": cached,
            "created_at": record.created_at,
        }
    )
    return ArtifactResearchRead.model_validate(payload)


_RESEARCH_LOCKS: dict[str, asyncio.Lock] = {}


async def run_artifact_research(
    request: ArtifactResearchRequest,
) -> ArtifactResearchRead:
    query = ArtifactResearchQuery.model_validate(request.model_dump())
    query_hash = _query_hash(query)
    lock = _RESEARCH_LOCKS.setdefault(query_hash, asyncio.Lock())
    async with lock:
        return await _run_artifact_research_locked(request, query, query_hash)


async def _run_artifact_research_locked(
    request: ArtifactResearchRequest,
    query: ArtifactResearchQuery,
    query_hash: str,
) -> ArtifactResearchRead:
    with SessionLocal() as db:
        existing = db.scalar(
            select(ArtifactResearchRecord).where(
                ArtifactResearchRecord.query_hash == query_hash,
                ArtifactResearchRecord.agent_version
                == settings.artifact_research_agent_version,
            )
        )
        if existing is not None and not request.force_refresh:
            return _record_to_result(existing, cached=True)

    search_queries = build_artifact_search_queries(query)
    web_result, online_research_result, knowledge_result = await asyncio.gather(
        search_candidate_artifacts(search_queries, expand_queries=False),
        request_qwen_web_research(query),
        knowledge_provider.search(query, top_k=request.knowledge_top_k),
        return_exceptions=True,
    )

    web_sources = (
        [_web_source(hit) for hit in web_result]
        if isinstance(web_result, list)
        else []
    )
    online_summary = online_research_result if isinstance(online_research_result, str) else ""
    knowledge_sources = (
        knowledge_result
        if isinstance(knowledge_result, list)
        else []
    )
    knowledge_summary = _knowledge_context(knowledge_sources)
    research_summary = "\n\n".join(
        part
        for part in [online_summary, knowledge_summary]
        if part.strip()
    )
    if not research_summary:
        research_summary = "联网检索与专业知识库均未返回可用证据。"

    result_payload = {
        "agent_version": settings.artifact_research_agent_version,
        "query": query.model_dump(),
        "search_queries": search_queries,
        "web_sources": [source.model_dump() for source in web_sources],
        "knowledge_sources": [source.model_dump() for source in knowledge_sources],
        "research_summary": research_summary,
    }

    with SessionLocal() as db:
        record = db.scalar(
            select(ArtifactResearchRecord).where(
                ArtifactResearchRecord.query_hash == query_hash,
                ArtifactResearchRecord.agent_version
                == settings.artifact_research_agent_version,
            )
        )
        if record is None:
            record = ArtifactResearchRecord(
                query_hash=query_hash,
                agent_version=settings.artifact_research_agent_version,
                query_json=query.model_dump(),
                result_json=result_payload,
            )
            db.add(record)
        else:
            record.query_json = query.model_dump()
            record.result_json = result_payload
            record.created_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(record)
        return _record_to_result(record, cached=False)


def get_artifact_research(research_id: str) -> ArtifactResearchRead | None:
    with SessionLocal() as db:
        record = db.get(ArtifactResearchRecord, research_id)
        return _record_to_result(record, cached=True) if record is not None else None


def prompt_sources(result: ArtifactResearchRead) -> list[SearchHit]:
    return [
        SearchHit(
            title=source.title,
            url=source.url,
            snippet=source.snippet,
            source=source.source or source.source_type,
        )
        for source in [*result.web_sources, *result.knowledge_sources]
    ]
