CREATE TABLE duty_sheet_change_previews (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (((input->>'operationId') = id::text) IS TRUE),
  CHECK (((input#>>'{binding,groupId}') = group_id::text) IS TRUE)
);
CREATE FUNCTION protect_duty_sheet_change_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN RAISE EXCEPTION 'AGENT_DUTY_PREVIEW_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.family_id, NEW.group_id, NEW.input, NEW.plan, NEW.content_hash, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.family_id, OLD.group_id, OLD.input, OLD.plan, OLD.content_hash, OLD.created_at)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AGENT_DUTY_PREVIEW_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER duty_sheet_change_previews_immutable BEFORE UPDATE OR DELETE ON duty_sheet_change_previews
  FOR EACH ROW EXECUTE FUNCTION protect_duty_sheet_change_preview();
