-- One durable attempt before any Google mutation; uncertain writes are never retried automatically.
CREATE TABLE duty_sheet_writes (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  profile_ref text NOT NULL,
  spreadsheet_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  approval_evidence jsonb NOT NULL CHECK (jsonb_typeof(approval_evidence) = 'object'),
  state text NOT NULL DEFAULT 'checking' CHECK (state IN ('checking', 'writing', 'applied', 'conflict', 'failed', 'unknown')),
  plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  write_started_at timestamptz,
  finished_at timestamptz,
  CHECK (((input->>'operationId') = id::text) IS TRUE),
  CHECK (((input#>>'{source,profileRef}') = profile_ref) IS TRUE),
  CHECK (((input#>>'{source,spreadsheetId}') = spreadsheet_id) IS TRUE),
  CHECK ((state IN ('checking', 'writing')) = (finished_at IS NULL)),
  CHECK (state NOT IN ('writing', 'applied', 'unknown') OR (plan IS NOT NULL AND write_started_at IS NOT NULL))
);
CREATE UNIQUE INDEX duty_sheet_one_pending_write ON duty_sheet_writes (spreadsheet_id)
  WHERE state IN ('checking', 'writing', 'unknown');
CREATE INDEX duty_sheet_write_archive ON duty_sheet_writes (family_id, created_at);

CREATE FUNCTION protect_duty_sheet_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN RAISE EXCEPTION 'AGENT_DUTY_SHEET_AUDIT_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'checking' OR NEW.plan IS NOT NULL OR NEW.write_started_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN
      RAISE EXCEPTION 'AGENT_DUTY_SHEET_STATE_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.family_id, NEW.profile_ref, NEW.spreadsheet_id, NEW.request_hash, NEW.input, NEW.approval_evidence, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.family_id, OLD.profile_ref, OLD.spreadsheet_id, OLD.request_hash, OLD.input, OLD.approval_evidence, OLD.created_at)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SHEET_AUDIT_IMMUTABLE';
  END IF;
  IF NEW.state = OLD.state THEN
    IF ROW(NEW.plan, NEW.write_started_at, NEW.finished_at, NEW.error_code) IS DISTINCT FROM
       ROW(OLD.plan, OLD.write_started_at, OLD.finished_at, OLD.error_code) THEN
      RAISE EXCEPTION 'AGENT_DUTY_SHEET_AUDIT_IMMUTABLE';
    END IF;
  ELSIF NOT ((OLD.state = 'checking' AND NEW.state IN ('writing', 'conflict', 'failed')) OR
             (OLD.state = 'writing' AND NEW.state IN ('applied', 'unknown'))) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SHEET_STATE_INVALID';
  END IF;
  IF OLD.state <> 'checking' AND ROW(NEW.plan, NEW.write_started_at) IS DISTINCT FROM ROW(OLD.plan, OLD.write_started_at) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SHEET_AUDIT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER duty_sheet_writes_immutable BEFORE INSERT OR UPDATE OR DELETE ON duty_sheet_writes
  FOR EACH ROW EXECUTE FUNCTION protect_duty_sheet_write();
