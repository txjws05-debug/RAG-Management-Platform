-- 知识库管理平台：PostgreSQL 16 + pgvector 初始化
-- 仅在数据卷首次创建时执行一次
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 校验
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector 扩展创建失败';
  END IF;
END $$;
