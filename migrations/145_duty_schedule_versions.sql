-- Versions preserve the exact calculation and input snapshots. Approval changes only state;
-- publication/delivery is a later feature and is deliberately not represented as approval here.
CREATE TABLE duty_schedule_versions (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE SET NULL,
  telegram_chat_id text NOT NULL,
  duty_date date NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded', 'cancelled')),
  base_approved_id uuid,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 300),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approval_evidence jsonb CHECK (approval_evidence IS NULL OR jsonb_typeof(approval_evidence) = 'object'),
  UNIQUE (family_id, telegram_chat_id, duty_date, version),
  UNIQUE (family_id, operation_key),
  CHECK (((snapshot->>'schemaVersion') = '1') IS TRUE),
  CHECK (((snapshot->>'id') = id::text) IS TRUE),
  CHECK (((snapshot->>'version') = version::text) IS TRUE),
  CHECK (((snapshot->>'familyId') = family_id::text) IS TRUE),
  CHECK (((snapshot#>>'{draft,date}') = to_char(duty_date, 'YYYY-MM-DD')) IS TRUE),
  CHECK (((snapshot#>>'{destination,telegramChatId}') = telegram_chat_id) IS TRUE),
  CHECK ((snapshot->>'baseApprovedId') IS NOT DISTINCT FROM base_approved_id::text),
  CHECK (status <> 'draft' OR (approved_at IS NULL AND approved_by IS NULL AND approval_evidence IS NULL)),
  CHECK (status NOT IN ('approved', 'superseded') OR approved_at IS NOT NULL),
  CHECK ((approved_at IS NULL) = (approval_evidence IS NULL))
);

CREATE UNIQUE INDEX duty_schedule_one_approved_day
  ON duty_schedule_versions (family_id, telegram_chat_id, duty_date) WHERE status = 'approved';
CREATE INDEX duty_schedule_history
  ON duty_schedule_versions (family_id, telegram_chat_id, duty_date) WHERE approved_at IS NOT NULL;

CREATE FUNCTION protect_duty_schedule_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Whole-family deletion follows its FK cascade; individual versions are archival records.
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'AGENT_DUTY_SNAPSHOT_IMMUTABLE: delete the family to remove its archive';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.group_id IS NULL THEN
      RAISE EXCEPTION 'AGENT_DUTY_VERSION_INVALID: a version starts as a draft in a registered group';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.family_id, NEW.telegram_chat_id, NEW.duty_date, NEW.version,
         NEW.base_approved_id, NEW.snapshot, NEW.content_hash, NEW.operation_key, NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.family_id, OLD.telegram_chat_id, OLD.duty_date, OLD.version,
         OLD.base_approved_id, OLD.snapshot, OLD.content_hash, OLD.operation_key, OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SNAPSHOT_IMMUTABLE: create another version';
  END IF;
  -- FK cleanup may unlink a removed account/group, while the original identities stay in JSON.
  IF (NEW.group_id IS DISTINCT FROM OLD.group_id AND NEW.group_id IS NOT NULL)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SNAPSHOT_IMMUTABLE: identity cannot be reassigned';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('approved', 'cancelled')) OR
    (OLD.status = 'approved' AND NEW.status IN ('superseded', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'AGENT_DUTY_VERSION_INVALID: invalid state transition';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL OR NEW.approval_evidence IS NULL THEN
      RAISE EXCEPTION 'AGENT_DUTY_VERSION_INVALID: approval evidence required';
    END IF;
  ELSIF ROW(NEW.approved_at, NEW.approval_evidence) IS DISTINCT FROM ROW(OLD.approved_at, OLD.approval_evidence)
     OR (NEW.approved_by IS DISTINCT FROM OLD.approved_by AND NEW.approved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SNAPSHOT_IMMUTABLE: approval evidence cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER duty_schedule_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON duty_schedule_versions
  FOR EACH ROW EXECUTE FUNCTION protect_duty_schedule_version();
