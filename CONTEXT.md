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
