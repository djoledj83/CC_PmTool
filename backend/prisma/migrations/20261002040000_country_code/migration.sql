-- Optional 3-letter code per country, used in project codes
-- (P26-USA-0001). NULL = automatic ISO 3166 alpha-3 for the name.
ALTER TABLE "CountryOption" ADD COLUMN IF NOT EXISTS "code" TEXT;
