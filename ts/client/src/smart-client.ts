import { AsyncLocalStorage } from "node:async_hooks";
import { PoolClient, QueryArrayResult, QueryResult, QueryResultRow } from "pg";
import { default as Cursor } from "pg-cursor";

(Symbol as any).dispose ??= Symbol("Symbol.dispose");
(Symbol as any).asyncDispose ??= Symbol("Symbol.asyncDispose");

const CurrentTransaction = new AsyncLocalStorage<SmartClient>();

export interface ClientOptions {
    txDepth?: number;
    rootClient?: SmartClient;
}

export interface Disposable {
    (): void;
}

export interface StreamOptions {
    batchSize?: number;
}

export type StreamShape<T, O extends StreamOptions> = O extends { batchSize: number }
    ? AsyncIterableIterator<T[]>
    : AsyncIterableIterator<T>;

export type Event = "commit" | "rollback";
export type EventCallback<Args extends unknown[] = []> = (...args: Args) => void | Promise<void>;

export class SmartClient {
    protected client;
    protected txDepth;
    protected active;
    protected rootClient: SmartClient;

    protected events: Map<Event, Set<EventCallback<[SmartClient]>>> = new Map();

    constructor(client: PoolClient, { txDepth = 0, rootClient }: ClientOptions = {}) {
        this.client = client;
        this.txDepth = txDepth;
        this.active = true;
        this.rootClient = rootClient ?? this;
    }

    protected async trigger(event: Event) {
        const callbacks = this.events.get(event);

        const promises: Promise<void>[] = [];
        if (callbacks) {
            for (const callback of [...callbacks]) {
                callbacks.delete(callback);

                if (this.active) {
                    promises.push(Promise.resolve(callback(this)));
                } else {
                    promises.push(Promise.resolve((callback as EventCallback<[]>)()));
                }
            }
        }

        await Promise.allSettled(promises);
    }

    protected addEvent(event: Event, fn: EventCallback<[SmartClient]> | EventCallback<[]>): Disposable {
        const current = this.events.get(event) ?? new Set();
        current.add(fn);
        this.events.set(event, current);

        return () => {
            current.delete(fn);
        };
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

    public async queryArray<T extends any[]>(query: string, values?: any[]): Promise<QueryArrayResult<T>> {
        if (this.active === false) {
            throw new Error("This client is in a transaction. Please do not use it until the transaction completes.");
        }

        try {
            return this.client.query<T>({ text: query, values, rowMode: "array" });
        } catch (e) {
            console.error(`Query failed`);
            console.error(query, values);
            throw e;
        }
    }

    public queryStream<T, O extends StreamOptions>(
        query: string,
        values: any[] = [],
        options: StreamOptions = {},
        mapperFn?: (row: unknown) => T,
    ): AsyncIterableIterator<StreamShape<T, O>> {
        if (this.active === false) {
            throw new Error("This client is in a transaction. Please do not use it until the transaction completes.");
        }

        try {
            const cursor = this.client.query(new Cursor(query, values));
            const batchSize = options.batchSize;
            if (batchSize === undefined) {
                const generator = async function* () {
                    while (true) {
                        const result = await cursor.read(1);
                        if (result.length === 0) {
                            break;
                        }

                        yield mapperFn?.(result[0]) ?? result[0];
                    }
                };

                return generator();
            } else {
                const generator = async function* () {
                    while (true) {
                        const result = await cursor.read(batchSize);
                        if (result.length === 0) {
                            break;
                        }

                        if (mapperFn) {
                            yield result.map((row) => mapperFn(row));
                        } else {
                            yield result;
                        }
                    }
                };

                return generator() as AsyncIterableIterator<StreamShape<T, O>>;
            }
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
        const newClient = new SmartClient(this.client, { txDepth: this.txDepth + 1, rootClient: this.rootClient });

        try {
            if (this.txDepth === 0) {
                await this.client.query("BEGIN;");
            } else {
                await this.client.query(`SAVEPOINT S${this.txDepth};`);
            }

            this.active = false;
            const result = await CurrentTransaction.run(newClient, () => fn(newClient));

            if (this.txDepth === 0) {
                await this.client.query("COMMIT;");
            }

            // This is a bit of a misnomer in the sense that if this `tx` is not at the root
            // we haven't actually committed anything.
            // However, the semantics of it seem correct, in that it will fire as soon as the
            // `tx` callback has resolved, which locally "appears" as a commit.
            this.active = true;
            await newClient.trigger("commit");

            if (this.txDepth === 0) {
                await this.trigger("commit");
            }

            return result;
        } catch (e) {
            console.error("Error in transaction", e);

            if (this.txDepth === 0) {
                await this.client.query("ROLLBACK;");

                this.active = true;
                await newClient.trigger("rollback");
                await this.trigger("rollback");
            } else {
                await this.client.query(`ROLLBACK TO S${this.txDepth - 1}`);

                this.active = true;
                await newClient.trigger("rollback");
            }

            throw e;
        } finally {
            // TODO(zwade): Is this assumption true?
            this.active = true;
            newClient.active = false;
        }
    }

    public on(event: Event, fn: EventCallback<[]>): Disposable {
        return this.addEvent(event, fn);
    }

    public onRoot(event: Event, fn: EventCallback<[client: SmartClient]>): Disposable {
        return this.rootClient.addEvent(event, fn);
    }

    [Symbol.dispose]() {
        this.client.release();
        this.active = false;
    }
}

export const getCurrentClient = () => {
    return CurrentTransaction.getStore();
};
