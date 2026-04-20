import { AsyncLocalStorage } from "node:async_hooks";
import { PoolClient, QueryArrayResult, QueryResult, QueryResultRow } from "pg";
import { default as Cursor } from "pg-cursor";

import { ColumnOrderCache } from "./order-managment.js";

(Symbol as any).dispose ??= Symbol("Symbol.dispose");
(Symbol as any).asyncDispose ??= Symbol("Symbol.asyncDispose");

const CurrentTransaction = new AsyncLocalStorage<SmartClient>();

export interface ClientOptions {
    txDepth?: number;
    rootClient?: SmartClient;
    columnOrderCache?: ColumnOrderCache;
    queryLogger?: (query: string, values?: any[]) => void;
    timeoutMs?: number;
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

const transactionEvents = new Set<Event>(["commit", "rollback"]);

export class SmartClient {
    protected client;
    protected txDepth;
    protected active;
    protected inTx;
    protected rootClient: SmartClient;
    protected queryLogger?: (query: string, values?: any[]) => void;
    protected timeoutMs?: number;

    protected events: Map<Event, Set<EventCallback<[SmartClient]>>> = new Map();

    public columnOrderCache: ColumnOrderCache;

    #isLiving;

    constructor(
        client: PoolClient,
        { txDepth = 0, rootClient, columnOrderCache, queryLogger, timeoutMs }: ClientOptions = {},
    ) {
        this.client = client;
        this.txDepth = txDepth;
        this.active = true;
        this.inTx = false;
        this.rootClient = rootClient ?? this;
        this.queryLogger = queryLogger;
        this.timeoutMs = timeoutMs;
        this.columnOrderCache = columnOrderCache ?? new WeakMap();
        this.#isLiving = true;

        if ((this.txDepth === 0) !== (this.rootClient === this)) {
            console.warn(
                "When constructing a `SmartClient`, please ensure that only the root client has a txDepth of 0",
            );
        }

        const errorStack = new Error().stack;
        if (this.rootClient === this && !!timeoutMs) {
            setTimeout(() => {
                if (this.#isLiving) {
                    console.log(`SmartClient has been alive for more than ${timeoutMs}ms. Releasing it automatically.`);
                    console.log(`Client was created at:`);
                    console.log(errorStack);

                    this.dispose();
                }
            }, timeoutMs);
        }
    }

    public get isLiving() {
        return this.rootClient.#isLiving;
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

    protected ensureLiving() {
        if (!this.isLiving) {
            throw new Error("This client has been released and can no longer be used.");
        }

        if (this.active === false) {
            throw new Error("This client is in a transaction. Please do not use it until the transaction completes.");
        }
    }

    protected async _queryWithLog(query: string, values?: any[]) {
        this.queryLogger?.(query, values);
        return this.client.query(query, values);
    }

    public async query<T extends QueryResultRow>(query: string, values?: any[]): Promise<QueryResult<T>> {
        this.ensureLiving();
        return await this._queryWithLog(query, values);
    }

    public async queryArray<T extends any[]>(query: string, values?: any[]): Promise<QueryArrayResult<T>> {
        this.ensureLiving();

        try {
            this.queryLogger?.(query, values);
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
    ): StreamShape<T, O> {
        this.ensureLiving();

        try {
            this.queryLogger?.(query, values);
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

                return generator() as StreamShape<T, O>;
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
        this.ensureLiving();

        const newClient = new SmartClient(this.client, {
            txDepth: this.txDepth + 1,
            rootClient: this.rootClient,
            columnOrderCache: this.columnOrderCache,
            queryLogger: this.queryLogger,
            timeoutMs: this.timeoutMs,
        });

        try {
            this.inTx = true;

            if (this.txDepth === 0) {
                await this._queryWithLog("BEGIN;");
            } else {
                await this._queryWithLog(`SAVEPOINT S${this.txDepth};`);
            }

            this.active = false;
            const result = await CurrentTransaction.run(newClient, () => fn(newClient));

            if (this.txDepth === 0) {
                await this._queryWithLog("COMMIT;");
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
                await this._queryWithLog("ROLLBACK;");

                this.active = true;
                await newClient.trigger("rollback");
                await this.trigger("rollback");
            } else {
                await this._queryWithLog(`ROLLBACK TO S${this.txDepth};`);

                this.active = true;
                await newClient.trigger("rollback");
            }

            throw e;
        } finally {
            // TODO(zwade): Is this assumption true?
            this.active = true;
            newClient.active = false;
            this.inTx = false;
        }
    }

    private checkTxEvents(event: Event) {
        if (transactionEvents.has(event) && !(this.inTx || this.txDepth > 0)) {
            console.trace(`Cannot listen for ${event} on a non-transactional client. This event will never fire`);
        }
    }

    public on(event: Event, fn: EventCallback<[]>): Disposable {
        this.checkTxEvents(event);

        return this.addEvent(event, fn);
    }

    public onRoot(event: Event, fn: EventCallback<[client: SmartClient]>): Disposable {
        this.checkTxEvents(event);

        return this.rootClient.addEvent(event, fn);
    }

    public once(event: Event, fn: EventCallback<[]>): Disposable {
        this.checkTxEvents(event);

        const disposable = this.addEvent(event, () => {
            disposable();
            return fn();
        });

        return disposable;
    }

    public onceRoot(event: Event, fn: EventCallback<[client: SmartClient]>): Disposable {
        this.checkTxEvents(event);

        const disposable = this.rootClient.addEvent(event, (client) => {
            disposable();
            return fn(client);
        });

        return disposable;
    }

    public dispose() {
        if (this.rootClient === this && this.#isLiving) {
            this.client.release();
            this.active = false;
            this.#isLiving = false;
        }
    }

    [Symbol.dispose]() {
        this.dispose();
    }
}

export const getCurrentClient = () => {
    return CurrentTransaction.getStore();
};
