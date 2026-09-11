begin;

-- This legacy timestamp was superseded by 20260804235031 when commit 3fde910
-- aligned the local migration history. The canonical migration owns the reset
-- hardening; replaying both versions breaks a clean database bootstrap.

commit;
