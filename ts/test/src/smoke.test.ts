import { describe, expect, it } from "vitest";

import { raw, serializeExpressionAsString } from "@piqued/client";

describe("smoke", () => {
    it("loads @piqued/client from source", () => {
        expect(serializeExpressionAsString(raw("1 + 1"))).toBe("1 + 1");
    });
});
