"""Runtime settings for the V2-only API."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_ENV: str = "prod"
    LOG_LEVEL: str = "INFO"
    REQUEST_TIMEOUT_SECONDS: int = 15
    SEARCH_CACHE_TTL_SECONDS: int = 900
    CORS_ALLOWED_ORIGINS: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def cors_origins(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.CORS_ALLOWED_ORIGINS.split(",")
            if origin.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
