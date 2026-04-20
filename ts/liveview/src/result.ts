export type Result<T> = [success: true, value: T] | [success: false, error: Error];

export const Result = {
    ok: <T>(value: T): Result<T> => [true, value],
    err: <T>(error: Error): Result<T> => [false, error],
    map: <T, U>(result: Result<T>, fn: (value: T) => U): Result<U> => {
        if (result[0]) {
            return Result.ok(fn(result[1]));
        } else {
            return Result.err(result[1]);
        }
    },
};
