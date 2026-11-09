import { reapCheckouts, wtRoots } from "./extensions/lib/checkout-reaper.ts";
import { removeWorktreeTree } from "./extensions/subagent-async/worktree.ts";
const roots = wtRoots();
const t0 = Date.now();
const { report } = await reapCheckouts({ root: roots.root, subagentBase: roots.subagentBase, metaDir: "/tmp", dryRun: true, removeWorktree: (d, r, p) => removeWorktreeTree(d, r, p) });
console.log("total", Date.now() - t0, "ms, report", report.elapsedMs);
