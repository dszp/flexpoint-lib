/** Errors the client throws. Kept in their own module so auth and transport can share them. */

/** An HTTP-level failure from the FlexPoint API. */
export class FlexPointApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    /** Path relative to the base URL, without the query string. */
    public readonly path: string,
    /** Parsed error body when the API sent one, else the raw text (often empty on 401/404). */
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'FlexPointApiError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * Thrown by a full-collection walk whose rows do not match the `record-count` the API reported,
 * or that saw the same id twice. Lists are newest-first and offset-paginated, so a record created
 * mid-walk shifts every later page by one; re-run rather than trust the result.
 */
export class IncompleteListError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: number,
    public readonly received: number,
    public readonly duplicates: number = 0,
  ) {
    super(
      `FlexPoint ${path}: walked ${received} rows (${duplicates} duplicate ids) but the first page reported ` +
        `record-count=${expected}. The collection changed mid-walk; re-run rather than trust a partial list.`,
    );
    this.name = 'IncompleteListError';
  }
}
