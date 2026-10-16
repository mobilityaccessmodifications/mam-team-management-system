SELECT jsonb_build_object(
  'openclaw', (SELECT to_jsonb(c) FROM private.openclaw_leave_release_gate c),
  'delivery', (SELECT to_jsonb(c) FROM private.notification_delivery_control c),
  'subscription', (SELECT to_jsonb(c) FROM private.subscription_request_config c),
  'purge', (SELECT to_jsonb(c) FROM private.confirmed_test_purge_schema c)
) AS state
