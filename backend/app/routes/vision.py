import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.schemas import VisionAnalyzeRequest, VisionAnalyzeResponse

logger = logging.getLogger("app.vision")


@dataclass(slots=True)
class VisionRouteDependencies:
    data_dir: Path
    run_vision_analysis: Callable[..., Any]
    write_temp_image_file: Callable[..., Path]
    get_enabled_providers: Callable[..., Any]
    enabled_sites: Callable[..., Any]
    stream_provider_analysis: Callable[..., Any]
    request_web_candidate: Callable[..., Any]


@dataclass(slots=True)
class VisionRouteHandlers:
    analyze: Callable[..., Any]
    analyze_file: Callable[..., Any]
    analyze_stream: Callable[..., Any]


def create_vision_router(
    dependencies: VisionRouteDependencies,
) -> tuple[APIRouter, VisionRouteHandlers]:
    router = APIRouter()

    @router.post("/vision/analyze", response_model=VisionAnalyzeResponse)
    async def analyze_artifact_images(
        payload: VisionAnalyzeRequest,
    ) -> VisionAnalyzeResponse:
        return await dependencies.run_vision_analysis(
            payload.image_urls,
            payload.image_name,
        )

    @router.post("/vision/analyze/file", response_model=VisionAnalyzeResponse)
    async def analyze_artifact_image_file(
        file: UploadFile = File(...),
        image_name: str | None = Form(None),
    ) -> VisionAnalyzeResponse:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="图片内容为空。")
        temp_path = dependencies.write_temp_image_file(
            contents,
            file.filename or image_name,
        )
        try:
            return await dependencies.run_vision_analysis(
                [str(temp_path)],
                image_name or file.filename or temp_path.name,
            )
        finally:
            temp_path.unlink(missing_ok=True)

    @router.post("/vision/analyze/stream")
    async def analyze_artifact_images_stream(
        payload: VisionAnalyzeRequest,
    ) -> StreamingResponse:
        if not payload.image_urls:
            raise HTTPException(status_code=400, detail="No image urls provided")

        providers, unavailable_providers = dependencies.get_enabled_providers()
        web_sites = dependencies.enabled_sites()
        if not providers and not web_sites:
            raise HTTPException(
                status_code=400,
                detail="No vision provider configured. Please set DASHSCOPE_API_KEY or VOLCENGINE_API_KEY.",
            )

        async def event_generator():
            queue: asyncio.Queue = asyncio.Queue()

            async def emit(event: dict) -> None:
                await queue.put(event)

            async def run_provider(provider) -> None:
                try:
                    await dependencies.stream_provider_analysis(
                        provider,
                        payload.image_urls,
                        dependencies.data_dir,
                        payload.image_name,
                        emit,
                    )
                except Exception as exc:  # noqa: BLE001 - report stream failure
                    logger.warning(
                        "Vision provider %s (%s) failed: %s",
                        provider.name,
                        provider.model,
                        exc,
                        exc_info=exc,
                    )
                    await emit(
                        {
                            "provider": provider.name,
                            "model": provider.model,
                            "stage": "error",
                            "message": str(exc) or "识图失败",
                        }
                    )

            async def run_web_site(site) -> None:
                meta = {"provider": site.key, "model": site.label}
                try:
                    await emit({**meta, "stage": "analyzing"})
                    candidate = await dependencies.request_web_candidate(
                        site,
                        payload.image_urls,
                        dependencies.data_dir,
                        payload.image_name,
                    )
                    await emit(
                        {
                            **meta,
                            "stage": "result",
                            "candidate": candidate.model_dump(),
                        }
                    )
                    await emit({**meta, "stage": "done"})
                except Exception as exc:  # noqa: BLE001 - report stream failure
                    logger.warning(
                        "Vision provider %s failed: %s",
                        site.key,
                        exc,
                        exc_info=exc,
                    )
                    await emit(
                        {
                            **meta,
                            "stage": "error",
                            "message": str(exc) or "网页端识图失败",
                        }
                    )

            tasks = [
                asyncio.create_task(run_provider(provider)) for provider in providers
            ]
            tasks += [asyncio.create_task(run_web_site(site)) for site in web_sites]

            async def finalize() -> None:
                await asyncio.gather(*tasks, return_exceptions=True)
                await queue.put(None)

            finalize_task = asyncio.create_task(finalize())

            await queue.put(
                {
                    "stage": "meta",
                    "providers": [provider.name for provider in providers]
                    + [site.key for site in web_sites],
                    "unavailable_providers": unavailable_providers,
                }
            )

            try:
                while True:
                    event = await queue.get()
                    if event is None:
                        break
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            finally:
                finalize_task.cancel()

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return router, VisionRouteHandlers(
        analyze=analyze_artifact_images,
        analyze_file=analyze_artifact_image_file,
        analyze_stream=analyze_artifact_images_stream,
    )
