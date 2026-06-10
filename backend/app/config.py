from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Museum Image DB API"
    app_env: str = "development"
    api_prefix: str = "/api"
    database_url: str = "postgresql+psycopg://museum:museum123@postgres:5432/museum_image_db"
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
    web_prompt: str = (
        "请识别这件文物：用相似图检索确认它的身份，然后告诉我它的名称、年代、"
        "所属博物馆或出土地、用途和历史背景。"
    )
    # Text model used to structure the web answer prose into DB JSON.
    web_structuring_model: str = "qwen-plus"

    # 通义 (qianwen.com)
    qwen_web_enabled: bool = False
    qwen_web_url: str = "https://www.qianwen.com/"
    qwen_web_storage_state: str = "/data/qwen_web_state.json"
    # CSS selector for rendered assistant answer blocks; tune against the live DOM.
    qwen_web_answer_selector: str = "[class*='markdown']"
    # Accessible name of the attach/upload control (file inputs are created lazily).
    qwen_web_attach_name: str = "添加附件"

    # 豆包 (doubao.com)
    doubao_web_enabled: bool = False
    doubao_web_url: str = "https://www.doubao.com/chat/"
    doubao_web_storage_state: str = "/data/doubao_web_state.json"
    doubao_web_answer_selector: str = "[class*='markdown']"
    doubao_web_attach_name: str = ""
    # Downscale local images before sending to the model (longest side, px). 0 disables.
    vision_max_image_dimension: int = 1280
    vision_image_jpeg_quality: int = 85

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


settings = Settings()
