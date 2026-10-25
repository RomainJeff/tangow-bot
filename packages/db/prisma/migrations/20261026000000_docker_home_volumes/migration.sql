-- A Docker computer's home can now live on worker volumes, as an E2B one's does.
ALTER TABLE "computers" DROP CONSTRAINT "computers_home_storage_check";
ALTER TABLE "computers" ADD CONSTRAINT "computers_home_storage_check" CHECK (
    "homeStorage" = 'snapshot' OR ("homeStorage" = 'volumes' AND "kind" IN ('e2b', 'docker'))
) NOT VALID;
