import { CustomParseSpec, ParseSpec, ResultSpec } from "./types";

const parsePgObject = (spec: CustomParseSpec & { kind: "composite" }, value: string | null) => {
    if (value === null) {
        return null;
    }

    let idx = 0;

    const consume = (expect?: string) => {
        const char = value[idx];
        if (expect && char !== expect) {
            throw new Error(`Expected ${expect} but got ${char}`);
        }

        idx++;
        return char;
    }

    const consumeRawString = () => {
        const buffer = [];
        let char: string;
        while (char = consume(), char !== ',' && char !== ")") {
            buffer.push(char);
        }

        return buffer.join("");
    }

    const consumeString = () => {
        consume('"');
        const buffer = [];
        let char: string;
        let sawQuote = false;

        while (char = consume()) {
            if (char === "\"") {
                if (sawQuote) {
                    buffer.push(char);
                    sawQuote = false;
                } else {
                    sawQuote = true;
                }

                continue;
            }

            if ((char === "," || char === ")") && sawQuote) {
                break;
            }

            buffer.push(char);
        }

        return buffer.join("");
    }

    consume("(");

    let char: string;
    const results: string[] = [];

    while (char = value[idx], idx < value.length) {
        if (char === '"') {
            results.push(consumeString());
        } else {
            results.push(consumeRawString());
        }
    }

    const fields = spec.fields();
    if (results.length !== fields.length) {
        throw new Error("Mismatched fields");
    }

    return results.map((value, i) => parse(fields[i][1], value)).reduce((acc, value, i) => (acc[fields[i][0]] = value, acc), {});
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
        return parsePgObject(customSpec, value);
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