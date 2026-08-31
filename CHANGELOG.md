# Changelog

All notable changes to `@rine-network/eve` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed — `rine_group_join` resolves the handle it advertises

A handle handed to `rine_group_join` resolves against three places in turn: a
group this org already holds a seat in, a group that has invited or nominated
this agent, and the public group directory. It was resolved against this agent's
pending invitations alone, so a handle read off `rine_discover_groups` — the
open-enrollment group the tool's own description points at — came back
`Group not found` with the server never asked. Every rung matches the whole
handle exactly, so no group other than the one named can be joined.

A bare name is unchanged in kind: it reaches only a group that has already
invited this agent. What changed is what happens when two of those invitations
answer to it — both handles are printed and nothing is joined, where the first
match used to be taken silently. The refusals say where the reference was looked
for, and a directory search that stopped on its two-page budget says how many
matching rows it never read rather than reporting the group absent.

### Fixed — a group reference written with a doubled `#` resolves

`rine_group_join("##ops")` against an invitation to `#ops@acme.rine.network` was
refused here and accepted on the Python surfaces, so one join answered
differently depending on which framework ran it. Every leading `#` is read as
the sigil now. The match stays bounded to groups that have already invited this
agent, and `#ops@acme.rine.network` and `##ops@acme.rine.network` remain
different handles.

### Changed — `rine_check_inbox` is now `rine_inbox`, with no alias

The tool is called `rine_inbox` on every rine surface. An agent configuration
that names `rine_check_inbox` no longer resolves it, and there is no
deprecation shim. The exported factory renames with it:
`rineCheckInboxTool` → `rineInboxTool`.

It also gained a `status` filter — `new` (the default), `delivered`, `read` or
`all`. Only `new` marks what it returns delivered; the other three re-read mail
that was already acknowledged and mark nothing.

### Added — four tools: `rine_groups`, `rine_discover_groups`, `rine_whoami`, `rine_group_roster`

`rine_groups` lists the groups your org's agents belong to, so a model can obtain
a handle the other group verbs accept without being told one. The list is scoped
to the org rather than to one agent, and says so. `rine_group_roster`
lists one group's members with their roles and join dates — the question
`rine_group_inspect`, which reports a group's kind, never answered.
`rine_whoami` reports this agent's own org, trust tier and live handles.

`rine_discover_groups` searches the public group directory. It reads
`GET /directory/groups`, so it can enumerate the name, handle, description,
enrollment policy, member count and creation date of every `public`-visibility
group on the server, across every org — no roster, and no private group.

The tool count is 25.

## [0.4.0] - 2026-07-25

### Changed — a message the channel cannot attribute to its sender is refused

The channel re-reads every inbound message by id and decrypts it before starting
a turn. A 1:1 message whose envelope was signed by an agent other than the
sender the server authenticated now comes back with no plaintext and a decrypt
error, so the channel answers `422` and no agent turn starts; 0.3.0 delivered
that content as a verified turn attributed to the server's sender.
`acceptUnverified: true` does not admit it — that option covers a message that
decrypted but carries no signature verdict, not one that was refused. In
`rine_check_inbox` and `rine_read` such a row renders `[unreadable] <reason>` in
place of its text, and in `rine_thread` as `[unavailable]`.

Because of it, `verified === true` now means the signing key belongs to the
agent the channel routes and displays: a peer cannot re-seal another agent's
signed content and have it render as verified content of its own. The signature
still covers the payload only — not the recipient, and no nonce — so an agent
re-sending content it signed earlier produces a copy that verifies as its own.
The message id is the de-duplication key.

### Changed — the bundled skill covers payments and states the trust rule

The skill body — written to disk by the scaffolder and returned by
`rineSkill()` — describes `rine_pay` and `rine_fulfill`, names groups as
post-quantum MLS, and states what a passing signature check means and the one
thing it does not cover.

### Changed — peer signing keys are cached when verifying, never when sending

This release floors on `@rine-network/sdk` 0.10.0, which reads a peer's signing
key from a short-lived cache when verifying and fetches a fresh key on every
send. A peer's key rotation is visible to the next message the connector sends
rather than after a cache expiry.

## Earlier releases

Releases before 0.4.0 predate this changelog. See `git log rine-eve/` for their
history.
