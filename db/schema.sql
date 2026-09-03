CREATE TABLE IF NOT EXISTS test_runs (
  id SERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  run_timestamp TIMESTAMPTZ NOT NULL,
  form_url TEXT NOT NULL,
  form_name TEXT NOT NULL,
  device TEXT NOT NULL,              -- desktop | tablet | mobile
  category TEXT NOT NULL,            -- functional | layout | visual | accessibility | availability
  status TEXT NOT NULL,              -- pass | fail | at_risk | error
  severity TEXT,                     -- low | medium | high (null if pass)
  description TEXT,
  screenshot_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_runs_run_id ON test_runs (run_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_run_timestamp ON test_runs (run_timestamp DESC);
