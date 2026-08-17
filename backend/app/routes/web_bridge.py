from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException

from app.schemas import WebBridgeLoginStartRead, WebBridgeStatusRead


@dataclass(slots=True)
class WebBridgeRouteDependencies:
    enabled_sites: Callable[..., Any]
    build_web_bridge_status: Callable[..., WebBridgeStatusRead]
    start_web_bridge_login: Callable[..., WebBridgeLoginStartRead]


@dataclass(slots=True)
class WebBridgeRouteHandlers:
    status: Callable[..., WebBridgeStatusRead]
    start_login: Callable[..., WebBridgeLoginStartRead]


def create_web_bridge_router(
    dependencies: WebBridgeRouteDependencies,
) -> tuple[APIRouter, WebBridgeRouteHandlers]:
    router = APIRouter()

    @router.get("/web-bridge/status", response_model=WebBridgeStatusRead)
    def web_bridge_status() -> WebBridgeStatusRead:
        site = next(
            (item for item in dependencies.enabled_sites() if item.key == "qwen_web"),
            None,
        )
        return dependencies.build_web_bridge_status(site)

    @router.post(
        "/web-bridge/login/start",
        response_model=WebBridgeLoginStartRead,
    )
    def start_web_bridge_login_helper() -> WebBridgeLoginStartRead:
        site = next(
            (item for item in dependencies.enabled_sites() if item.key == "qwen_web"),
            None,
        )
        if site is None:
            raise HTTPException(status_code=400, detail="未启用通义网页桥接。")
        result = dependencies.start_web_bridge_login()
        if not result.started and "Docker 容器" in result.detail:
            raise HTTPException(status_code=409, detail=result.detail)
        return result

    return router, WebBridgeRouteHandlers(
        status=web_bridge_status,
        start_login=start_web_bridge_login_helper,
    )
