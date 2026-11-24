const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_\u0080-￿]/.test(c);
const isIdentChar = (c: string | undefined) => !!c && /[A-Za-z0-9_$\u0080-￿]/.test(c);

/**
 * Splits a SQL script into top-level statements on `;`, honouring strings,
 * quoted identifiers, dollar quotes and (nested) comments.
 */
export const splitStatements = (sql: string): string[] => {
    const statements: string[] = [];
    let start = 0;
    let hasCode = false;
    let i = 0;

    const push = (end: number) => {
        if (hasCode) {
            statements.push(sql.slice(start, end).trim());
        }
        start = end + 1;
        hasCode = false;
    };

    while (i < sql.length) {
        const c = sql[i];
        const next = sql[i + 1];

        if (c === "-" && next === "-") {
            const eol = sql.indexOf("\n", i);
            i = eol === -1 ? sql.length : eol + 1;
            continue;
        }

        if (c === "/" && next === "*") {
            let depth = 1;
            i += 2;
            while (i < sql.length && depth > 0) {
                if (sql[i] === "/" && sql[i + 1] === "*") {
                    depth++;
                    i += 2;
                } else if (sql[i] === "*" && sql[i + 1] === "/") {
                    depth--;
                    i += 2;
                } else {
                    i++;
                }
            }
            continue;
        }

        if (c === ";") {
            push(i);
            i++;
            continue;
        }

        hasCode ||= !/\s/.test(c);

        // E'...' allows backslash escapes; must not be the tail of an identifier.
        if ((c === "E" || c === "e") && next === "'" && !isIdentChar(sql[i - 1])) {
            i += 2;
            while (i < sql.length) {
                if (sql[i] === "\\") {
                    i += 2;
                } else if (sql[i] === "'" && sql[i + 1] === "'") {
                    i += 2;
                } else if (sql[i] === "'") {
                    i++;
                    break;
                } else {
                    i++;
                }
            }
            continue;
        }

        if (c === "'" || c === '"') {
            i++;
            while (i < sql.length) {
                if (sql[i] === c && sql[i + 1] === c) {
                    i += 2;
                } else if (sql[i] === c) {
                    i++;
                    break;
                } else {
                    i++;
                }
            }
            continue;
        }

        // $tag$...$tag$, but not $1 params or `$` inside identifiers.
        if (c === "$" && !isIdentChar(sql[i - 1])) {
            let j = i + 1;
            if (isIdentStart(sql[j])) {
                while (isIdentChar(sql[j]) && sql[j] !== "$") j++;
            }
            if (sql[j] === "$") {
                const tag = sql.slice(i, j + 1);
                const close = sql.indexOf(tag, j + 1);
                i = close === -1 ? sql.length : close + tag.length;
                continue;
            }
        }

        i++;
    }

    push(sql.length);
    return statements;
};
