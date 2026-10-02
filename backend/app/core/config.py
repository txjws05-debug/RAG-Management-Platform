"""全局配置：全部来自环境变量，便于 Docker / 本地一致运行。"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---------- 基础 ----------
    APP_NAME: str = "知识库管理平台"
    API_PREFIX: str = "/api"
    DEBUG: bool = False
    TZ: str = "Asia/Shanghai"

    # ---------- 数据库 ----------
    DATABASE_URL: str = "postgresql+asyncpg://kb:kb_pass@localhost:5432/kb"

    # ---------- 鉴权 ----------
    SECRET_KEY: str = "dev-only-change-me"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 720
    BOOTSTRAP_ADMIN_USERNAME: str = "admin"
    BOOTSTRAP_ADMIN_PASSWORD: str = "admin123456"

    # ---------- AI：OpenAI 兼容 ----------
    LLM_BASE_URL: str = "https://api.deepseek.com/v1"
    LLM_API_KEY: str = ""
    LLM_CHAT_MODEL: str = "deepseek-chat"
    LLM_TEMPERATURE: float = 0.2
    LLM_MAX_TOKENS: int = 1024
    LLM_TIMEOUT_SECONDS: int = 120
    LLM_OFFLINE_FALLBACK: bool = True

    EMBEDDING_BASE_URL: str = "https://api.openai.com/v1"
    EMBEDDING_API_KEY: str = ""
    EMBEDDING_MODEL: str = "text-embedding-3-small"
    EMBEDDING_DIM: int = 1024
    EMBEDDING_BATCH_SIZE: int = 32

    # ---------- 检索与切片 ----------
    CHUNK_SIZE: int = 520
    CHUNK_OVERLAP: int = 80
    RETRIEVE_TOP_K: int = 8
    HYBRID_VECTOR_WEIGHT: float = 0.65
    HYBRID_KEYWORD_WEIGHT: float = 0.35
    # 低于该相似度视为「未命中」→ 计入知识缺口
    # 默认 0 表示按嵌入模式自动取值（本地哈希嵌入的余弦分布比真实语义模型紧凑得多）
    # 注意：这里比较的是「归一化前的原始相似度」，因为它才是跨查询可比的绝对置信度；
    # 归一化融合分恒有最高值 1.0，不能用来判「未命中」。
    CONFIDENCE_THRESHOLD: float = 0.0
    # 以下 LOCAL_*/REMOTE_* 为内部标定值，刻意不与 .env 的变量名同名，
    # 避免旧版 .env 里的陈旧数值通过环境变量把代码默认值覆盖掉。
    LOCAL_CONFIDENCE_THRESHOLD: float = 0.14
    REMOTE_CONFIDENCE_THRESHOLD: float = 0.30

    # ---------- FAQ 沉淀 ----------
    # 同样支持自动取值：统一使用 0.86 这类高阈值会导致
    # 「聚类不出高频问题」与「FAQ 缓存永不命中」两个故障同时发生。
    FAQ_CLUSTER_SIMILARITY: float = 0.0
    LOCAL_CLUSTER_SIMILARITY: float = 0.45
    REMOTE_CLUSTER_SIMILARITY: float = 0.86
    FAQ_CACHE_MATCH_THRESHOLD: float = 0.0
    LOCAL_CACHE_MATCH_THRESHOLD: float = 0.55
    REMOTE_CACHE_MATCH_THRESHOLD: float = 0.92
    FAQ_MIN_FREQUENCY: int = 3
    FAQ_CACHE_ENABLED: bool = True
    FAQ_CACHE_TTL_SECONDS: int = 300

    # ---------- 上传 ----------
    DATA_DIR: str = "/data"
    MAX_UPLOAD_MB: int = 50
    ALLOWED_EXTENSIONS: str = ".pdf,.md,.markdown,.docx,.txt"

    # ---------- 派生属性 ----------
    @property
    def upload_dir(self) -> Path:
        path = Path(self.DATA_DIR) / "uploads"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def allowed_extensions(self) -> set[str]:
        return {e.strip().lower() for e in self.ALLOWED_EXTENSIONS.split(",") if e.strip()}

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @property
    def llm_enabled(self) -> bool:
        return bool(self.LLM_API_KEY)

    @property
    def remote_embedding_enabled(self) -> bool:
        return bool(self.EMBEDDING_API_KEY)

    # ---------- 阈值解析（按嵌入模式自动取值） ----------
    @property
    def effective_confidence_threshold(self) -> float:
        if self.CONFIDENCE_THRESHOLD > 0:
            return self.CONFIDENCE_THRESHOLD
        return (
            self.REMOTE_CONFIDENCE_THRESHOLD
            if self.remote_embedding_enabled
            else self.LOCAL_CONFIDENCE_THRESHOLD
        )

    @property
    def effective_cluster_similarity(self) -> float:
        if self.FAQ_CLUSTER_SIMILARITY > 0:
            return self.FAQ_CLUSTER_SIMILARITY
        return (
            self.REMOTE_CLUSTER_SIMILARITY
            if self.remote_embedding_enabled
            else self.LOCAL_CLUSTER_SIMILARITY
        )

    @property
    def effective_cache_threshold(self) -> float:
        if self.FAQ_CACHE_MATCH_THRESHOLD > 0:
            return self.FAQ_CACHE_MATCH_THRESHOLD
        return (
            self.REMOTE_CACHE_MATCH_THRESHOLD
            if self.remote_embedding_enabled
            else self.LOCAL_CACHE_MATCH_THRESHOLD
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
