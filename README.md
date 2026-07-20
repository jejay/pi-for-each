# pi-for-each

A [pi](https://github.com/earendil-works/pi) extension that adds a `/for`
prompt-loop command with $each variable insertion over directory children or file
lines.

## Why

Like subagents but much simpler, sequential and with more control for the user. Instead of describing the loop to the agent, just make a loop. No need to tell the agent about your control structure if you already know the control structure.

## Demo

![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-1.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-2.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-3.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-4.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-5.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-6.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-7.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-8.png)
![](https://raw.githubusercontent.com/jejay/pi-for-each/main/demo-imgs/pi-for-demo-9.png)

## What it does

Compose a message that contains a `$each@<path>` token (dollar + `each` + at-sign
+ a file or directory path), then invoke it as the **`/for` command**:

```
/for Please reword the skill in $each@./skills/ and make it more polite
```

While composing the message, typing `$each@` opens pi's fuzzy file/directory
search (the same one `@` after a space opens) so you can pick a path. The token
becomes `$each@<file-or-dir>`.

When the `/for` command runs, it executes a **prompt loop**:

- **Directory** — if the path points to a directory, the loop iterates over all
  of its child elements (files and subdirectories, excluding dotfiles). Each
  iteration replaces the full `$each@<dir>` token with `<dir>/<child>` (directories
  keep a trailing slash), e.g. `$each@./skills/` → `./skills/karate/`.
- **File (lines)** — if the path points to a file, the loop iterates over every
  line of the file. Each iteration replaces the full `$each@<file>` token with the
  corresponding line.

Iterations run strictly sequentially (no parallelism). The first iteration is
sent as a normal message into the *current* (origin) session. Every following
iteration **forks** the session into a *new session file* so the previous
iteration's message is replaced while the earlier conversation context is
preserved, then sends the next replacement.

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
User:  /for Please reword the skill in $each@./skills/ and make it more polite
```

This expands to:

```
User:  Please reword the skill in ./skills/karate/ and make it more polite
       ... (wait for answer) ...
       fork → replace last message (new session file)
User:  Please reword the skill in ./skills/baking/ and make it more polite
```

The origin session keeps the first iteration; each subsequent iteration lives in
its own forked session file, so the session list shows one session per
iteration.

## Design notes

- This is driven by a real registered command, **`/for`**. The fork semantic
  requires `ctx.fork()`, which is only available on `ExtensionCommandContext`
  (the context passed to command handlers) — `ExtensionContext` (used by the
  `input`/`session_start` handlers) does not expose it. So the loop runs inside
  the `/for` command handler, where `cmdCtx.fork()` is available.
- The submitted message must start with `/for` so that pi's command pipeline
  routes it to the handler. A bare `$each@<path>` message submitted as a normal
  message is not a command and is intercepted with a hint to use `/for`.
- **Why the old approach failed:** `ExtensionAPI.sendUserMessage()` internally
  calls `prompt(text, { expandPromptTemplates: false, … })`, and pi only runs
  slash/extension commands when `expandPromptTemplates` is true. So sending
  `"/clone"` via `sendUserMessage` never executed the command — it was just
  appended as a literal user message into the *same* session, which is why every
  iteration chained linearly into one session. The fix uses the real
  `ctx.fork()` instead.
- The `$each@` fuzzy search reuses pi's built-in fuzzy file/directory provider
  (`CombinedAutocompleteProvider.getFuzzyFileSuggestions`) via a wrapping
  `AutocompleteProvider`, with a `readdir` fallback. The editor is extended so
  that typing `$each@` opens that search exactly as `@` after a space does.
- The full token — starting at the dollar sign and including `for`, `@` and the
  path, up to (but not including) the first following whitespace — is replaced by
  the iteration value. Not just the path.

## Install

```bash
pi install npm:pi-for-each
```

To try it without installing (from a clone):

```bash
pi -e ./index.ts
```

## License

MIT
