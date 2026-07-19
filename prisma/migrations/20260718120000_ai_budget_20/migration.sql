-- Lower the shared per-user daily AI budget (question generation + study plan +
-- quiz feedback) default from 50 to 20, and apply it to institutions that are
-- still on the old default. Rows deliberately set to any other value are left
-- untouched.
ALTER TABLE "institutions" ALTER COLUMN "ai_daily_limit" SET DEFAULT 20;
UPDATE "institutions" SET "ai_daily_limit" = 20 WHERE "ai_daily_limit" = 50;
