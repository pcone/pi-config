/**
 * A stand-in `scripts/wo_record.py` for the record tests, behaving like the real tool where the
 * harness depends on it:
 *
 * - it writes into the repo that holds the script (`records_core.REPO` is the script's parent's
 *   parent), not the caller's cwd — which is why the harness resolves the script from the record's
 *   cwd at all;
 * - it prints `appended <kind> to <absolute path>`, the only place the harness learns where a
 *   record lives;
 * - `summary <wo-id> --json` reports the entries the record file holds, and fails (exit 1) when the
 *   record does not exist — a missing record is an error there, never an empty entry list
 *   (tfd `scripts/wo_record.py:840-856,943-945`);
 * - `append` refuses every kind but `dispatch` for a record that does not exist yet, which is why
 *   the first write a record ever takes is its dispatch.
 *
 * Control files in the repo decide the failure cases:
 * - `fail-on` holding a kind: that append is refused (exit 1);
 * - `noop-on` holding a kind: that append reports the tool's own "already recorded" no-op and
 *   writes nothing;
 * - `summary-shape` holding `entries-not-array` or `not-json`: `summary` answers that instead of
 *   the record's entries.
 *
 * Every append is logged to `calls.jsonl` so a row can read the argv and body it received.
 */
export const WO_RECORD_STUB = `#!/usr/bin/env python3
import json, os, re, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
log = os.path.join(root, "calls.jsonl")

def control(name):
    path = os.path.join(root, name)
    return open(path).read().strip() if os.path.exists(path) else None

def record_path(repo, wo_id):
    return os.path.join(repo, "work-orders", "records", wo_id + ".md")

def entries(text):
    out, cur = [], None
    for line in text.splitlines():
        heading = re.match(r"^## (\\w+) — ", line)
        if heading:
            cur = {"kind": heading.group(1), "keys": {}}
            out.append(cur)
            continue
        key = re.match(r"^([a-z_]+): (.*)$", line)
        if cur is not None and key:
            cur["keys"][key.group(1)] = key.group(2)
    return out

if sys.argv[1] == "summary":
    path = record_path(root, sys.argv[2])
    if not os.path.exists(path):
        print("wo_record: no record at " + path, file=sys.stderr)
        sys.exit(1)
    shape = control("summary-shape")
    if shape == "entries-not-array":
        print(json.dumps({"status": "open", "entries": {"dispatch": 1}}))
        sys.exit(0)
    if shape == "not-json":
        print("not json")
        sys.exit(0)
    print(json.dumps({"status": "open", "entries": entries(open(path).read())}))
    sys.exit(0)

wo_id, kind = sys.argv[2], sys.argv[3]
keys, rest = {}, sys.argv[4:]
while rest:
    flag = rest.pop(0)
    keys[flag.lstrip("-").replace("-", "_")] = rest.pop(0)
body = sys.stdin.read()
with open(log, "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "body": body}) + "\\n")

refused = control("fail-on")
if refused == kind:
    print("stub refused " + kind, file=sys.stderr)
    sys.exit(1)

path = record_path(root, wo_id)
noop = control("noop-on")
if noop == kind:
    print("%s already recorded in %s (same implementer and wo_blob); nothing appended" % (kind, path))
    sys.exit(0)

if not os.path.exists(path) and kind != "dispatch":
    print("wo_record: no record for " + wo_id + ": its first entry is a dispatch", file=sys.stderr)
    sys.exit(1)

entry = ["", "## %s — 2026-10-17T10:00:00Z" % kind] + ["%s: %s" % kv for kv in keys.items()]
entry += ["", "**body**", "\`\`\`", body.rstrip("\\n"), "\`\`\`", ""]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "a") as f:
    f.write("\\n".join(entry) + "\\n")
print("appended %s to %s" % (kind, path))
`;
