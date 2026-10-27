-- Org-wide switch for China-based model providers (OpenRouter hosts such as
-- Z.AI, DeepSeek, Alibaba, Baidu, StreamLake). On by default; when off, those
-- hosts are excluded from every OpenRouter request made for the org.
ALTER TABLE "organizations" ADD COLUMN "allow_china_providers" boolean DEFAULT true NOT NULL;
