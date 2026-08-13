import asyncio
import logging
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.artifact_research.schemas import ArtifactResearchRequest
from app.config import settings
from app.schemas import (
    ArtifactDescriptionCandidateRead,
    ArtifactDescriptionGenerateRead,
    ArtifactImageRead,
    VisionAnalyzeResponse,
)

logger = logging.getLogger("app.vision")


@dataclass(slots=True)
class VisionWorkflowDependencies:
    data_dir: Path
    get_enabled_providers: Callable[..., Any]
    enabled_sites: Callable[..., Any]
    request_provider_analysis: Callable[..., Any]
    request_web_candidate: Callable[..., Any]
    run_artifact_research: Callable[..., Any]
    generate_artifact_descriptions_parallel: Callable[..., Any]
    prompt_sources: Callable[..., Any]
    build_fallback_description: Callable[..., str]
    normalize_verified_claims: Callable[..., Any]
    normalize_artifact_field_warnings: Callable[..., Any]
    optional_text: Callable[..., Any]
    sanitize_generated_tags: Callable[..., Any]
    should_proxy_artifact_queries_to_cloud: Callable[[], bool]
    find_artifact_image_by_hash_local: Callable[..., Any]
    hash_bytes: Callable[[bytes], str]


_dependencies: VisionWorkflowDependencies | None = None


def configure_vision_workflow(dependencies: VisionWorkflowDependencies) -> None:
    global _dependencies
    _dependencies = dependencies


def _configured_dependencies() -> VisionWorkflowDependencies:
    if _dependencies is None:
        raise RuntimeError("vision workflow has not been configured")
    return _dependencies


def write_temp_image_file(contents: bytes, filename: str | None = None) -> Path:
    suffix = Path(filename or "").suffix.lower() or ".jpg"
    temporary_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    temporary_file.write(contents)
    temporary_file.close()
    return Path(temporary_file.name)


async def run_vision_analysis(
    image_urls: list[str], image_name: str | None
) -> VisionAnalyzeResponse:
    if not image_urls:
        raise HTTPException(status_code=400, detail="No image urls provided")

    dependencies = _configured_dependencies()
    providers, unavailable_providers = dependencies.get_enabled_providers()
    web_sites = dependencies.enabled_sites()
    if not providers and not web_sites:
        raise HTTPException(
            status_code=400,
            detail="No vision provider configured. Please set DASHSCOPE_API_KEY or VOLCENGINE_API_KEY.",
        )

    tasks = [
        dependencies.request_provider_analysis(
            provider,
            image_urls,
            dependencies.data_dir,
            image_name,
        )
        for provider in providers
    ]
    task_names = [provider.name for provider in providers]
    for site in web_sites:
        tasks.append(
            dependencies.request_web_candidate(
                site,
                image_urls,
                dependencies.data_dir,
                image_name,
            )
        )
        task_names.append(site.key)

    results = await asyncio.gather(*tasks, return_exceptions=True)

    candidates = []
    failed_providers = []
    for name, result in zip(task_names, results, strict=False):
        if isinstance(result, Exception):
            failed_providers.append(name)
            logger.warning(
                "Vision provider %s failed: %s",
                name,
                result,
                exc_info=result,
            )
            continue
        candidates.append(result)

    candidates.sort(
        key=lambda item: (
            item.confidence if item.confidence is not None else -1,
            len(item.tags),
        ),
        reverse=True,
    )

    return VisionAnalyzeResponse(
        candidates=candidates,
        unavailable_providers=unavailable_providers,
        failed_providers=failed_providers,
    )


async def generate_artifact_description_payload(
    *,
    image_urls: list[str],
    museum_name: str | None,
    name: str,
    era: str | None,
    Place_of_Excavation: str | None,
    event_callback: Callable[[dict[str, object]], Awaitable[None]] | None = None,
) -> ArtifactDescriptionGenerateRead:
    dependencies = _configured_dependencies()
    fallback_description = dependencies.build_fallback_description(
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
    )
    try:
        if event_callback is not None:
            await event_callback(
                {
                    "type": "research_start",
                    "message": "文物检索 Agent 正在规划查询并核对四项字段",
                }
            )
        research = await dependencies.run_artifact_research(
            ArtifactResearchRequest(
                artifact_name=name,
                era=era,
                museum_name=museum_name,
                place_of_excavation=Place_of_Excavation,
            )
        )
        if event_callback is not None:
            await event_callback(
                {
                    "type": "research_complete",
                    "message": "联网检索与交叉核验完成",
                    "research_id": research.research_id,
                    "summary": research.research_summary,
                    "source_count": len(research.web_sources)
                    + len(research.knowledge_sources),
                }
            )
        (
            raw_results,
            unavailable_providers,
        ) = await dependencies.generate_artifact_descriptions_parallel(
            image_urls=[],
            data_dir=dependencies.data_dir,
            artifact_name=name,
            era=era,
            museum_name=museum_name,
            place_of_excavation=Place_of_Excavation,
            search_hits=dependencies.prompt_sources(research),
            research_summary=research.research_summary,
            event_callback=event_callback,
        )
        candidates: list[ArtifactDescriptionCandidateRead] = []
        preferred_candidate: ArtifactDescriptionCandidateRead | None = None

        for item in raw_results:
            provider = item.get("provider")
            if not hasattr(provider, "name") or not hasattr(provider, "model"):
                continue

            if item.get("error"):
                candidates.append(
                    ArtifactDescriptionCandidateRead(
                        provider=str(provider.name),
                        model=str(provider.model),
                        status="error",
                        error=str(item["error"]),
                    )
                )
                continue

            result = item.get("result")
            if not isinstance(result, dict):
                candidates.append(
                    ArtifactDescriptionCandidateRead(
                        provider=str(provider.name),
                        model=str(provider.model),
                        status="error",
                        error="模型未返回可解析的 JSON 结果。",
                    )
                )
                continue

            description = (
                dependencies.optional_text(str(result.get("description", "")))
                or fallback_description
            )
            description, verified_claims = dependencies.normalize_verified_claims(
                result.get("verified_claims", []),
                description,
            )
            description = description or fallback_description
            tags = dependencies.sanitize_generated_tags(
                [
                    str(tag).strip()
                    for tag in result.get("tags", [])
                    if str(tag).strip()
                ],
                name,
                era,
                museum_name,
            )
            field_warnings = dependencies.normalize_artifact_field_warnings(
                result.get("field_warnings", []),
                artifact_name=name,
                era=era,
                museum_name=museum_name,
                place_of_excavation=Place_of_Excavation,
            )
            search_hits = item.get("search_hits", [])
            if not isinstance(search_hits, list):
                search_hits = []
            candidate = ArtifactDescriptionCandidateRead(
                provider=str(provider.name),
                model=str(provider.model),
                description=description,
                tags=tags,
                reasoning=dependencies.optional_text(str(result.get("reasoning", "")))
                or dependencies.optional_text(str(item.get("reasoning", ""))),
                research_summary=dependencies.optional_text(
                    str(item.get("research_summary", ""))
                ),
                field_warnings=field_warnings,
                verified_claims=verified_claims,
                search_hits=search_hits,
                status="success",
            )
            candidates.append(candidate)

            if preferred_candidate is None or candidate.provider == "qwen":
                preferred_candidate = candidate

        if preferred_candidate is not None:
            return ArtifactDescriptionGenerateRead(
                provider=preferred_candidate.provider,
                model=preferred_candidate.model,
                description=preferred_candidate.description,
                tags=preferred_candidate.tags,
                reasoning=preferred_candidate.reasoning,
                research_id=research.research_id,
                candidates=candidates,
                unavailable_providers=unavailable_providers,
            )

        return ArtifactDescriptionGenerateRead(
            provider="fallback",
            model="fallback",
            description=fallback_description,
            tags=[],
            research_id=research.research_id,
            candidates=candidates,
            unavailable_providers=unavailable_providers,
        )
    except Exception as exc:  # noqa: BLE001 - graceful fallback for copy generation
        logger.warning("generate artifact description failed: %s", exc, exc_info=exc)
        return ArtifactDescriptionGenerateRead(
            provider="fallback",
            model="fallback",
            description=fallback_description,
            tags=[],
            candidates=[],
            unavailable_providers=[],
        )


async def find_duplicate_artifact_image(
    db: Session, image_hash: str
) -> ArtifactImageRead | None:
    dependencies = _configured_dependencies()
    if dependencies.should_proxy_artifact_queries_to_cloud():
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                response = await client.get(
                    f"{base}{settings.api_prefix}/artifact-images/by-hash",
                    params={"image_hash": image_hash},
                )
                if response.status_code == 404:
                    images_response = await client.get(
                        f"{base}{settings.api_prefix}/artifact-images"
                    )
                    images_response.raise_for_status()
                    for item in images_response.json():
                        raw_url = str(item.get("url", "")).strip()
                        if not raw_url:
                            continue
                        image_url = (
                            raw_url
                            if raw_url.startswith(("http://", "https://"))
                            else f"{base}{raw_url}"
                        )
                        try:
                            image_response = await client.get(image_url)
                            image_response.raise_for_status()
                        except Exception:  # noqa: BLE001 - skip unreadable legacy assets
                            continue
                        if (
                            dependencies.hash_bytes(image_response.content)
                            == image_hash
                        ):
                            return ArtifactImageRead.model_validate(item)
                    return None
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - validation failures should surface clearly
            raise HTTPException(
                status_code=502, detail=f"查询云端重复图片失败：{exc}"
            ) from exc
        payload = response.json()
        return ArtifactImageRead.model_validate(payload) if payload else None

    match = dependencies.find_artifact_image_by_hash_local(db, image_hash)
    return ArtifactImageRead.model_validate(match) if match is not None else None
