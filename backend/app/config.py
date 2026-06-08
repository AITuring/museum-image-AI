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
    # Downscale local images before sending to the model (longest side, px). 0 disables.
    vision_max_image_dimension: int = 1280
    vision_image_jpeg_quality: int = 85

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


settings = Settings()
