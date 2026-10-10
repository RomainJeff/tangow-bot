-- A run's skill lines are written once. Recorded on the run rather than read back from its
-- messages, so a conversation the user cleared or rewound does not get them again.
ALTER TABLE "runs" ADD COLUMN "skillLinesAt" TIMESTAMP(3);
