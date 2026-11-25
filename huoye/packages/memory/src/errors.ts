export class MemoryPathError extends Error {
  readonly code = "PATH_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "MemoryPathError";
  }
}

export class MemoryConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  constructor(
    message: string,
    readonly current: { revision: string; snippet: string; content: string },
    readonly incoming: { expectedRevision: string; snippet: string; content: string },
  ) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class MemoryPermissionError extends Error {
  readonly code = "FORBIDDEN";
  constructor(message: string) {
    super(message);
    this.name = "MemoryPermissionError";
  }
}

export class MemoryNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "MemoryNotFoundError";
  }
}
