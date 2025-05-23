import { ColumnOrderCache } from "./order-managment";
import { CustomParseSpec, ParseSpec, ResultSpec } from "./types";

class PgParser {
    private idx = 0;
    private value;

    constructor(value: string) {
        this.value = value;
    }

    consume(expect?: string) {
        const char = this.value[this.idx];
        if (expect && char !== expect) {
            throw new Error(`Expected ${expect} but got ${char}`);
        }

        this.idx++;
        return char;
    }

    consumeRawString(context: "array" | "object") {
        const closeEl = context === "array" ? "}" : ")";

        const buffer = [];
        let char: string;
        while (((char = this.consume()), char !== "," && char !== closeEl)) {
            buffer.push(char);
        }

        return buffer.join("");
    }

    consumeString(context: "array" | "object") {
        const closeEl = context === "array" ? "}" : ")";

        this.consume('"');
        const buffer = [];
        let char: string;
        let sawQuote = false;
        let sawEscape = false;

        while ((char = this.consume())) {
            if (char === '"') {
                if (sawQuote || sawEscape) {
                    buffer.push(char);
                    sawQuote = false;
                    sawEscape = false;
                } else {
                    sawQuote = true;
                }

                continue;
            }

            if (char === "\\") {
                if (sawEscape) {
                    buffer.push(char);
                    sawEscape = false;
                } else {
                    sawEscape = true;
                }

                continue;
            }

            if ((char === "," || char === closeEl) && sawQuote) {
                break;
            }

            buffer.push(char);
        }

        return buffer.join("");
    }

    parseObject(spec: CustomParseSpec & { kind: "composite" }, columnOrderCache: ColumnOrderCache) {
        this.consume("(");

        let char: string;
        const results: string[] = [];

        while (((char = this.value[this.idx]), this.idx < this.value.length)) {
            if (char === '"') {
                results.push(this.consumeString("object"));
            } else {
                results.push(this.consumeRawString("object"));
            }
        }

        const fields = spec.fields();
        if (results.length !== fields.length) {
            console.log(results, fields);
            throw new Error("Mismatched fields");
        }

        return results
            .map((value, i) => parse(fields[i][1], value, columnOrderCache))
            .reduce((acc, value, i) => ((acc[fields[i][0]] = value), acc), {});
    }

    parseArray(spec: CustomParseSpec & { kind: "array" }, columnOrderCache: ColumnOrderCache) {
        this.consume("{");

        if (this.value[this.idx] === "}") {
            this.consume("}");
            return [];
        }

        let char: string;
        const results: string[] = [];

        while (((char = this.value[this.idx]), this.idx < this.value.length)) {
            if (char === '"') {
                results.push(this.consumeString("array"));
            } else {
                results.push(this.consumeRawString("array"));
            }
        }

        return results.map((v) => parse(spec.spec, v, columnOrderCache));
    }
}

export const parse = (
    rawParseSpec: ParseSpec,
    value: string | undefined | null,
    columnOrderCache: ColumnOrderCache,
): any => {
    const parseSpec = columnOrderCache.get(rawParseSpec) ?? rawParseSpec;

    if (value === undefined) {
        return undefined;
    }

    if (value === null) {
        return null;
    }

    if (value === "") {
        return null;
    }

    if (parseSpec === Number) {
        return parseFloat(value);
    }

    if (parseSpec === Boolean) {
        return value === "t";
    }

    if (parseSpec === String) {
        return value;
    }

    if (parseSpec === Date) {
        return new Date(value);
    }

    if (parseSpec === Buffer) {
        return parseBuffer(value);
    }

    if (parseSpec === Object) {
        return JSON.parse(value);
    }

    const customSpec = parseSpec as CustomParseSpec;
    if (customSpec.kind === "composite") {
        const parser = new PgParser(value);
        return parser.parseObject(customSpec, columnOrderCache);
    }

    if (customSpec.kind === "array") {
        const parser = new PgParser(value);
        return parser.parseArray(customSpec, columnOrderCache);
    }

    if (customSpec.kind === "enum") {
        return value;
    }
};

export const parseBuffer = (value: string): Buffer => {
    if (value.match(/^\\x/)) {
        // Hex encoded
        return Buffer.from(value.slice(2), "hex");
    } else {
        // Escape encoded
        // TODO(zwade): Make an actual parser here to speed this up
        const asUtf8String = value
            .replace(/\\\\/g, "\\134")
            .replace(/''/g, "\\047")
            .replace(/\\\d{3}/g, (match) => {
                return String.fromCharCode(parseInt(match.slice(1), 8));
            });

        return Buffer.from(asUtf8String, "utf8");
    }
};

export const parseArray = <OO, OA>(spec: ResultSpec<OO>, row: any[], columnOrderCache: ColumnOrderCache): OA => {
    return row.map((value, i) => {
        const [_name, parseSpec] = spec[i];
        if (parseSpec === undefined) {
            return value;
        }

        return parse(parseSpec, value, columnOrderCache);
    }) as OA;
};

export const parseObject = <OO>(spec: ResultSpec<OO>, row: any, columnOrderCache: ColumnOrderCache): OO => {
    return spec.reduce((acc, [name, parseSpec]) => {
        if (parseSpec === undefined) {
            acc[name] = row[name];
        } else {
            acc[name] = parse(parseSpec, row[name], columnOrderCache);
        }

        return acc;
    }, {} as OO);
};
