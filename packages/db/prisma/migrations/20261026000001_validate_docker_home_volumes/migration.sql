-- ValidateConstraint
-- Kept separate from creation so PostgreSQL validates existing rows without holding an
-- ACCESS EXCLUSIVE lock on the computers table for the duration of the scan.
ALTER TABLE "computers" VALIDATE CONSTRAINT "computers_home_storage_check";
