# pi-for

A [pi](https://github.com/earendil-works/pi) extension that adds a `$for@`
prompt-loop editor feature with variable insertion.

## What it does

While composing a message, write `$for@` (dollar + `for` + at-sign). Vanilla pi
only opens its fuzzy file/directory search when `@` follows a space; this
extension additionally opens that **same** fuzzy search when `@` follows
`$for`. Pick a path and the in-editor command becomes `$for@<file-or-dir>`.

When such a message is submitted, the extension runs a **prompt loop**:

- **Directory** — if the path points to a directory, the loop iterates over all
  of its child elements (files and subdirectories, excluding dotfiles). Each
  iteration replaces the full `$for@<dir>` token with `<dir>/<child>` (directories
  keep a trailing slash), e.g. `$for@./skills/` → `./skills/karate/`.
- **File (lines)** — if the path points to a file, the loop iterates over every
  line of the file. Each iteration replaces the full `$for@<file>` token with the
  corresponding line.

Iterations run strictly sequentially (no parallelism). The first iteration is
sent as a normal message. Every following iteration **forks** the session from
the previous conversation (position `before`) so the previous message is
replaced while the earlier conversation context is preserved, then sends the
next replacement.

While the loop runs, a hint is shown in the same region the UI normally uses for
queued messages, e.g.:

```
for-loop · 2/5 · directory
↳ ./skills/baking
```

## Example

Given two subdirectories `karate` and `baking` inside `./skills/`:

```
User:  Have a look at the readme
Pi:    (acknowledges)
User:  Please reword the skill in $for@./skills/ and make it more polite
```

This expands to:

```
User:  Please reword the skill in ./skills/karate/ and make it more polite
       ... (wait for answer) ...
       fork → replace last message
User:  Please reword the skill in ./skills/baking/ and make it more polite
```

## Design notes

- This is an **editor feature, not a slash command** — no command is registered.
  The loop is driven entirely from the `input` event handler.
- The **fork semantic is required, but the `/fork` command is not used**. The
  fork is re-implemented at a lower level by calling `SessionManager.branch()` to
  move the active leaf back to the pre-loop conversation, then
  `pi.sendUserMessage()` to append the next iteration as a fresh branch. This
  reproduces the fork behaviour (each iteration has the same base context; the
  previous iteration's message is replaced) without switching session files and
  without any slash command.
- The `$for@` fuzzy search reuses pi's built-in fuzzy file/directory provider
  (`CombinedAutocompleteProvider.getFuzzyFileSuggestions`) via a wrapping
  `AutocompleteProvider`, with a `readdir` fallback. The editor is extended so
  that typing `$for@` opens that search exactly as `@` after a space does.
- The full token — starting at the dollar sign and including `for`, `@` and the
  path, up to (but not including) the first following whitespace — is replaced by
  the iteration value. Not just the path.

## Install

```bash
pi install git:github.com/jejay/pi-for
```

Or try it without installing:

```bash
pi -e ./index.ts
```

## License

MIT
