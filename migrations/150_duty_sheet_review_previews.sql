CREATE TABLE duty_sheet_review_previews (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES duty_sheet_writes(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  view jsonb NOT NULL CHECK (jsonb_typeof(view) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (((input->>'operationId') = operation_id::text) IS TRUE),
  CHECK (((view->>'operationId') = operation_id::text) IS TRUE)
);
CREATE FUNCTION protect_duty_sheet_review_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN RAISE EXCEPTION 'AGENT_DUTY_REVIEW_PREVIEW_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.operation_id, NEW.family_id, NEW.input, NEW.view, NEW.content_hash, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.operation_id, OLD.family_id, OLD.input, OLD.view, OLD.content_hash, OLD.created_at)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AGENT_DUTY_REVIEW_PREVIEW_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER duty_sheet_review_previews_immutable BEFORE UPDATE OR DELETE ON duty_sheet_review_previews
  FOR EACH ROW EXECUTE FUNCTION protect_duty_sheet_review_preview();
