# Git hooks

The pre-commit hook scans staged changes for secrets with gitleaks. It refuses
the commit when gitleaks is unavailable, reports an error, or finds a secret.

Enable the hooks in a clone or worktree with:

```sh
git config core.hooksPath .githooks
```

Agent tooling sets this configuration automatically.
