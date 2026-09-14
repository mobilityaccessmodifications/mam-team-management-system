begin;

-- The former test-login ticket flow was replaced by the non-impersonating
-- Change profile projection and no current application route redeems these
-- tickets. Keep the legacy function for migration-history compatibility, but
-- remove browser-role execution so an obsolete capability is not exposed by
-- PostgREST. The service role remains available for controlled administration.
do $$
begin
  if to_regprocedure('public.redeem_portal_test_session_ticket(text)') is not null then
    execute 'revoke all on function public.redeem_portal_test_session_ticket(text) from public, anon, authenticated';
    execute $comment$
      comment on function public.redeem_portal_test_session_ticket(text) is
        'Legacy one-use test-session ticket redemption retained for migration compatibility. Browser execution was removed after Change profile replaced Auth impersonation.'
    $comment$;
  end if;
end;
$$;

-- Own-request and reviewer visibility are permissive OR branches of the same
-- SELECT rule. Combining them preserves the authorization logic while making
-- PostgreSQL evaluate one policy per authenticated read.
drop policy if exists leave_requests_select_own on public.leave_requests;
drop policy if exists leave_requests_select_reviewer on public.leave_requests;
drop policy if exists leave_requests_select_authorized on public.leave_requests;
create policy leave_requests_select_authorized
  on public.leave_requests for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (
      (select auth.uid()) = user_id
      or private.can_review_leave_request(id)
    )
  );

commit;
