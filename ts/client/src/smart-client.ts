import { PoolClient, QueryResult, QueryResultRow } from "pg";

(Symbol as any).dispose ??= Symbol("Symbol.dispose");
(Symbol as any).asyncDispose ??= Symbol("Symbol.asyncDispose");

export interface ClientOptions {
    txDepth?: number;
}

export class SmartClient {
    protected client;
    protected txDepth;
    protected active;

    constructor(client: PoolClient, { txDepth = 0 }: ClientOptions = {}) {
        this.client = client;
        this.txDepth = txDepth;
        this.active = true;
    }

    public async query<T extends QueryResultRow>(query: string, values?: any[]): Promise<QueryResult<T>> {
        if (this.active === false) {
            throw new Error("This client is in a transaction. Please do not use it until the transaction completes.");
        }

        try {
            return this.client.query<T>(query, values);
        } catch (e) {
            console.error(`Query failed`);
            console.error(query, values);
            throw e;
        }
    }

    public async q<T extends QueryResultRow>(strings: TemplateStringsArray, ...values: any[]): Promise<QueryResult<T>> {
        const queryString = values.reduce((acc, _, i) => acc + `$${i + 1}` + strings[i + 1], strings[0]);

        return this.query<T>(queryString, values);
    }

    public async q1<T extends QueryResultRow>(strings: TemplateStringsArray, ...values: any[]): Promise<T> {
        const result = await this.q<T>(strings, ...values);
        if (result.rowCount !== 1) {
            throw new Error(`Expected to find only 1 row`);
        }

        return result.rows[0];
    }

    public async q1Opt<T extends QueryResultRow>(
        strings: TemplateStringsArray,
        ...values: any[]
    ): Promise<T | undefined> {
        const result = await this.q<T>(strings, ...values);
        if (result.rowCount === 0) return undefined;
        return result.rows[0];
    }

    public async tx<T>(fn: (client: SmartClient) => T) {
        const newClient = new SmartClient(this.client, { txDepth: this.txDepth + 1 });

        try {
            if (this.txDepth === 0) {
                await this.client.query("BEGIN;");
            } else {
                await this.client.query(`SAVEPOINT S${this.txDepth};`);
            }

            this.active = false;
            const result = await fn(newClient);

            if (this.txDepth === 0) {
                await this.client.query("COMMIT;");
            }

            return result;
        } catch (e) {
            if (this.txDepth === 0) {
                await this.client.query("ROLLBACK;");
            } else {
                await this.client.query(`ROLLBACK TO S${this.txDepth - 1}`);
            }

            throw e;
        } finally {
            // TODO(zwade): Is this assumption true?
            this.active = true;
            newClient.active = false;
        }
    }

    [Symbol.dispose]() {
        this.client.release();
        this.active = false;
    }
}
