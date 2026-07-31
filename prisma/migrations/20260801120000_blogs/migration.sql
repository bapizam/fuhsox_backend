-- Blogs in the campus feed.
--
-- The feed used to be student posts plus an auto-generated "🏅 Earned the X
-- badge!" for every badge anyone unlocked, which drowned the posts people
-- actually wrote. Badge auto-posting is gone; campus events and staff-written
-- blogs now share the feed instead, so the things worth reading are where
-- students already look.
--
-- Only admins create these (enforced in the route layer, as for events).
CREATE TABLE "blogs" (
    "id"              TEXT NOT NULL,
    "institution_id"  TEXT NOT NULL,
    "created_by"      TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "excerpt"         TEXT,
    "body"            TEXT NOT NULL,
    "cover_image_url" TEXT,
    "category"        TEXT,
    "status"          "NewsStatus" NOT NULL DEFAULT 'draft',
    "published_at"    TIMESTAMP(3),
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blogs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "blogs_institution_id_published_at_idx"
    ON "blogs"("institution_id", "published_at");

ALTER TABLE "blogs"
    ADD CONSTRAINT "blogs_institution_id_fkey"
    FOREIGN KEY ("institution_id") REFERENCES "institutions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
