CREATE TABLE duty_sheet_sources (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE SET NULL,
  telegram_chat_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  approval_evidence jsonb NOT NULL CHECK (jsonb_typeof(approval_evidence) = 'object'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, group_id, version),
  CHECK (((input->>'operationId') = id::text) IS TRUE),
  CHECK (group_id IS NULL OR ((input->>'groupId') = group_id::text) IS TRUE),
  CHECK ((((input->>'expectedVersion')::integer + 1) = version) IS TRUE)
);
CREATE FUNCTION protect_duty_sheet_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN RAISE EXCEPTION 'AGENT_DUTY_SOURCE_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.family_id, NEW.telegram_chat_id, NEW.version, NEW.request_hash, NEW.input, NEW.approval_evidence, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.family_id, OLD.telegram_chat_id, OLD.version, OLD.request_hash, OLD.input, OLD.approval_evidence, OLD.created_at)
     OR (NEW.group_id IS DISTINCT FROM OLD.group_id AND NEW.group_id IS NOT NULL)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AGENT_DUTY_SOURCE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER duty_sheet_sources_immutable BEFORE UPDATE OR DELETE ON duty_sheet_sources
  FOR EACH ROW EXECUTE FUNCTION protect_duty_sheet_source();
