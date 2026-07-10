---
paths:
  - "**/*.rs"
  - "Cargo.toml"
  - "build.rs"
---

# Build Setup

macOS builds need Homebrew LLVM. Set the prefix:

```bash
export LLVM_SYS_211_PREFIX=/opt/homebrew/opt/llvm@22
```

`bisect_test.sh` sets this automatically. If builds fail with header-not-found
errors, verify the path with `brew list llvm`.
