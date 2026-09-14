# Changelog

All notable changes to `@rine-network/eve` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-09-14

### Fixed — a sender whose signing key could not be looked up is no longer discarded

The channel refuses an inbound message whose signature does not check out, and it
consumed the message when it did so. That is right for a signature that is wrong:
a forged signature and a signature attributed to the wrong agent are properties
of the bytes, and no later attempt can reach a different verdict.

It was also being applied to a third case that is not a refusal at all. When the
sender's signing key cannot be *fetched* at that moment, there is no verdict —
only the absence of one — and it resolves itself as soon as the key is reachable.
A genuine message was being thrown away for a passing lookup failure, and nothing
said so.

That case now leaves the message alone: the row stays `new`, so a later attempt
re-reads a real message instead of an already-consumed one. A signature that is
actually wrong is still consumed, for the reason above.

**What you will see differently:** an inbound message can now be attempted more
than once when the sender's key is briefly unreachable, where before it was
dropped silently on the first try. The response is still `422` in both cases;
what changed is whether the message survives it.

This release is a minor rather than a patch because that is a behaviour change,
and a patch would reach every `^0.5.x` install with no action taken.

### Fixed — an inbound message the channel cannot decrypt is no longer lost

The channel re-reads every inbound message by id before it starts a turn. That
read used to mark the message delivered as a side effect, and it did so *before*
the channel had decided anything — so the two refusals that follow it threw away
the message they refused. An undecryptable envelope (usually a group sender key
that simply has not arrived yet) was gone after exactly one look, and the `503`
that promised the caller a retry was retrying against a message already
consumed.

The read now peeks: it suppresses the delivery mark and changes nothing else. A
message this channel could not open stays in `status=new`, so the rine webhook
worker's own bounded, backing-off retry gets further attempts at it, and a
message that becomes readable in that window is delivered. The undecryptable
refusal is still `422` — the documented status contract is unchanged, `4xx`
terminal and `5xx` transient — and a refused message is still visible to
`rine_inbox` and readable by `rine_read` the whole time.

What is different for an operator: a message that used to disappear after the
first delivery attempt can now be delivered on a later one, and an unreadable
one may be attempted more than once before the webhook job gives up. Nothing
that was delivered before stops being delivered. Every other refusal — a
signature that does not verify, an ignored reply type, a message with no reply
target — consumes the message exactly as it did before.

Marking a message delivered is now the channel's own explicit step rather than a
side effect of reading it. It stays best-effort, so a failed mark never costs a
delivery, but it is no longer silent: the failure is warned, because the message
will otherwise be delivered and answered a second time.

Requires a server that honours the peek request (`X-Rine-Peek`). An older
deployment ignores it and behaves exactly as before this release.

## [0.5.0] - 2026-08-31

### Changed — `rine_check_inbox` is now `rine_inbox`, with no alias

**Breaking change**, shipped in this release. The tool is called `rine_inbox` on
every rine surface. An agent configuration that names `rine_check_inbox` no
longer resolves it, and there is no deprecation shim. The exported factory
renames with it: `rineCheckInboxTool` → `rineInboxTool`.

The release before this one was 0.3.0, so a configuration carrying the old name
kept working until this upgrade, and nothing here announced the rename at the
time. Rename the tool where your agent lists it, and the factory import if you
construct tools yourself.

It also gained a `status` filter — `new` (the default), `delivered`, `read` or
`all`. Only `new` marks what it returns delivered; the other three re-read mail
that was already acknowledged and mark nothing.

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
