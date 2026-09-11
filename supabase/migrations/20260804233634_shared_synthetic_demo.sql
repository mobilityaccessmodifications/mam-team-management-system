begin;

-- This legacy timestamp was superseded by 20260804233927 when commit 3fde910
-- aligned the local migration history. A later branch merge reintroduced the
-- byte-for-byte duplicate. Retain the version as a no-op so new databases do
-- not attempt to create the shared synthetic demo schema twice.

commit;
