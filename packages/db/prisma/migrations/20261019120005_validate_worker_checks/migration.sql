-- ValidateConstraint
-- Kept separate from creation so PostgreSQL validates existing rows without holding an
-- ACCESS EXCLUSIVE lock on the attempts and computers tables for the duration of the scans.
ALTER TABLE "attempts" VALIDATE CONSTRAINT "attempts_worker_shape_check";
ALTER TABLE "computers" VALIDATE CONSTRAINT "computers_home_storage_check";
