import { Tidkind, Salesreplinksettingincludeselfstatus, Dashboardtier } from "../types";

import { Query, EntityQueries } from "@piqued/client";


export const Reflect: Query<Reflect.InputArray, Reflect.InputObject, Reflect.OutputArray, Reflect.OutputObject> = {
    name: "reflect",
    query: `SELECT $1::text || ' from postgres!' AS input`,
    params: [
        "$0",
    ],
    spec: [
        ["input", undefined],
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
    spec: [
        ["?column?", undefined],
        ["input", undefined],
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
    spec: [
        ["?column?", undefined],
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
    query: `SELECT * FROM company`,
    params: [
    ],
    spec: [
        ["id", undefined],
        ["created_at", undefined],
        ["email", undefined],
        ["password_hash", undefined],
        ["tid", undefined],
        ["legal_name", undefined],
        ["dba", undefined],
        ["attempted_duns_fetch", undefined],
        ["biz_tag", undefined],
        ["address_id", undefined],
        ["shipping_address_id", undefined],
        ["state_of_incorporation", undefined],
        ["business_type", undefined],
        ["is_tax_exempt", undefined],
        ["exemption_documents", undefined],
        ["po_required", undefined],
        ["duns", undefined],
        ["creditsafe_id", undefined],
        ["efx_id", undefined],
        ["default_from_linked_credentials_association_id", undefined],
        ["hide_credit_limit_from_customers", undefined],
        ["sales_rep_link_setting_include_self_status", Salesreplinksettingincludeselfstatus.spec],
        ["sales_rep_email_setting_skip_credit_app_submit", undefined],
        ["trade_reference_configuration_id", undefined],
        ["tid_kind", Tidkind.spec],
        ["claimed", undefined],
        ["verified", undefined],
        ["submitted_ar_lead_contact_form", undefined],
        ["is_fraudulent", undefined],
        ["invoice_email", undefined],
        ["default_credit_terms", undefined],
        ["sales_rep_dashboard_enabled", undefined],
        ["is_demo", undefined],
        ["provisional", undefined],
        ["biz_tag_created_at", undefined],
        ["dashboard_tier", Dashboardtier.spec],
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
        tid: string,
        legal_name: string,
        dba: string,
        attempted_duns_fetch: boolean,
        biz_tag: string,
        address_id: number,
        shipping_address_id: number,
        state_of_incorporation: string,
        business_type: string,
        is_tax_exempt: boolean,
        exemption_documents: string[],
        po_required: boolean,
        duns: string,
        creditsafe_id: string,
        efx_id: string,
        default_from_linked_credentials_association_id: number,
        hide_credit_limit_from_customers: boolean,
        sales_rep_link_setting_include_self_status: Salesreplinksettingincludeselfstatus.t,
        sales_rep_email_setting_skip_credit_app_submit: boolean,
        trade_reference_configuration_id: number,
        tid_kind: Tidkind.t,
        claimed: boolean,
        verified: boolean,
        submitted_ar_lead_contact_form: boolean,
        is_fraudulent: boolean,
        invoice_email: string,
        default_credit_terms: string,
        sales_rep_dashboard_enabled: boolean,
        is_demo: boolean,
        provisional: boolean,
        biz_tag_created_at: Date,
        dashboard_tier: Dashboardtier.t,
    ];
    export type OutputObject = {
        "id": number,
        "created_at": Date,
        "email": string,
        "password_hash": string,
        "tid": string,
        "legal_name": string,
        "dba": string,
        "attempted_duns_fetch": boolean,
        "biz_tag": string,
        "address_id": number,
        "shipping_address_id": number,
        "state_of_incorporation": string,
        "business_type": string,
        "is_tax_exempt": boolean,
        "exemption_documents": string[],
        "po_required": boolean,
        "duns": string,
        "creditsafe_id": string,
        "efx_id": string,
        "default_from_linked_credentials_association_id": number,
        "hide_credit_limit_from_customers": boolean,
        "sales_rep_link_setting_include_self_status": Salesreplinksettingincludeselfstatus.t,
        "sales_rep_email_setting_skip_credit_app_submit": boolean,
        "trade_reference_configuration_id": number,
        "tid_kind": Tidkind.t,
        "claimed": boolean,
        "verified": boolean,
        "submitted_ar_lead_contact_form": boolean,
        "is_fraudulent": boolean,
        "invoice_email": string,
        "default_credit_terms": string,
        "sales_rep_dashboard_enabled": boolean,
        "is_demo": boolean,
        "provisional": boolean,
        "biz_tag_created_at": Date,
        "dashboard_tier": Dashboardtier.t,
    };
}

export default EntityQueries({
    "reflect": Reflect,
    "reflect2": Reflect2,
    "query2": Query2,
    "query3": Query3,
})

