\set ON_ERROR_STOP on
begin;
do $test$
begin
  assert private.confirmed_test_purge_schema_hash() =
    (select schema_hash from private.confirmed_test_purge_schema where singleton),
    'Team Manager structure must preserve the guarded catalog fingerprint transition';
end;
$test$;
rollback;
