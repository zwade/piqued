import { Usernotificationsetting } from "../types";

import { Query, EntityQueries } from "@piqued/client";


export const Reflect: Query<Reflect.InputArray, Reflect.InputObject, Reflect.OutputArray, Reflect.OutputObject> = {
    name: "reflect",
    query: `SELECT $1::text || ' from postgres!' AS input`,
    params: [
        "$0",
    ],
    _brand: undefined as any,
};

export namespace Reflect {
    export type InputArray = [
        $0: string,
    ];
    export type InputObject = {
        "$0": string,
    };
    export type OutputArray = [
        input: string,
    ];
    export type OutputObject = {
         "input": string,
    };
}

export const Reflect2: Query<Reflect2.InputArray, Reflect2.InputObject, Reflect2.OutputArray, Reflect2.OutputObject> = {
    name: "reflect_2",
    query: `SELECT $1::text || ' from another postgres!', $2 AS input`,
    params: [
        "first",
        "second",
    ],
    _brand: undefined as any,
};

export namespace Reflect2 {
    export type InputArray = [
        first: string,
        second: string,
    ];
    export type InputObject = {
        "first": string,
        "second": string,
    };
    export type OutputArray = [
        column: string,
        input: string,
    ];
    export type OutputObject = {
         "?column?": string,
         "input": string,
    };
}

export const Query2: Query<Query2.InputArray, Query2.InputObject, Query2.OutputArray, Query2.OutputObject> = {
    name: "query_2",
    query: `SELECT E'This query has messy characters: \\ \` '''`,
    params: [
    ],
    _brand: undefined as any,
};

export namespace Query2 {
    export type InputArray = [
    ];
    export type InputObject = {
    };
    export type OutputArray = [
        column: string,
    ];
    export type OutputObject = {
         "?column?": string,
    };
}

export const Query3: Query<Query3.InputArray, Query3.InputObject, Query3.OutputArray, Query3.OutputObject> = {
    name: "query_3",
    query: `SELECT * FROM "user"`,
    params: [
    ],
    _brand: undefined as any,
};

export namespace Query3 {
    export type InputArray = [
    ];
    export type InputObject = {
    };
    export type OutputArray = [
        id: number,
        created_at: Date,
        email: string,
        password_hash: string,
        name: string,
        title: string,
        should_reset_password: boolean,
        notification_setting: Usernotificationsetting,
    ];
    export type OutputObject = {
         "id": number,
         "created_at": Date,
         "email": string,
         "password_hash": string,
         "name": string,
         "title": string,
         "should_reset_password": boolean,
         "notification_setting": Usernotificationsetting,
    };
}

export default EntityQueries({
    "reflect": Reflect,
    "reflect2": Reflect2,
    "query2": Query2,
    "query3": Query3,
})

