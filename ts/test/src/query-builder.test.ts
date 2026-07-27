import { alias, Delete, Insert, label, Op, Select, Update } from "@piqued/client";
import { describe, expect, it } from "vitest";

import { OrganizationTable, PersonTable, SessionTable } from "./fixtures/orm.js";

/** Queries are serialized with newlines between clauses; tests compare on a single line. */
const sql = (query: { serialize(): { data: string; values: any[] } }) => {
    const { data, values } = query.serialize();
    return { sql: data.replace(/\s+/g, " ").trim(), values };
};

describe("Select", () => {
    it("serializes columns, from, and a parameterized where", () => {
        const query = Select(PersonTable.c.id, PersonTable.c.email)
            .from(PersonTable)
            .where(Op.eq(PersonTable.c.email, "ada@example.com"));

        expect(sql(query)).toEqual({
            sql: 'select "person"."id", "person"."email" from "person" where ("person"."email" = $1) ;',
            values: ["ada@example.com"],
        });
    });

    it("serializes joins, ordering, limit and offset", () => {
        const query = Select(PersonTable.c.id, SessionTable.c.session_token)
            .from(PersonTable)
            .innerJoin(SessionTable, Op.eq(SessionTable.c.user_id, PersonTable.c.id))
            .leftJoin(OrganizationTable, Op.eq(OrganizationTable.c.owner_id, PersonTable.c.id))
            .orderBy(SessionTable.c.created_at, "desc")
            .setLimit(10)
            .setOffset(20);

        expect(sql(query).sql).toBe(
            'select "person"."id", "session"."session_token" ' +
                'from "person" ' +
                'inner join "session" on ("session"."user_id" = "person"."id") ' +
                'left join "organization" on ("organization"."owner_id" = "person"."id") ' +
                'order by "session"."created_at" desc ' +
                "limit $1 offset $2 ;",
        );
        expect(sql(query).values).toEqual([10, 20]);
    });

    it("expands `star` and respects table aliases", () => {
        const owner = alias(PersonTable, "owner");
        const query = Select(...owner.star)
            .from(owner)
            .where(Op.eq(owner.c.id, 1));

        const { sql: text } = sql(query);
        expect(text).toContain('select "owner"."id", "owner"."created_at"');
        expect(text).toContain('from "person" as "owner"');
    });

    it("supports labels and aggregates", () => {
        const query = Select(label(Op.max(PersonTable.c.id), "newest"), Op.count())
            .from(PersonTable)
            .groupBy(PersonTable.c.email);

        expect(sql(query).sql).toBe(
            'select max("person"."id") as newest, count(*)::integer as count ' +
                'from "person" group by "person"."email" ;',
        );
    });

    it("refuses to serialize without a from-table", () => {
        expect(() => Select(PersonTable.c.id).serialize()).toThrow(/without a from-table/);
    });
});

describe("Insert", () => {
    it("serializes columns, values and a returning clause", () => {
        const query = Insert(PersonTable)
            .values({ email: "ada@example.com", first_name: "Ada" })
            .returning(PersonTable.c.id);

        expect(sql(query)).toEqual({
            sql: 'insert into "person" (email, first_name) values ($1, $2) returning "person"."id" ;',
            values: ["ada@example.com", "Ada"],
        });
    });

    it("serializes `on conflict do nothing` with conflict keys", () => {
        const query = Insert(SessionTable)
            .values({ session_token: "tok", user_id: 1 })
            .onConflictDoNothing([SessionTable.c.session_token]);

        expect(sql(query).sql).toBe(
            'insert into "session" (session_token, user_id) values ($1, $2) ' +
                'on conflict ("session_token") do nothing ;',
        );
    });

    it("serializes `on conflict do update`", () => {
        const query = Insert(SessionTable)
            .values({ session_token: "tok", user_id: 1 })
            .onConflictDoUpdate([SessionTable.c.session_token], { user_id: 2 });

        expect(sql(query)).toEqual({
            sql:
                'insert into "session" (session_token, user_id) values ($1, $2) ' +
                'on conflict ("session_token") do update set "user_id" = $3 ;',
            values: ["tok", 1, 2],
        });
    });
});

describe("Update", () => {
    it("serializes a set clause with an expression value", () => {
        const query = Update(PersonTable)
            .set({ name: Op.concat(PersonTable.c.first_name, " ", PersonTable.c.last_name) })
            .whereEq({ id: 7 });

        expect(sql(query)).toEqual({
            sql:
                'update "person" set "name" = concat("person"."first_name", $1, "person"."last_name") ' +
                'where ("person"."id" = $2) ;',
            values: [" ", 7],
        });
    });

    it("ands together multiple where clauses and supports returning", () => {
        const query = Update(SessionTable)
            .set({ last_active_at: new Date(0) })
            .where(Op.eq(SessionTable.c.user_id, 1))
            .where(Op.isNotNull(SessionTable.c.session_token))
            .returning(SessionTable.c.id);

        expect(sql(query).sql).toBe(
            'update "session" set "last_active_at" = $1 ' +
                'where ("session"."user_id" = $2) and "session"."session_token" IS NOT NULL ' +
                'returning "session"."id" ;',
        );
    });
});

describe("Delete", () => {
    it("serializes a where clause and returning", () => {
        const query = Delete(SessionTable)
            .where(Op.lt(SessionTable.c.created_at, new Date(0)))
            .returning(SessionTable.c.id);

        expect(sql(query)).toEqual({
            sql: 'delete from "session" where ("session"."created_at" < $1) returning "session"."id" ;',
            values: [new Date(0)],
        });
    });

    it("serializes an unfiltered delete", () => {
        expect(sql(Delete(OrganizationTable)).sql).toBe('delete from "organization" ;');
    });
});

describe("sub-queries", () => {
    /** Sessions that have been active since the epoch — one parameter, so it is easy to count. */
    const activeSessions = () =>
        Select(SessionTable.c.user_id)
            .from(SessionTable)
            .where(Op.gt(SessionTable.c.last_active_at, new Date(0)));

    it("embeds a sub-query in a where clause, parenthesized and without a semicolon", () => {
        const query = Select(PersonTable.c.id).from(PersonTable).where(Op.in_(PersonTable.c.id, activeSessions()));

        expect(sql(query).sql).toBe(
            'select "person"."id" from "person" where ("person"."id" IN ' +
                '(select "session"."user_id" from "session" where ("session"."last_active_at" > $1))) ;',
        );
    });

    it("shares parameter numbering with the enclosing statement", () => {
        const query = Select(PersonTable.c.id)
            .from(PersonTable)
            .where(Op.in_(PersonTable.c.id, activeSessions()))
            .where(Op.eq(PersonTable.c.email, "ada@example.com"));

        const { sql: text, values } = sql(query);

        // The sub-query is serialized first, so it claims $1 and the outer clause gets $2.
        expect(text).toContain('("session"."last_active_at" > $1)');
        expect(text).toContain('("person"."email" = $2)');
        expect(values).toEqual([new Date(0), "ada@example.com"]);
    });

    it("supports exists and not exists against a correlated sub-query", () => {
        const correlated = Select(1).from(SessionTable).where(Op.eq(SessionTable.c.user_id, PersonTable.c.id));

        expect(sql(Select(PersonTable.c.id).from(PersonTable).where(Op.exists(correlated))).sql).toBe(
            'select "person"."id" from "person" where exists ' +
                '(select $1 from "session" where ("session"."user_id" = "person"."id")) ;',
        );

        expect(sql(Select(PersonTable.c.id).from(PersonTable).where(Op.notExists(correlated))).sql).toContain(
            "where not exists (select",
        );
    });

    it("embeds a scalar sub-query in a selection list", () => {
        const sessionCount = Select(Op.count())
            .from(SessionTable)
            .where(Op.eq(SessionTable.c.user_id, PersonTable.c.id));

        const query = Select(PersonTable.c.id, label(sessionCount, "session_count")).from(PersonTable);

        expect(sql(query).sql).toBe(
            'select "person"."id", (select count(*)::integer as count from "session" ' +
                'where ("session"."user_id" = "person"."id")) as session_count from "person" ;',
        );
    });

    it("embeds a sub-query as an update value", () => {
        const latestName = Select(OrganizationTable.c.name)
            .from(OrganizationTable)
            .where(Op.eq(OrganizationTable.c.owner_id, PersonTable.c.id))
            .setLimit(1);

        const query = Update(PersonTable).set({ name: latestName }).whereEq({ id: 7 });

        expect(sql(query)).toEqual({
            sql:
                'update "person" set "name" = (select "organization"."name" from "organization" ' +
                'where ("organization"."owner_id" = "person"."id") limit $1) where ("person"."id" = $2) ;',
            values: [1, 7],
        });
    });

    it("embeds a sub-query as an insert value", () => {
        const ownerId = Select(OrganizationTable.c.owner_id)
            .from(OrganizationTable)
            .where(Op.eq(OrganizationTable.c.id, 3));

        const query = Insert(SessionTable).values({ session_token: "tok", user_id: ownerId });

        expect(sql(query)).toEqual({
            sql:
                'insert into "session" (session_token, user_id) values ($1, ' +
                '(select "organization"."owner_id" from "organization" where ("organization"."id" = $2))) ;',
            values: ["tok", 3],
        });
    });

    it("nests sub-queries arbitrarily deep", () => {
        const owners = Select(OrganizationTable.c.owner_id)
            .from(OrganizationTable)
            .where(Op.eq(OrganizationTable.c.name, "acme"));

        const ownerSessions = Select(SessionTable.c.user_id)
            .from(SessionTable)
            .where(Op.in_(SessionTable.c.user_id, owners));

        const query = Select(PersonTable.c.email).from(PersonTable).where(Op.in_(PersonTable.c.id, ownerSessions));

        const { sql: text, values } = sql(query);

        expect(text).toBe(
            'select "person"."email" from "person" where ("person"."id" IN ' +
                '(select "session"."user_id" from "session" where ("session"."user_id" IN ' +
                '(select "organization"."owner_id" from "organization" where ("organization"."name" = $1))))) ;',
        );
        expect(values).toEqual(["acme"]);
    });

    it("distinguishes a sub-query from a literal array in `in`", () => {
        // Arrays become an inlined tuple; sub-queries stay parenthesized SQL.
        expect(
            sql(
                Select(PersonTable.c.id)
                    .from(PersonTable)
                    .where(Op.in_(PersonTable.c.id, [1, 2, 3])),
            ).sql,
        ).toBe('select "person"."id" from "person" where ("person"."id" IN (1,2,3)) ;');
    });
});
