CREATE TABLE duty_sheet_reviews (
  operation_id uuid PRIMARY KEY REFERENCES duty_sheet_writes(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  approval_evidence jsonb NOT NULL CHECK (jsonb_typeof(approval_evidence) = 'object'),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  CHECK (((input->>'operationId') = operation_id::text) IS TRUE),
  CHECK (((snapshot->>'operationId') = operation_id::text) IS TRUE)
);
CREATE FUNCTION protect_duty_sheet_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN RAISE EXCEPTION 'AGENT_DUTY_SHEET_REVIEW_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.operation_id, NEW.family_id, NEW.input, NEW.request_hash, NEW.snapshot, NEW.approval_evidence, NEW.resolved_at)
     IS DISTINCT FROM ROW(OLD.operation_id, OLD.family_id, OLD.input, OLD.request_hash, OLD.snapshot, OLD.approval_evidence, OLD.resolved_at)
     OR (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by AND NEW.resolved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SHEET_REVIEW_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER duty_sheet_reviews_immutable BEFORE UPDATE OR DELETE ON duty_sheet_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_duty_sheet_review();

ALTER TABLE duty_sheet_writes DROP CONSTRAINT duty_sheet_writes_state_check;
ALTER TABLE duty_sheet_writes ADD CONSTRAINT duty_sheet_writes_state_check
  CHECK (state IN ('checking', 'writing', 'applied', 'conflict', 'failed', 'unknown', 'reviewed'));

CREATE OR REPLACE FUNCTION protect_duty_sheet_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.state = 'reviewed' AND OLD.state IN ('checking', 'writing', 'unknown') THEN
    IF NOT EXISTS (SELECT 1 FROM duty_sheet_reviews r WHERE r.operation_id = OLD.id AND r.family_id = OLD.family_id
      AND r.snapshot->>'state' = OLD.state AND r.snapshot->>'requestHash' = OLD.request_hash
      AND ((OLD.state = 'checking' AND r.input->>'decision' = 'cancel_unstarted') OR
           (OLD.state IN ('writing', 'unknown') AND r.input->>'decision' = 'accept_current' AND r.input->>'acknowledgeUncertainOutcome' = 'true')))
      OR NEW.plan IS DISTINCT FROM OLD.plan OR NEW.write_started_at IS DISTINCT FROM OLD.write_started_at
      OR NEW.error_code IS DISTINCT FROM OLD.error_code
      OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
      RAISE EXCEPTION 'AGENT_DUTY_SHEET_REVIEW_REQUIRED';
    END IF;
    RETURN NEW;
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
