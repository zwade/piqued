import { Person, PiquedHead, Session } from "./types.js";

import { TableBuilder } from "@piqued/client";
export const PiquedHeadTable = new TableBuilder<typeof PiquedHead.spec, PiquedHead.t, "_piqued_head">("_piqued_head", PiquedHead.spec);
export const PersonTable = new TableBuilder<typeof Person.spec, Person.t, "person">("person", Person.spec);
export const SessionTable = new TableBuilder<typeof Session.spec, Session.t, "session">("session", Session.spec);
