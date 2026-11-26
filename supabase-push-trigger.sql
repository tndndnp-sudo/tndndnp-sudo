-- Run after deploying the Edge Function and saving two values in Supabase Vault:
--   push_function_url  = https://<project-ref>.supabase.co/functions/v1/send-message-push
--   push_webhook_secret = the same random value as Edge Function secret PUSH_WEBHOOK_SECRET
-- Enable the pg_net extension first (Database > Extensions). Vault is available in Supabase.
-- The secret is read at runtime; it is never hard-coded into this SQL file.

create or replace function public.enqueue_message_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  function_url text;
  webhook_secret text;
begin
  select ds.decrypted_secret into function_url
  from vault.decrypted_secrets as ds
  where ds.name = 'push_function_url'
  limit 1;

  select ds.decrypted_secret into webhook_secret
  from vault.decrypted_secrets as ds
  where ds.name = 'push_webhook_secret'
  limit 1;

  if coalesce(function_url, '') = '' or coalesce(webhook_secret, '') = '' then
    raise warning 'Push webhook is not configured in Vault; message was saved without a push event.';
    return new;
  end if;

  perform net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-webhook-secret', webhook_secret
    ),
    body := jsonb_build_object(
      'type', tg_op,
      'schema', tg_table_schema,
      'table', tg_table_name,
      'record', to_jsonb(new),
      'old_record', null
    ),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  -- Push delivery must never block sending a chat message.
  raise warning 'Could not enqueue push notification for message %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists enqueue_message_push_after_insert on public.messages;
create trigger enqueue_message_push_after_insert
after insert on public.messages
for each row execute function public.enqueue_message_push();
