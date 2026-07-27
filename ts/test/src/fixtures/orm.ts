// This file mimics the output that `piqued` emits for its `emit.tableFile`.
// See ./postgres.ts for the accompanying (also hand-written) type definitions.

import { TableBuilder } from "@piqued/client";

import { Organization, Person, PiquedHead, Session } from "./postgres.js";

export const PiquedHeadTable = new TableBuilder<typeof PiquedHead.spec, PiquedHead.t, "_piqued_head">(
    "_piqued_head",
    PiquedHead.spec,
);
export const PersonTable = new TableBuilder<typeof Person.spec, Person.t, "person">("person", Person.spec);
export const SessionTable = new TableBuilder<typeof Session.spec, Session.t, "session">("session", Session.spec);
export const OrganizationTable = new TableBuilder<typeof Organization.spec, Organization.t, "organization">(
    "organization",
    Organization.spec,
);
