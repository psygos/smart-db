import { describe, expect, it } from "vitest";
import { describePartDbError, isRetryable, type PartDbError } from "./partdb-errors";

describe("PartDbError helpers", () => {
  it("reports retryability directly from the error value", () => {
    const networkError: PartDbError = {
      kind: "network",
      message: "reset by peer",
      cause: new Error("reset by peer"),
      retryable: true,
    };
    const validationError: PartDbError = {
      kind: "validation",
      httpStatus: 422,
      violations: [{ propertyPath: "name", message: "This value should not be blank." }],
      retryable: false,
    };

    expect(isRetryable(networkError)).toBe(true);
    expect(isRetryable(validationError)).toBe(false);
  });

  it("formats stable operator-facing descriptions", () => {
    expect(
      describePartDbError({
        kind: "not_found",
        httpStatus: 404,
        resource: "Category",
        identifier: "Electronics/Resistors",
        retryable: false,
      }),
    ).toBe("Category 'Electronics/Resistors' not found in Part-DB");

    expect(
      describePartDbError({
        kind: "validation",
        httpStatus: 422,
        violations: [{ propertyPath: "name", message: "This value should not be blank." }],
        retryable: false,
      }),
    ).toBe("Invalid request: name: This value should not be blank.");
  });
});
