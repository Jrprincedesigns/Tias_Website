# Local repo setup notes

## Git push / dual GitHub identity on this machine

This repo lives under the `Jrprincedesigns` GitHub account (the one `gh` is authed as on this machine), but the global `~/.gitconfig` has:

```
[url "git@github.com:"]
    insteadOf = https://github.com/
```

…which rewrites every HTTPS GitHub URL to SSH, and the only SSH key on this machine (`~/.ssh/id_ed25519_github`) is registered to a different GitHub account (`Lennox-The-Designer`). Result: pushes to `Jrprincedesigns/*` repos fail with `Permission denied to Lennox-The-Designer` unless overridden.

Workaround applied locally to this repo (`.git/config`):

```
[url "https://github.com/"]
    insteadOf = git@github.com:
```

This reverses the rewrite for this repo only, so `git push` resolves to HTTPS and uses the `gh` credential helper (Jrprincedesigns token). No global config was changed.

For any *new* repos created under `Jrprincedesigns` on this machine, repeat the same local override, OR fix it globally by adding a `Jrprincedesigns` SSH key and routing via `~/.ssh/config`, OR remove the global `insteadOf` rule.
