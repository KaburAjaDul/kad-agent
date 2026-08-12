# KAD Domain Context

This file is the shared vocabulary for KAD event work. It describes the
community concepts and their relationships.

## Core vocabulary

### Program

A durable community offering with a stable purpose, audience, and operating
owner. A Program is the broadest event concept. Examples include Language Club
and Cerita Aja Dulu.

### Series

A planned set of related Sessions under one Program. A Series gives Sessions a
shared identity, cadence, and continuity while allowing each Session to have
its own date, host coverage, and agenda.

### Session

One scheduled occurrence within a Series. A Session has a time, a host or
facilitator, a participant-facing description, and an Agenda. A recurring
Language Club meeting is a Session in the Language Club Series.

### Standalone Gathering

One event that is not part of a Series. It may still use a Program's purpose or
template, but it has no recurring-series identity. A one-off regional meetup is
a Standalone Gathering.

### Agenda Entry

The public schedule listing for one Session or Standalone Gathering. An Agenda
Entry exposes only approved participation information and does not become the
operational record.

### Run-of-Show Item

One ordered topic or activity inside a Session. A Run-of-Show Item is an
internal event-planning concept and is not the website Agenda Entry.

### Discord Event Binding

The relationship between a Session or Standalone Gathering and its associated
Discord event or announcement. It identifies which Discord surface represents
the gathering.

## Runtime vocabulary (implementation-free)

These terms describe facts and responsibilities in the Kaddy operating model;
they do not prescribe tables, APIs, queues, or deployment technology.

### Event Observation

A timestamped observation about an event surface, such as a Discord Scheduled
Event being visible, changed, cancelled, or unavailable. An Event Observation
is evidence received from an external surface, not an instruction to change
Kaddy's private record.

### Effect Intent

A recorded request for Kaddy to cause an external effect, such as creating a
Scheduled Event or sending a reminder. An Effect Intent states what Kaddy
meant to do and can be checked against the resulting external effect.

### Reminder Job

A planned reminder action with a due time, audience purpose, and delivery
outcome. A Reminder Job may be retried or stopped, but it never changes the
meaning of the event itself.

### Reconciliation Record

A record that compares an Effect Intent or Event Observation with the private
event decision and explains whether they agree, differ, or require an
operator. A Reconciliation Record preserves uncertainty rather than guessing.

### Runtime Lease

A time-bounded claim that one runtime instance is currently responsible for a
particular app identity's work. An expired or conflicting Runtime Lease means
the work must pause until ownership is explicit.

### Operational Metric

A minimal aggregate measurement of event work, reminder delivery, runtime
health, or reconciliation progress. Operational Metrics support operations;
they are not member rankings, message-content analysis, or a public score.

### Public Agenda Projection

A reviewed, redacted representation of approved Agenda Entries for public
reading. A Public Agenda Projection is derived from private authority and can
be corrected or withdrawn without rewriting the operational record.

## Relationship summary

`Program` contains one or more `Series` and may relate to `Standalone
Gathering` records. A `Series` contains `Session` records. A `Session` may
contain ordered `Run-of-Show Item` records. A `Session` or `Standalone
Gathering` may have one `Discord Event Binding` and one public `Agenda Entry`.

## Language Club naming rule

“Language Club” is a Program name. “Language Club Series” identifies a recurring
Series. “Language Club Session” identifies one occurrence. “Language Club
Agenda Entry” means the public schedule listing for that Session. It does not
mean its internal run of show.

## Transitional publication authority

Discord Scheduled Events that predate Kaddy-managed operations are imported as
`Imported Schedule Observations`. The Kaddy publication slice validates and
sanitizes those observations, then signs the resulting public Agenda snapshot.
Only the signed snapshot is a website publication authority; Discord payloads,
event IDs, descriptions, hosts, and handles never cross the public boundary.

The sync is pinned to a secret `DISCORD_TARGET_GUILD_ID` and asserts the
configured display name. It never logs unsupported event titles. Active and
default policy reject an unknown scheduled event and leave the last known good
snapshot; observe mode may record only a valid active/scheduled unknown as a
redacted private observation (null normalized title, no agenda/approval/public
write) and reports only the aggregate count.
The signed wire body is recursively key-sorted canonical JSON. The signature
covers `v1`, epoch-millisecond `issuedAt`, epoch-millisecond `expiresAt`
(five minutes later), nonce, base64url SHA-256 body digest, and the exact body.

Future Kaddy-created Sessions remain operationally authoritative in SQLite, with
Discord treated as the delivery surface. A Discord observation may be corrected
or withdrawn by the Staging environment owner; the target is correction within
one scheduled sync (15 minutes) and withdrawal within one sync after a verified
privacy or safety report. Unknown classifications, missing approval, invalid
dates, non-public events, and signature failures fail closed without publishing.
