import { createDcgGuard } from "./_dcg-guard/dist/index.js";

// Owner-authored trusted configuration. Replace these placeholders before use.
// This state root must be separate from existing owner DCG config and data.
// Provision comment-only policy files; keep config/dcg/allowlist.toml absent.
const binaryPath = "/absolute/path/to/dcg";
const evaluatorRoot = "/absolute/path/to/dcg-guard-state";
const evaluatorEnv = {
  HOME: `${evaluatorRoot}/home`,
  XDG_CONFIG_HOME: `${evaluatorRoot}/config`,
  XDG_DATA_HOME: `${evaluatorRoot}/data`,
  DCG_CONFIG: `${evaluatorRoot}/policy.toml`,
  DCG_ALLOWLIST_SYSTEM_PATH: `${evaluatorRoot}/system-allowlist.toml`,
  DCG_ALLOW_ONCE_PATH: `${evaluatorRoot}/data/allow-once.jsonl`,
  DCG_PENDING_EXCEPTIONS_PATH: `${evaluatorRoot}/data/pending-exceptions.jsonl`,
};

export default function dcgGuard() {
  return createDcgGuard({ binaryPath, evaluatorEnv });
}
