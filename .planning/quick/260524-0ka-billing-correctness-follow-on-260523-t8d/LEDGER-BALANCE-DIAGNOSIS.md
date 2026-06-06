# LEDGER-BALANCE-DIAGNOSIS — why `ledger_balance` returns NULL for some users

**Quick:** 260524-0ka
**Item:** C (ledger_balance NULL investigation)
**Owner:** quick-task executor
**Status:** analysis complete — Verdict: Branch B (doc-only contract) recommended for Task 5

---

## 1. Current view DDL (verbatim from `supabase/migrations/20260525000000_ledger_balance_restrict.sql`)

```sql
create or replace view public.ledger_balance as
select
  u.id as user_id,
  coalesce((select sum(credits_micro)
            from public.ledger_grants g
            where g.user_id = u.id), 0)::bigint
  - coalesce((select sum(c.micro)
              from public.ledger_consumption c
              where c.user_id = u.id
                and c.reservation_state in ('reserved','settled')), 0)::bigint
  as balance_micro
from auth.users u
where auth.uid() = u.id
   or auth.role() = 'service_role';

grant select on public.ledger_balance to authenticated, service_role;
```

Annotation by clause:

| Clause | Behavior |
|--------|----------|
| `from auth.users u` | **Enumerates ALL users** as the OUTER row source. Important: a SELECT against this view CAN ONLY return rows for users who exist in `auth.users`. A user UUID that was hard-deleted (or that never existed) yields **zero rows**. |
| `coalesce((select sum(credits_micro) … ), 0)::bigint` | Inner subquery; for the matched user, summed grants — or 0 when the user has no grants yet. **Inside the row, balance_micro is therefore never NULL** — only the entire row's presence/absence is the variable. |
| `- coalesce((select sum(c.micro) … reservation_state in ('reserved','settled')), 0)::bigint` | Subtract reserved+settled consumption; refunded rows excluded. Also coalesced — cannot be NULL inside an emitted row. |
| `where auth.uid() = u.id or auth.role() = 'service_role'` | **Filter for caller identity.** Authenticated callers see only their own row (RLS-style on the view directly); service_role callers see every row. If neither condition matches, the view emits **zero rows** for the requested user_id, which the caller then sees as NULL after `.maybeSingle()`. |

---

## 2. Test cases — what does the view return?

| Caller / target user | Auth context | Expected return |
|----------------------|--------------|-----------------|
| Authenticated user X reads their own row | `auth.uid() = X` | One row, `balance_micro = grants − consumption` (or 0 if no grants/consumption). |
| Authenticated user X reads user Y's row | `auth.uid() = X ≠ Y` | **Zero rows** (filter excludes; `.maybeSingle()` → NULL). |
| `service_role` reads any user's row | `auth.role() = 'service_role'` | One row per the math. |
| MCP / psql session with no `auth.role()` literal | `auth.role()` returns `NULL` or `'postgres'` | **Zero rows** (neither branch of the WHERE matches). |
| Caller asks for a user_id that doesn't exist in `auth.users` | (any) | **Zero rows** — outer FROM has no match. This is identical to "user hard-deleted from auth.users." |

Two distinct "NULL" outcomes are folded together:
- **NULL #1:** target user has no `auth.users` row (deleted or never existed). The view emits zero rows; `.maybeSingle()` returns `{ data: null, error: null }`. Caller should treat as zero balance.
- **NULL #2:** caller's auth context doesn't pass the WHERE filter (wrong role/session). The view emits zero rows; `.maybeSingle()` returns `{ data: null, error: null }`. Caller should treat as an authorization mismatch, NOT zero balance — but our code path coalesces both to `0n` (line 251 in `src/main/cloud/proxyClient.ts`).

---

## 3. Root cause hypothesis

The MCP-reported NULL ("a SELECT against `ledger_balance` returned NULL for
a specific user with non-zero grants") is **NULL #2** — the MCP postgres
session uses the project's `postgres` superuser role directly, which causes
`auth.role()` to return `'postgres'` (or NULL) rather than the literal
string `'service_role'`. The view's WHERE clause therefore filters out
**every** row for the MCP caller, including rows that genuinely have
non-zero grants in `ledger_grants`.

To verify in a future session (does not need to land in this task):

```sql
-- Run inside an MCP / psql session to see what auth.role() returns
select auth.role(), auth.uid();
-- Then set the role explicitly:
set local role service_role;
select balance_micro from public.ledger_balance where user_id = '<UUID>';
-- After `set local role service_role`, the row should appear.
```

The MCP postgres role is **not** the same as the supabase-js client's
service_role — supabase-js connects through PostgREST, which sets the
`request.jwt.claim.role` GUC to `'service_role'` from the JWT, and
`auth.role()` reads that GUC. A raw psql/MCP session never goes through
PostgREST, so the GUC is unset → `auth.role()` ≠ `'service_role'`.

### Production code paths

`src/main/cloud/proxyClient.ts:getClient()` uses the **anon key + the user's
own JWT** (PKCE-issued session). When that JWT is present, `auth.uid()`
returns the user's UUID and the first half of the WHERE clause matches —
the view emits the user's own row. **No NULL** in this path for an
existing-and-self-querying user.

`proxy/src/ledger/balance.ts:remainingPct()` uses `getAdminClient()`
(service_role key). PostgREST sets `request.jwt.claim.role = 'service_role'`
from the service-role JWT → `auth.role() = 'service_role'` matches the
second half of the WHERE clause → the view emits the requested user's row.
**No NULL** in this path either, modulo the deleted-user edge case.

Both production readers therefore see **NULL #1 only**, and both already
coalesce that to `0n` (proxyClient.ts:251 `balanceRaw ?? 0`; balance.ts:44
`balanceRaw === undefined || balanceRaw === null ? 0n : BigInt(balanceRaw)`).

---

## 4. Verdict

**Branch B — doc-only contract. NO migration required.**

Reasoning:
- The MCP NULL is a **tooling quirk**, not a production behavior. Direct
  psql/MCP sessions don't go through PostgREST and therefore can't satisfy
  `auth.role() = 'service_role'`. Operators who need to inspect
  `ledger_balance` from the MCP must `set local role service_role` for the
  session (documented in the audit SQL header in
  `audit_lemon_double_grants.sql`).
- Both production readers (renderer-side via the user's JWT, proxy-side
  via service_role JWT) already coalesce NULL → 0 with documented semantics
  ("no auth.users row OR no grants yet → 0 balance, which renders as
  'depleted' plan label").
- Branch A (broadening the WHERE clause) carries non-zero risk: any rewrite
  that loosens the filter must NOT accidentally allow authenticated users
  to read other users' balances (T-260524-0ka-05 — Elevation of Privilege).
  The current clause is intentionally tight; the cost of a verification
  miss is higher than the cost of documenting the MCP-side quirk.
- Adding a `current_user = 'service_role'` backstop (one proposed Branch A
  shape) does nothing for the MCP-side query: MCP authenticates as the
  `postgres` superuser, not as `service_role`, so `current_user` returns
  `'postgres'` too.

### What Task 5 will land

A code comment block above the `.from('ledger_balance')` call in
`src/main/cloud/proxyClient.ts` (currently lines 225-229) that:
- explicitly states the NULL contract ("NULL is the no-grants-yet sentinel
  for self-reads, or the user-doesn't-exist sentinel for service-role reads;
  coalesced to `0` via `?? 0` on line ~251");
- references THIS diagnosis doc;
- notes the MCP-side tooling quirk so a future maintainer who SELECTs the
  view via MCP and sees NULL doesn't go on a Wild Goose Chase looking for
  a non-existent bug.

---

## 5. Regression-risk table (Branch A only — recorded for the record)

If a future maintainer decides Branch B is insufficient and elects to ship
Branch A anyway, every `ledger_balance` reader must be re-verified.
Discovered via `grep -rn "from('ledger_balance')\|from(\"ledger_balance\")\|FROM ledger_balance" src/ proxy/ supabase/` (run on 2026-05-24):

| Reader | Path | Auth context | Branch A risk |
|--------|------|--------------|--------------|
| `creditsGet` | `src/main/cloud/proxyClient.ts:226` | anon key + user JWT (`auth.uid() = self`) | Low — current WHERE already works for this path. |
| `remainingPct` | `proxy/src/ledger/balance.ts:37` | service_role JWT (`auth.role() = 'service_role'`) | Low — current WHERE already works for this path. |
| `reserve_credits` RPC | `supabase/migrations/20260524000000_phase_13_ledger.sql:224` | SECURITY DEFINER, runs as definer's role | Defines its own balance read via the view's name but inside a SECURITY DEFINER function, which runs as the function-owner role (typically `postgres` or service_role at definition time). Branch A must verify the function-owner role still satisfies the WHERE filter; current clause does (postgres superuser bypasses RLS but the WHERE on a regular view is NOT an RLS policy — it's a CASE expression). **This is the highest-risk reader to validate under Branch A.** |

Branch B (the recommended path) carries zero regression risk for any of
the above — no production code changes.

---

## 6. Disposition

- Verdict: **Branch B (doc-only)**.
- Task 5 will:
  1. Add the doc-comment block above the `.from('ledger_balance')` call in
     `proxyClient.ts`.
  2. Add three C3 vitest cases covering NULL / positive-no-consumption /
     mid-reservation `ledger_balance` shapes, all asserting no-throw from
     `creditsGet()` and the right `plan` / `remaining_*` shape.
  3. **Skip the migration** — none required.
- No code paths in production currently emit NULL #2 (the role-mismatch
  branch). All current emit-NULL paths are NULL #1 (user doesn't exist /
  has no grants yet), which the `?? 0` coalesce handles correctly.
- The MCP-side workaround (`set local role service_role;` before the
  SELECT) is documented in the audit SQL header.
