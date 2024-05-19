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
        while (char = this.consume(), char !== ',' && char !== closeEl) {
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

        while (char = this.consume()) {
            if (char === "\"") {
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

    parseObject(spec: CustomParseSpec & { kind: "composite" }) {
        this.consume("(");

        let char: string;
        const results: string[] = [];

        while (char = this.value[this.idx], this.idx < this.value.length) {
            if (char === ")") {
                this.consume(")");

                if (this.idx !== this.value.length) {
                    console.warn("Unexpected characters after closing parenthesis")
                }

                break;
            }

            if (char === '"') {
                results.push(this.consumeString("object"));
            } else {
                results.push(this.consumeRawString("object"));
            }
        }

        const fields = spec.fields();
        if (results.length !== fields.length) {
            throw new Error("Mismatched fields");
        }

        return results.map((value, i) => parse(fields[i][1], value)).reduce((acc, value, i) => (acc[fields[i][0]] = value, acc), {});
    }

    parseArray(spec: CustomParseSpec & { kind: "array" }) {
        this.consume("{");

        let char: string;
        const results: string[] = [];

        while (char = this.value[this.idx], this.idx < this.value.length) {
            if (char === "}") {
                this.consume("}");

                if (this.idx !== this.value.length) {
                    console.warn("Unexpected characters after closing brace")
                }

                break;
            }

            if (char === '"') {
                results.push(this.consumeString("array"));
            } else {
                results.push(this.consumeRawString("array"));
            }
        }

        return results.map((v) => parse(spec.spec, v));
    }
}

export const parse = (parseSpec: ParseSpec, value: string | undefined): any => {
    if (value === undefined) {
        return undefined;
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

    const customSpec = parseSpec as CustomParseSpec;
    if (customSpec.kind === "composite") {
        const parser = new PgParser(value);
        return parser.parseObject(customSpec);
    }

    if (customSpec.kind === "array") {
        const parser = new PgParser(value);
        return parser.parseArray(customSpec);
    }

    if (customSpec.kind === "enum") {
        return value;
    }
}

export const parseArray = <OO, OA>(spec: ResultSpec<OO>, row: any[]): OA => {
    return row.map((value, i) => {
        const [name, parseSpec] = spec[i];
        if (parseSpec === undefined) {
            return value;
        }

        return parse(parseSpec, value);
    }) as OA
}

export const parseObject = <OO>(spec: ResultSpec<OO>, row: any): OO => {
    return spec.reduce((acc, [name, parseSpec]) => {
        if (parseSpec === undefined) {
            acc[name] = row[name];
        } else {
            acc[name] = parse(parseSpec, row[name]);
        }

        return acc;
    }, {} as OO);
}