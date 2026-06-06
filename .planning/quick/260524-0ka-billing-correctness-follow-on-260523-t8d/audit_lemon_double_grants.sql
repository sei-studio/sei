-- audit_lemon_double_grants.sql
--
-- Audit: find users who may have been double-credited by the lemon-webhook
-- bug fixed in 260524-0ka (subscription_created + subscription_payment_success
-- both inserting grants when only payment_success should; AND order_created
-- inserting a $4.75 pack grant on subscription-first-invoice deliveries).
--
-- Run as service_role in psql / Supabase dashboard SQL editor:
--
--   psql "$SUPABASE_DB_URL" -f audit_lemon_double_grants.sql
--
-- If running through MCP / a raw psql session that authenticates as the
-- `postgres` superuser, you MUST first elevate to service_role so the
-- ledger_balance view's WHERE clause (auth.role() = 'service_role') admits
-- your reads. See LEDGER-BALANCE-DIAGNOSIS.md §3 for the underlying reason.
--
--   set local role service_role;
--   -- then run the queries below.
--
-- Output: one row per affected user, with grant_id list, total duplicate
-- micro to refund, and the cluster timestamp. Operator reviews the list
-- and applies a manual refund via DELETE on the duplicate grant_ids (NOT
-- automated — operator decision per task constraint). Manual refund
-- template at the bottom of this file.
--
-- This script is READ-ONLY. No DELETE / UPDATE / TRUNCATE statements
-- execute. The audit-after-fix workflow:
--   1. Deploy the lemon-webhook fix (Task 2).
--   2. Run this script against production.
--   3. Hand the resulting candidate-refund rows to a human operator.
--   4. Operator runs DELETE statements (template at file end) per row.
--   5. Re-run this script; expect zero rows.

-- ──────────────────────────────────────────────────────────────────────────
-- Query 1: cluster detection — any user with >1 grant inside a 5-minute window.
-- The observed UAT bug fired all three grants inside ~60s for the affected
-- user; a 5-minute window is conservative enough to catch any clock-skew or
-- LS-delivery-retry edge cases while staying tight enough to avoid false
-- positives from legitimate recurring renewals (which are >= 1 month apart
-- by construction for the Party tier).
-- ──────────────────────────────────────────────────────────────────────────
with grant_pairs as (
  select
    g1.user_id,
    g1.id             as grant_id_1,
    g1.kind           as kind_1,
    g1.credits_micro  as micro_1,
    g1.granted_at     as granted_at_1,
    g1.lemon_event_id as event_id_1,
    g2.id             as grant_id_2,
    g2.kind           as kind_2,
    g2.credits_micro  as micro_2,
    g2.granted_at     as granted_at_2,
    g2.lemon_event_id as event_id_2
  from public.ledger_grants g1
  join public.ledger_grants g2
    on g2.user_id = g1.user_id
   and g2.id > g1.id  -- avoid (a,b) + (b,a) duplicates
   and g2.granted_at between g1.granted_at - interval '5 minutes'
                         and g1.granted_at + interval '5 minutes'
)
select
  user_id,
  count(*)                                          as cluster_grant_count,
  sum(distinct micro_2)::bigint                     as duplicate_micro_to_refund,
  array_agg(grant_id_2  order by granted_at_2)      as candidate_refund_grant_ids,
  array_agg(event_id_2  order by granted_at_2)      as candidate_event_ids,
  array_agg(kind_2      order by granted_at_2)      as candidate_kinds,
  min(granted_at_1)                                 as window_start,
  max(granted_at_2)                                 as window_end
from grant_pairs
group by user_id
order by cluster_grant_count desc, duplicate_micro_to_refund desc;

-- ──────────────────────────────────────────────────────────────────────────
-- Query 2: per-user grant inventory for the affected users above. Run after
-- Query 1 to see the full per-user grant timeline before deciding which
-- grant_ids to refund. Replace `<USER_UUID>` with each user_id from Query 1.
-- ──────────────────────────────────────────────────────────────────────────
-- select
--   id, kind, credits_micro, source, lemon_event_id, granted_at
-- from public.ledger_grants
-- where user_id = '<USER_UUID>'
-- order by granted_at asc;

-- ──────────────────────────────────────────────────────────────────────────
-- Manual refund template (DO NOT RUN BLINDLY — operator review each row from
-- Query 1, paste the candidate_refund_grant_ids array into the IN clause).
-- ──────────────────────────────────────────────────────────────────────────
-- delete from public.ledger_grants where id in (
--   '<uuid_1>',
--   '<uuid_2>'
-- );
-- After deletion, ledger_balance view auto-recomputes the affected user's
-- balance on next read (it's a regular view, not materialized). Customer
-- notification is the operator's responsibility (out of scope for this
-- audit script).
