export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const Ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const Err = <E>(error: E): Err<E> => ({ ok: false, error });

export function mapResult<T, U, E>(
  result: Result<T, E>,
  transform: (value: T) => U,
): Result<U, E> {
  return result.ok ? Ok(transform(result.value)) : result;
}

export async function andThenResult<T, U, E>(
  result: Result<T, E>,
  transform: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
  return result.ok ? await transform(result.value) : result;
}
