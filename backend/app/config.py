from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Museum Image DB API"
    app_env: str = "development"
    api_prefix: str = "/api"
    database_url: str = "postgresql+psycopg://museum:museum123@postgres:5432/museum_image_db"
    exhibition_database_url: str = (
        "postgresql+psycopg://museum:museum123@exhibitions-postgres:5432/museum_exhibition_db"
    )
    cors_origins: str = "http://localhost:5173"
    dashscope_api_key: str = ""
    dashscope_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    qwen_vision_model: str = "qwen3-vl-plus"
    volcengine_api_key: str = ""
    volcengine_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    doubao_vision_model: str = "doubao-seed-2.0-pro"

    # Web search augmentation: "none" | "duckduckgo" | "bing"
    vision_search_backend: str = "duckduckgo"
    bing_search_api_key: str = ""
    bing_search_endpoint: str = "https://api.bing.microsoft.com/v7.0/search"

    # Reverse image search ("相似图检索"): "none" | "google_vision"
    # This is the highest-value signal: it matches the actual image pixels against
    # indexed photos of real artifacts instead of relying on the model's guess.
    vision_reverse_image_backend: str = "google_vision"
    google_vision_api_key: str = ""
    google_vision_endpoint: str = "https://vision.googleapis.com/v1/images:annotate"

    # Browser bridge to 通义 (qianwen.com) which has the built-in 相似图检索 agent.
    # Requires a real Google Chrome (channel="chrome") driven via a persistent profile;
    # consumer sites gate uploads against automation, so a bundled headless Chromium does
    # not work. Run headful (in Docker behind Xvfb). One-time manual login is captured to
    # the storage_state file (see scripts/web_bridge_login.py).
    # Shared settings:
    web_headless: bool = False
    # Browser channel: "chrome" (real Google Chrome) is required for the bridge to work.
    web_browser_channel: str = "chrome"
    # Persistent Chrome profile dir (keeps the bridge looking like a real, returning user).
    web_user_data_dir: str = "/data/web_chrome_profile"
    web_timeout_seconds: int = 150
    web_upload_max_file_bytes: int = 10 * 1024 * 1024
    web_upload_target_min_file_bytes: int = 2 * 1024 * 1024
    web_upload_target_max_file_bytes: int = 8 * 1024 * 1024
    web_upload_max_dimension: int = 4096
    web_bridge_remote_url: str = ""
    web_bridge_remote_timeout_seconds: int = 240
    web_bridge_remote_start_command: str = (
        ".venv-webtune/bin/python backend/scripts/host_web_bridge_server.py --port 8011"
    )
    # Reuse the same web conversation for a few images, then rotate to a fresh chat
    # to reduce context pollution and UI slowdowns during batch runs.
    web_reuse_conversation_max_turns: int = 10
    web_prompt: str = (
        "请识别这件文物：优先用相似图检索确认它的身份，然后告诉我它的名称、时代、"
        "所属博物馆或出土地，并补充器型、材质、纹饰、工艺、用途、出土信息、墓葬情况、"
        "遗址情况、流传与历史背景等细节；同时提取适合入库的中文标签，但不要把名称、"
        "时代、馆藏/收藏机构这些已单独存在的字段再重复当作标签。"
    )
    # Text model used to structure the web answer prose into DB JSON.
    web_structuring_model: str = "qwen-plus"

    # Artifact research agent and local professional knowledge base.
    artifact_research_agent_version: str = "artifact-research-v1"

    # 通义 (qianwen.com)
    qwen_web_enabled: bool = False
    qwen_web_url: str = "https://www.qianwen.com/"
    qwen_web_storage_state: str = "/data/qwen_web_state.json"
    # CSS selector for rendered assistant answer blocks; tune against the live DOM.
    qwen_web_answer_selector: str = "[class*='markdown']"
    # Accessible name of the attach/upload control (file inputs are created lazily).
    qwen_web_attach_name: str = "添加附件"

    # Google Photos import (local operator machine).
    google_photos_client_id: str = ""
    google_photos_client_secret: str = ""
    google_photos_redirect_uri: str = ""
    google_photos_config_path: str = "/data/google_photos_config.json"
    google_photos_token_path: str = "/data/google_photos_token.json"

    # Downscale local images before sending to the model (longest side, px). 0 disables.
    vision_max_image_dimension: int = 1280
    vision_image_jpeg_quality: int = 85

    # ── Deployment role ──────────────────────────────────────────────────────────
    # "local"  = operator machine: scans directories, runs the qwen bridge, stages
    #            results, then pushes each reviewed record to the cloud.
    # "cloud"  = Alibaba Cloud server: receives submissions, stores images in OSS and
    #            metadata in the cloud DB, and serves query/search.
    app_role: str = "local"
    # Injected by the deployment script. Exposed by /api/health so a deploy is
    # not considered successful while an older container is still answering.
    app_revision: str = "development"

    # ── Cloud ingest (used by the LOCAL side to push reviewed records) ────────────
    # Base URL of the cloud API, e.g. https://your-server.example.com
    cloud_api_base_url: str = ""
    # Shared secret sent as `Authorization: Bearer <token>`. The cloud side validates
    # it; the local side sends it. Keep both in sync.
    ingest_token: str = ""
    # A single large photo can briefly consume substantial memory while hashing,
    # reading EXIF, and uploading to OSS. Reject excess work with a retryable 429
    # instead of letting concurrent submissions exhaust a small cloud host.
    cloud_ingest_concurrency: int = 1

    # ── Alibaba Cloud OSS (used by the CLOUD side to store images) ────────────────
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    # e.g. https://oss-cn-hangzhou.aliyuncs.com
    oss_endpoint: str = ""
    oss_bucket: str = ""
    # Object key prefix for uploaded artifact images.
    oss_key_prefix: str = "artifacts/"
    # Public base URL for stored objects. Leave empty to derive from bucket+endpoint;
    # set to a custom domain / CDN if configured.
    oss_public_base_url: str = ""

    # ── Global exhibition catalog (separate PostgreSQL database) ────────────────
    exhibition_sync_enabled: bool = True
    exhibition_sync_hour: int = 3
    exhibition_sync_minute: int = 20
    exhibition_sync_timezone: str = "Asia/Shanghai"
    exhibition_sync_backfill_batch_size: int = 1000
    exhibition_sync_continuous_backfill: bool = True
    exhibition_sync_backfill_pause_seconds: int = 15
    exhibition_sync_retry_seconds: int = 600
    exhibition_sync_concurrency: int = 2
    exhibition_sync_commit_batch_size: int = 50
    exhibition_sync_commit_pause_seconds: float = 0.5
    exhibition_sync_request_timeout_seconds: int = 30
    exhibition_sync_user_agent: str = "MuseumImageDB-ExhibitionCatalog/1.0"

    # Generating a thumbnail can temporarily use hundreds of MiB when the source
    # is a high-resolution museum photograph. Keep this deliberately conservative
    # so a cold gallery cannot exhaust a small cloud instance.
    image_variant_concurrency: int = 1

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


settings = Settings()
