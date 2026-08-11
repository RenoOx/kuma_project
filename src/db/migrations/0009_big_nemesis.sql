-- Drops `priority` from knowledge_base. Product decision: the ordering lever was
-- never used in the real workflow, so entries are now ordered oldest-first.
--
-- NOT DATA-REVERSIBLE. The statements below roll back as a unit if the migration
-- fails, but once committed the priority values are gone — Postgres does not
-- retain a dropped column. This repo has no down migrations; undoing this means
-- hand-writing a follow-up that re-adds `priority integer NOT NULL DEFAULT 0`,
-- which restores the column with every row at 0, not the old values.
--
-- Before running this on prod, confirm there is nothing to lose:
--   SELECT count(*) FROM knowledge_base WHERE priority <> 0;
DROP INDEX "knowledge_base_business_category_idx";--> statement-breakpoint
CREATE INDEX "knowledge_base_business_category_idx" ON "knowledge_base" USING btree ("business_id","category");--> statement-breakpoint
ALTER TABLE "knowledge_base" DROP COLUMN "priority";
