-- Invariants that SQLite cannot express as a plain column constraint.

-- Exactly one principal may be the owner. A partial unique index turns the
-- "first login binds, and only the first" rule into a database invariant rather
-- than application logic that a race could bypass.
CREATE UNIQUE INDEX principals_single_owner_idx ON principals (is_owner)
  WHERE is_owner = 1;

-- One live classification per message. Superseded rows keep their history but
-- only the newest is 'live'; enforced by status, which migration 0003 tightens.
CREATE UNIQUE INDEX classifications_live_per_message_idx
  ON classifications (account_id, gmail_message_id)
  WHERE status = 'complete';

-- One correction revision per message. This is the compare-and-set guard that
-- allocates monotonic revisions under concurrent submissions.
CREATE UNIQUE INDEX corrections_one_revision_idx
  ON corrections (account_id, gmail_message_id, revision);
